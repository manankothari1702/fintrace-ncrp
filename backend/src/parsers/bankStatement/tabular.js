'use strict';

/**
 * FinTrace Bank Statement module — shared tabular-file access.
 *
 * One row-oriented view over every wizard-eligible container: CSV, .xls and
 * .xlsx all come back as the same array-of-arrays via SheetJS (which the
 * project already ships — no new CSV dependency). SheetJS's CSV path sniffs
 * the delimiter (comma / semicolon / tab / pipe), honours RFC-style quoted
 * fields (embedded delimiters, thousands separators), and strips UTF BOMs,
 * which covers the real-world messiness of Indian bank CSV exports whose
 * files also carry a metadata preamble above the actual table.
 *
 * Also home to the GENERIC header-row heuristics used by the mapping wizard:
 * find the most header-looking row (labels, not data), suggest a canonical
 * role per label, and sniff account facts (IFSC, account number) from the
 * preamble so the wizard can pre-fill the bank name.
 *
 * @module backend/src/parsers/bankStatement/tabular
 */

const XLSX = require('xlsx');

const { resolveBank } = require('../../lib/ifscBankResolver');
const { _internals: pnbInternals } = require('./pnbExcel');
const { normalizeHeader } = pnbInternals;

/** Rows scanned when hunting for a header row / preamble facts. */
const HEADER_SCAN_DEPTH = 60;

/** Data rows returned for the wizard's preview. */
const PREVIEW_ROWS = 5;

// ─── Reading ─────────────────────────────────────────────────────────

/**
 * Read a CSV / .xls / .xlsx statement as array-of-arrays (first sheet).
 * Cells are raw (numbers stay numbers, text stays text — dates in bank CSVs
 * are text and parse downstream).
 *
 * @param {string} filePath
 * @returns {Array<Array<unknown>>}
 * @throws {Error} code 'TABULAR_UNREADABLE'
 */
function readTabularRows(filePath) {
  let wb;
  try {
    wb = XLSX.readFile(filePath, { raw: true });
  } catch (e) {
    const err = new Error(`Statement file could not be read as a table: ${e.message}`);
    err.code = 'TABULAR_UNREADABLE';
    throw err;
  }
  const first = wb.SheetNames[0];
  if (!first) return [];
  return XLSX.utils.sheet_to_json(wb.Sheets[first], {
    header: 1, raw: true, defval: null,
  });
}

// ─── Header detection (generic) ──────────────────────────────────────

