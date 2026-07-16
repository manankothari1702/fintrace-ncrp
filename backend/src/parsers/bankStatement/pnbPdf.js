'use strict';

/**
 * FinTrace Bank Statement module — PNB (Punjab National Bank) PDF parser.
 *
 * Reads a digital (text-based, NOT scanned) "PNB ONE" statement PDF via
 * pdfjs-dist (pure JS, no native deps, packages cleanly in Electron) and
 * normalises it to the SAME canonical shape as parsePnbExcel — the two
 * parsers are reconciled against each other in
 * scripts/bank_statement_reconcile.js / bankStatementReconciliation.test.js.
 *
 * PDF layout differs from the Excel export of the same account:
 *   • columns: Date | Instrument ID | Amount(INR) | Type | Balance | Remarks
 *   • direction is a single "Type" column ('CR'/'DR') + a single Amount
 *     column (the Excel has split Dr/Cr columns instead);
 *   • there is NO "Txn No." — Instrument ID is empty for UPI/NEFT rows, so
 *     ref_no is usually null on the PDF side;
 *   • the running Balance has no Cr./Dr. suffix → balance_type is null;
 *   • Remarks WRAP across physical lines: a transaction starts on a line
 *     whose FIRST text item is a DD/MM/YYYY date; continuation lines carry
 *     only remarks fragments, which sit at the Remarks column's x-offset.
 *
 * Row reassembly is therefore date-anchored and column-anchored, never
 * page-position-based: footer boilerplate ("***Generated through PNB ONE***",
 * the abbreviations legend, per-page "Date: … | Page N") starts at the left
 * margin (x≈36-199), far left of the Remarks column (x≈346), so it is
 * ignored wherever it appears.
 *
 * @module backend/src/parsers/bankStatement/pnbPdf
 */

const fs = require('fs');

// pdfjs-dist probes for the optional `canvas` package at require time to
// polyfill DOMMatrix/Path2D for RENDERING. We only extract text, so stub the
// two globals first — this silences the "Cannot polyfill" warnings without
// changing behaviour.
if (typeof globalThis.DOMMatrix === 'undefined') {
  globalThis.DOMMatrix = class DOMMatrix {};
}
if (typeof globalThis.Path2D === 'undefined') {
  globalThis.Path2D = class Path2D {};
}
// Legacy build: CommonJS-compatible (the modern build is ESM-only).
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');

const { _internals: ncrpInternals } = require('../ncrpParser');
const { parseDate } = ncrpInternals;

// ─── Layout constants ────────────────────────────────────────────────

/** Text items on the same visual line may jitter by a point or two. */
const LINE_Y_TOLERANCE = 2;

/**
 * Fallback left edge of the Remarks column, used only when no transaction
 * row carries any remarks text (the real anchor is derived from the leftmost
 * remarks item across the parsed rows — the header's "Remarks" label is
 * CENTERED over the column, so it cannot serve as the left edge).
 */
const REMARKS_X_FALLBACK = 340;

/** How far left of the derived remarks edge a continuation may still start. */
const REMARKS_X_SLACK = 20;

const RE_ROW_DATE = /^\d{2}\/\d{2}\/\d{4}$/;
const RE_TYPE = /^(CR|DR)$/i;
const RE_NUMERIC = /^-?[\d,]+(?:\.\d+)?$/;

// ─── Text extraction ─────────────────────────────────────────────────

/**
 * Extract the PDF's text as visual lines, in reading order across all pages.
 * Each line is the set of text items sharing (within tolerance) a baseline y,
 * sorted left-to-right.
 *
 * @param {string|Buffer} src - file path or raw PDF bytes.
 * @returns {Promise<Array<{ page: number, items: Array<{ x: number, str: string }> }>>}
 */
async function extractPdfLines(src) {
  const bytes = Buffer.isBuffer(src) ? src : fs.readFileSync(src);
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    verbosity: 0, // errors only — suppress standard-font fetch warnings
  }).promise;

  const lines = [];
  try {
    for (let pageNo = 1; pageNo <= doc.numPages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const tc = await page.getTextContent();

      /** @type {Array<{ y: number, items: Array<{ x: number, str: string }> }>} */
      const pageLines = [];
      for (const item of tc.items) {
        const str = String(item.str || '');
        if (str.trim() === '') continue;
        const x = item.transform[4];
        const y = item.transform[5];
        const line = pageLines.find((l) => Math.abs(l.y - y) <= LINE_Y_TOLERANCE);
        if (line) line.items.push({ x, str });
        else pageLines.push({ y, items: [{ x, str }] });
      }
      pageLines.sort((a, b) => b.y - a.y); // top of page first
      for (const l of pageLines) {
        l.items.sort((a, b) => a.x - b.x);
        lines.push({ page: pageNo, items: l.items });
      }
    }
  } finally {
    await doc.destroy();
  }
  return lines;
}