/** Cell → trimmed string ('' for null). */
function cellStr(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

/** Does this cell look like a column LABEL (short text, not data)? */
function isLabelCell(s) {
  if (s === '' || s.length > 40) return false;
  if (/^-?[\d,]+(\.\d+)?$/.test(s)) return false;                 // number
  if (/^\d{1,4}[\/\-.]\d{1,2}[\/\-.]\d{1,4}$/.test(s)) return false; // date
  return true;
}

/**
 * Find the most header-looking row: within the scan window, the row with the
 * MOST label cells (≥3 required). Preamble rows are label:value pairs (1-2
 * cells) so they score low; the real header row scores one per column.
 * Ties go to the EARLIEST row (data rows full of merchant names could score
 * high, but they sit below the header).
 *
 * @param {Array<Array<unknown>>} rows
 * @returns {{ headerRow: number, headers: string[] }|null} headers are the
 *   row's trimmed labels with trailing empties dropped.
 */
function findHeaderRowGeneric(rows) {
  let best = null;
  const depth = Math.min(rows.length, HEADER_SCAN_DEPTH);
  for (let r = 0; r < depth; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const labels = row.map(cellStr);
    const score = labels.filter(isLabelCell).length;
    if (score >= 3 && (!best || score > best.score)) {
      best = { score, headerRow: r };
    }
  }
  if (!best) return null;
  const labels = rows[best.headerRow].map(cellStr);
  while (labels.length > 0 && labels[labels.length - 1] === '') labels.pop();
  return { headerRow: best.headerRow, headers: labels };
}

/**
 * First data rows under the header, for the wizard's preview pane.
 *
 * @param {Array<Array<unknown>>} rows
 * @param {number} headerRow
 * @param {number} width - number of header columns to keep.
 * @returns {Array<Array<string>>}
 */
function previewRows(rows, headerRow, width, count = PREVIEW_ROWS) {
  const out = [];
  for (let r = headerRow + 1; r < rows.length && out.length < count; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const cells = row.slice(0, width).map(cellStr);
    if (cells.every((c) => c === '')) continue;
    out.push(cells);
  }
  return out;
}

// ─── Role suggestions ────────────────────────────────────────────────

/**
 * Suggest a canonical role for each header label. Debit/credit pairs win
 * over a single amount column; 'amount' is only suggested when no split
 * pair emerged; each role is assigned at most once (first matching header
 * keeps it).
 *
 * @param {string[]} headers
 * @returns {Record<string, string>} header label → role ('ignore' when none)
 */
function suggestMapping(headers) {
  const rules = [
    ['date', /date/i],
    ['narration', /narration|particular|description|details|remark/i],
    ['debit', /withdraw|debit|\bdr\b/i],
    ['credit', /deposit|credit|\bcr\b/i],
    ['balance', /balance/i],
    ['type', /^type$|dr\s*\/\s*cr|cr\s*\/\s*dr|direction|txn\s*type/i],
    ['ref_no', /cheque|chq|ref|utr|instrument|txn\s*no/i],
    ['amount', /amount/i],
  ];
  const taken = new Set();
  const mapping = {};
  for (const h of headers) {
    let role = 'ignore';
    for (const [candidate, re] of rules) {
      if (taken.has(candidate) || !re.test(h)) continue;
      // 'amount' is the single-column fallback: skip it if this header
      // already reads as a debit/credit column ("Withdrawal Amt.").
      if (candidate === 'amount' && (mapping[h] !== undefined)) continue;
      role = candidate;
      break;
    }
    if (role !== 'ignore') taken.add(role);
    mapping[h] = role;
  }
  // A lone 'amount' next to a split pair is redundant — but a split pair
  // missing its other half plus an 'amount' header is fine; leave as-is and
  // let the officer correct in the wizard.
  return mapping;
}

// ─── Preamble facts ──────────────────────────────────────────────────

const RE_IFSC = /\b([A-Z]{4}0[A-Z0-9]{6})\b/;
const RE_ACCT_LABELLED = /(?:a\/?c|acc(?:oun)?t)[^0-9]{0,25}(\d{9,18})/i;
const RE_ACCT_BARE = /\b(\d{11,18})\b/;

/**
 * Best-effort account facts from the rows ABOVE the header (bank preambles
 * carry account number / IFSC there). Bank name is resolved from the IFSC
 * via the existing NCRP resolver when possible.
 *
 * @param {Array<Array<unknown>>} rows
 * @param {number} headerRow
 * @returns {{ ifsc: string|null, account_number: string|null, bank_name: string|null }}
 */
function sniffPreambleFacts(rows, headerRow) {
  const text = rows.slice(0, headerRow)
    .filter(Array.isArray)
    .map((row) => row.map(cellStr).filter(Boolean).join(' '))
    .join('\n');

  const ifscMatch = text.toUpperCase().match(RE_IFSC);
  const ifsc = ifscMatch ? ifscMatch[1] : null;
  const acctMatch = text.match(RE_ACCT_LABELLED) || text.match(RE_ACCT_BARE);

  let bankName = null;
  if (ifsc) {
    const resolved = resolveBank({ ifsc });
    if (resolved && resolved.source !== 'TEXT' && resolved.bank && resolved.bank !== 'Unknown') {
      bankName = resolved.bank;
    }
  }
  return {
    ifsc,
    account_number: acctMatch ? acctMatch[1] : null,
    bank_name: bankName,
  };
}

module.exports = {
  readTabularRows,
  findHeaderRowGeneric,
  previewRows,
  suggestMapping,
  sniffPreambleFacts,
  normalizeHeader,
  HEADER_SCAN_DEPTH,
};