/** Join a line's items into plain text (single spaces between items). */
function lineText(line) {
  return line.items.map((i) => i.str.trim()).filter(Boolean).join(' ');
}

// ─── Statement metadata ──────────────────────────────────────────────

const RE_ACCOUNT_PERIOD =
  /Statement\s+of\s+Account\s*:?\s*(\d{6,})\s+For\s+Period\s*:?\s*([0-9][0-9\/.-]+)\s+to\s+([0-9][0-9\/.-]+)/i;

/**
 * Pull account-level metadata from the labeled lines above the table header.
 *
 * @param {Array<{ items: Array<{ x: number, str: string }> }>} lines
 * @param {number} headerIdx
 * @returns {{ account: object, warnings: string[] }}
 */
function extractMetadata(lines, headerIdx) {
  const account = {
    account_number: null,
    account_holder: null,
    ifsc: null,
    bank_name: 'Punjab National Bank',
    branch: null,
    statement_period_from: null,
    statement_period_to: null,
  };
  const warnings = [];

  for (let i = 0; i < headerIdx; i++) {
    const text = lineText(lines[i]);

    const acct = text.match(RE_ACCOUNT_PERIOD);
    if (acct) {
      account.account_number = acct[1];
      account.statement_period_from = parseDate(acct[2]);
      account.statement_period_to = parseDate(acct[3]);
      continue;
    }
    let m;
    if ((m = text.match(/^Branch\s+Name:\s*(.+)$/i))) account.branch = m[1].trim();
    else if ((m = text.match(/^IFSC:\s*([A-Za-z0-9]+)$/i))) account.ifsc = m[1].toUpperCase();
    else if ((m = text.match(/^Customer\s+Name:\s*(.+)$/i))) account.account_holder = m[1].trim();
  }

  if (!account.account_number) warnings.push('PNB PDF: account number not found in statement banner');
  if (!account.ifsc) warnings.push('PNB PDF: IFSC not found in branch details');
  return { account, warnings };
}

// ─── Row assembly ────────────────────────────────────────────────────

/** Parse "21,180.0" → 21180. @param {string} s @returns {number|null} */
function parseNumeric(s) {
  const n = Number(String(s).trim().replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Interpret one date-anchored line as a transaction.
 * Item roles, left to right: date | [instrument id…] | amount | CR/DR |
 * balance | remarks fragments. Amount is the LAST numeric item before the
 * Type item (so a numeric Instrument ID can never be mistaken for it);
 * balance is the FIRST numeric item after it.
 *
 * @param {{ items: Array<{ x: number, str: string }> }} line
 * @param {string} txnDate - already-parsed ISO date for item 0.
 * @param {number} sourceRow
 * @param {string[]} warnings
 * @returns {{ txn: object, remarksStartX: number|null }|null} canonical
 *   transaction plus the x of its first remarks fragment (null when the row
 *   has no remarks text), or null if the line doesn't have the
 *   amount/type/balance backbone (warned, skipped).
 */
function buildTransaction(line, txnDate, sourceRow, warnings) {
  const items = line.items;
  const typeIdx = items.findIndex((it) => RE_TYPE.test(it.str.trim()));
  if (typeIdx === -1) {
    warnings.push(`PNB PDF line ${sourceRow}: date-anchored line has no CR/DR type — skipped (${lineText(line).slice(0, 80)})`);
    return null;
  }

  let amountIdx = -1;
  for (let i = 1; i < typeIdx; i++) {
    if (RE_NUMERIC.test(items[i].str.trim())) amountIdx = i;
  }
  const balanceIdx = typeIdx + 1 < items.length && RE_NUMERIC.test(items[typeIdx + 1].str.trim())
    ? typeIdx + 1
    : -1;
  if (amountIdx === -1 || balanceIdx === -1) {
    warnings.push(`PNB PDF line ${sourceRow}: could not locate amount/balance — skipped (${lineText(line).slice(0, 80)})`);
    return null;
  }

  const amount = parseNumeric(items[amountIdx].str);
  const balance = parseNumeric(items[balanceIdx].str);
  const isCredit = items[typeIdx].str.trim().toUpperCase() === 'CR';

  const refParts = items.slice(1, amountIdx).map((it) => it.str.trim()).filter(Boolean);
  const remarkItems = items.slice(balanceIdx + 1).filter((it) => it.str.trim() !== '');
  const remarks = remarkItems.map((it) => it.str.trim()).join(' ');

  return {
    txn: {
      txn_date: txnDate,
      value_date: null, // PNB statements carry no separate value date
      narration: remarks || null,
      debit_amount: isCredit ? null : amount,
      credit_amount: isCredit ? amount : null,
      balance,
      balance_type: null, // PDF balance column has no Cr./Dr. suffix
      ref_no: refParts.length > 0 ? refParts.join(' ') : null,
      source_row: sourceRow,
    },
    remarksStartX: remarkItems.length > 0 ? remarkItems[0].x : null,
  };
}

// ─── Parser ──────────────────────────────────────────────────────────

/**
 * Parse a PNB PDF account statement into canonical transactions.
 *
 * @param {string|Buffer} src - path to the PDF, or its raw bytes.
 * @returns {Promise<{ bank: string, account: object, transactions: Array<object>, warnings: string[] }>}
 * @throws {Error} code 'PNB_PDF_UNREADABLE' | 'PNB_HEADER_NOT_FOUND' | 'PNB_NO_TRANSACTIONS'
 */
async function parsePnbPdf(src) {
  let lines;
  try {
    lines = await extractPdfLines(src);
  } catch (e) {
    const err = new Error(`PNB PDF statement could not be read: ${e.message}`);
    err.code = 'PNB_PDF_UNREADABLE';
    throw err;
  }

  // Table header: the line carrying the Date/Amount/Type/Balance/Remarks
  // labels. Its "Remarks" label x-position anchors the continuation column.
  const headerIdx = lines.findIndex((l) => {
    const text = lineText(l);
    return /\bDate\b/.test(text) && /Amount\s*\(INR\)/i.test(text) &&
           /\bType\b/.test(text) && /\bBalance\b/.test(text) && /\bRemarks\b/.test(text);
  });
  if (headerIdx === -1) {
    const err = new Error('PNB PDF statement table header (Date / Amount(INR) / Type / Balance / Remarks) not found');
    err.code = 'PNB_HEADER_NOT_FOUND';
    throw err;
  }
  const { account, warnings } = extractMetadata(lines, headerIdx);

  // Pass 1 — build every date-anchored transaction and learn where the
  // Remarks column actually starts (leftmost first-remarks-item across the
  // rows; the header's "Remarks" label is centered over the column, so it
  // would sit too far right to catch left-aligned wrapped fragments).
  const transactions = [];
  /** lineIdx → the transaction that owns fragments until the next txn line */
  const txnByLine = new Map();
  let minRemarksX = Infinity;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const first = lines[i].items[0];
    const firstStr = first.str.trim();
    if (!RE_ROW_DATE.test(firstStr)) continue;
    const txnDate = parseDate(firstStr);
    if (txnDate === null) continue;
    const built = buildTransaction(lines[i], txnDate, i, warnings);
    if (!built) continue;
    transactions.push(built.txn);
    txnByLine.set(i, built.txn);
    if (built.remarksStartX !== null && built.remarksStartX < minRemarksX) {
      minRemarksX = built.remarksStartX;
    }
  }
  const remarksX = (Number.isFinite(minRemarksX) ? minRemarksX : REMARKS_X_FALLBACK) - REMARKS_X_SLACK;

  // Pass 2 — attach wrapped Remarks continuations. A continuation is any
  // non-transaction line whose text sits entirely in the Remarks column; it
  // belongs to the most recent transaction line above it. Everything else —
  // metadata leftovers, footer boilerplate, the per-page "Date: … | Page N"
  // line, the abbreviations legend — is ignored. The filter is "doesn't
  // start with a date AND doesn't sit in the Remarks column", never page
  // position, because the boilerplate can appear mid-table.
  let current = null;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if (txnByLine.has(i)) { current = txnByLine.get(i); continue; }
    const first = lines[i].items[0];
    if (current && first.x >= remarksX) {
      const fragment = lineText(lines[i]);
      current.narration = current.narration ? `${current.narration} ${fragment}` : fragment;
    }
  }

  if (transactions.length === 0) {
    const err = new Error('PNB PDF statement contains no transaction rows');
    err.code = 'PNB_NO_TRANSACTIONS';
    throw err;
  }

  return { bank: 'PNB', account, transactions, warnings };
}

module.exports = {
  parsePnbPdf,
  extractPdfLines,
  // Exposed for unit tests; not part of the public contract.
  _internals: Object.freeze({ buildTransaction, extractMetadata, lineText, parseNumeric }),
};
