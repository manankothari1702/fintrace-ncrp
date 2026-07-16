'use strict';

/**
 * FinTrace Bank Statement module — generic mapping-driven parser.
 *
 * Parses ANY CSV/Excel statement into the canonical transaction shape using
 * a user-confirmed (or template-saved) column mapping, instead of a
 * hand-written per-bank parser. This is the "cover 20 banks without 20
 * parsers" path: the wizard produces a mapping once, it is saved as a
 * bank template, and the same layout auto-detects from then on.
 *
 * ── Mapping representation (stored as JSON on bank_templates.mapping) ──
 *
 *   {
 *     version: 1,
 *     columns: { "<source header label>": <role> },
 *     options: {
 *       dateFormat:  'auto' | 'DMY' | 'MDY' | 'YMD',   // default 'auto'
 *       debitValues:  ['DR', ...],   // type-column tokens meaning debit
 *       creditValues: ['CR', ...],   // type-column tokens meaning credit
 *       balanceSuffix: 'auto'        // 'auto' | true | false
 *     }
 *   }
 *
 * Roles: date | narration | debit | credit | amount | type | balance |
 * ref_no | ignore. The two real-world direction shapes are both encoded:
 *
 *   • SPLIT   — 'debit' and/or 'credit' columns (PNB-Excel style; exactly
 *               one populated per row gives the direction).
 *   • SINGLE  — one 'amount' column; direction comes from a 'type' column
 *               (matched against debitValues/creditValues, case-insensitive)
 *               or, when no type column is mapped, from the amount's sign
 *               (negative → debit).
 *
 * balanceSuffix 'auto' strips a trailing "Cr."/"Dr." when present and
 * captures it as balance_type (exactly the PNB Excel behaviour); false
 * forces plain-number parsing; true requires the suffix.
 *
 * The header row is FOUND by locating the row containing every mapped
 * source header (same label-matching philosophy as the PNB Excel parser —
 * never a hardcoded row index), so preamble length can change freely.
 *
 * @module backend/src/parsers/bankStatement/genericMapped
 */

const { _internals: ncrpInternals } = require('../ncrpParser');
const { parseDate } = ncrpInternals;
const { _internals: pnbInternals } = require('./pnbExcel');
const { parseAmount, parseBalance, normalizeHeader } = pnbInternals;
const { readTabularRows, sniffPreambleFacts, HEADER_SCAN_DEPTH } = require('./tabular');

/** Canonical roles a source column may map to. */
const ROLES = Object.freeze([
  'date', 'narration', 'debit', 'credit', 'amount', 'type', 'balance', 'ref_no', 'ignore',
]);
/** Roles that may appear at most once. */
const UNIQUE_ROLES = Object.freeze(ROLES.filter((r) => r !== 'ignore'));

const DEFAULT_DEBIT_VALUES = Object.freeze(['DR', 'DEBIT', 'D', 'WITHDRAWAL']);
const DEFAULT_CREDIT_VALUES = Object.freeze(['CR', 'CREDIT', 'C', 'DEPOSIT']);
const DATE_FORMATS = Object.freeze(['auto', 'DMY', 'MDY', 'YMD']);

/** Balance-continuity tolerance (paise-exact statements; allow rounding). */
const CONTINUITY_EPSILON = 0.011;
/** Cap on per-row continuity warnings so a wrong mapping doesn't flood. */
const MAX_CONTINUITY_WARNINGS = 10;

// ─── Mapping validation ──────────────────────────────────────────────

/**
 * Validate a mapping object's structure. Throws with code
 * 'INVALID_MAPPING' and a human message on any violation.
 *
 * @param {object} mapping
 * @returns {{ columns: Record<string,string>, options: object }} normalised copy
 */
function validateMapping(mapping) {
  const fail = (msg) => {
    const err = new Error(`Invalid column mapping: ${msg}`);
    err.code = 'INVALID_MAPPING';
    throw err;
  };
  if (!mapping || typeof mapping !== 'object') fail('mapping must be an object');
  const columns = mapping.columns;
  if (!columns || typeof columns !== 'object' || Array.isArray(columns)) {
    fail('columns must be an object of { "header": "role" }');
  }

  const roleCount = new Map();
  for (const [header, role] of Object.entries(columns)) {
    if (typeof header !== 'string' || header.trim() === '') fail('empty source header');
    if (!ROLES.includes(role)) fail(`unknown role "${role}" for column "${header}"`);
    roleCount.set(role, (roleCount.get(role) || 0) + 1);
  }
  for (const role of UNIQUE_ROLES) {
    if ((roleCount.get(role) || 0) > 1) fail(`role "${role}" is mapped to more than one column`);
  }
  if (!roleCount.get('date')) fail('a "date" column is required');

  const hasSplit = roleCount.get('debit') || roleCount.get('credit');
  const hasSingle = roleCount.get('amount');
  if (!hasSplit && !hasSingle) fail('map either debit/credit columns or a single amount column');
  if (hasSplit && hasSingle) fail('map EITHER debit/credit columns OR a single amount column, not both');
  if (roleCount.get('type') && !hasSingle) fail('a "type" column only applies with a single amount column');

  const rawOpts = mapping.options && typeof mapping.options === 'object' ? mapping.options : {};
  const dateFormat = rawOpts.dateFormat === undefined ? 'auto' : rawOpts.dateFormat;
  if (!DATE_FORMATS.includes(dateFormat)) fail(`dateFormat must be one of ${DATE_FORMATS.join(', ')}`);
  const toTokenList = (v, fallback) => {
    if (v === undefined || v === null) return [...fallback];
    if (!Array.isArray(v) || v.some((t) => typeof t !== 'string' || t.trim() === '')) {
      fail('debitValues/creditValues must be arrays of non-empty strings');
    }
    return v.map((t) => t.trim().toUpperCase());
  };
  const options = {
    dateFormat,
    debitValues: toTokenList(rawOpts.debitValues, DEFAULT_DEBIT_VALUES),
    creditValues: toTokenList(rawOpts.creditValues, DEFAULT_CREDIT_VALUES),
    balanceSuffix: rawOpts.balanceSuffix === undefined ? 'auto' : rawOpts.balanceSuffix,
  };
  if (![true, false, 'auto'].includes(options.balanceSuffix)) {
    fail("balanceSuffix must be true, false or 'auto'");
  }
  return { columns: { ...columns }, options };
}

// ─── Cell interpreters ───────────────────────────────────────────────

/**
 * Parse a date cell honouring the mapping's dateFormat hint. 'auto' and
 * 'DMY' defer to the shared parseDate (whose ambiguous default IS
 * day-first, the Indian convention); 'MDY'/'YMD' reorder the components
 * explicitly for exports that don't follow it.
 *
 * @param {unknown} value
 * @param {'auto'|'DMY'|'MDY'|'YMD'} format
 * @returns {string|null} ISO-8601 UTC or null
 */
function parseDateWithFormat(value, format) {
  if (format === 'auto' || format === 'DMY') return parseDate(value);
  const s = value === null || value === undefined ? '' : String(value).trim();
  const m = s.match(/^(\d{1,4})[\/\-.](\d{1,2})[\/\-.](\d{1,4})(?:[T\s].*)?$/);
  if (!m) return parseDate(value);
  const [a, b, c] = [m[1], m[2], m[3]];
  // Rebuild as unambiguous YYYY-MM-DD and let parseDate finish (range checks).
  if (format === 'YMD') return parseDate(`${a.padStart(4, '0')}-${b}-${c}`);
  // MDY: month first; keep 2-digit years on the same 70-pivot parseDate uses.
  const year = c.length >= 4 ? c : String(Number(c) < 70 ? 2000 + Number(c) : 1900 + Number(c));
  return parseDate(`${year.padStart(4, '0')}-${a}-${b}`);
}

/**
 * Parse a balance cell under the mapping's balanceSuffix option.
 *
 * @param {unknown} value
 * @param {true|false|'auto'} suffixOpt
 * @returns {{ balance: number|null, type: ('Cr'|'Dr'|null) }}
 */
function parseBalanceWithOption(value, suffixOpt) {
  if (suffixOpt === false) return { balance: parseAmount(value), type: null };
  const parsed = parseBalance(value); // handles both plain and suffixed
  if (suffixOpt === true && parsed.balance !== null && parsed.type === null) {
    return { balance: null, type: null }; // suffix demanded but absent
  }
  return parsed;
}

// ─── Parsing ─────────────────────────────────────────────────────────

/**
 * Locate the header row: the first row (within the scan window) whose
 * normalised cells contain EVERY mapped source header.
 *
 * @param {Array<Array<unknown>>} rows
 * @param {string[]} sourceHeaders - mapped header labels.
 * @returns {{ headerRow: number, index: Map<string, number> }|null} map of
 *   header label → column index.
 */
function locateMappedHeader(rows, sourceHeaders) {
  const wanted = sourceHeaders.map((h) => ({ label: h, norm: normalizeHeader(h) }));
  const depth = Math.min(rows.length, HEADER_SCAN_DEPTH);
  for (let r = 0; r < depth; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const norms = row.map((c) => normalizeHeader(c));
    const index = new Map();
    let ok = true;
    for (const w of wanted) {
      const col = norms.indexOf(w.norm);
      if (col === -1 || w.norm === '') { ok = false; break; }
      index.set(w.label, col);
    }
    if (ok) return { headerRow: r, index };
  }
  return null;
}

/**
 * Parse a statement file (CSV / .xls / .xlsx) with a column mapping into the
 * SAME canonical result shape the PNB parsers produce.
 *
 * @param {string|Array<Array<unknown>>} src - file path, or pre-read rows.
 * @param {object} rawMapping - see module doc.
 * @param {{ bankName?: string }} [opts]
 * @returns {{ bank: string|null, account: object, transactions: Array<object>, warnings: string[] }}
 * @throws {Error} code 'INVALID_MAPPING' | 'MAPPED_HEADER_NOT_FOUND' | 'NO_TRANSACTIONS' | 'TABULAR_UNREADABLE'
 */
function parseWithMapping(src, rawMapping, opts = {}) {
  const { columns, options } = validateMapping(rawMapping);
  const rows = Array.isArray(src) ? src : readTabularRows(src);

  const roleFor = new Map(Object.entries(columns).filter(([, role]) => role !== 'ignore'));
  const located = locateMappedHeader(rows, [...roleFor.keys()]);
  if (!located) {
    const err = new Error('No row contains all the mapped column headers — wrong file or wrong mapping.');
    err.code = 'MAPPED_HEADER_NOT_FOUND';
    throw err;
  }
  const { headerRow, index } = located;

  /** column index for a role, or -1. */
  const colOf = (role) => {
    for (const [header, r] of roleFor.entries()) {
      if (r === role) return index.get(header);
    }
    return -1;
  };
  const cDate = colOf('date');
  const cNarration = colOf('narration');
  const cDebit = colOf('debit');
  const cCredit = colOf('credit');
  const cAmount = colOf('amount');
  const cType = colOf('type');
  const cBalance = colOf('balance');
  const cRef = colOf('ref_no');
  const singleMode = cAmount !== -1;

  const warnings = [];
  const transactions = [];
  const debitTokens = new Set(options.debitValues);
  const creditTokens = new Set(options.creditValues);

  const text = (v) => {
    const s = v === null || v === undefined ? '' : String(v).trim();
    return s === '' ? null : s;
  };

  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;

    // Date gate (same philosophy as the PNB parsers): footer text, blank
    // separators and repeated preamble never parse as a date → skipped.
    const txnDate = parseDateWithFormat(row[cDate], options.dateFormat);
    if (!txnDate) continue;

    let debit = null;
    let credit = null;
    if (singleMode) {
      const amount = parseAmount(row[cAmount]);
      if (amount === null) {
        warnings.push(`Row ${r}: amount cell is empty/unparseable — row kept with null amounts`);
      } else if (cType !== -1) {
        const token = (text(row[cType]) || '').toUpperCase();
        if (debitTokens.has(token)) debit = Math.abs(amount);
        else if (creditTokens.has(token)) credit = Math.abs(amount);
        else warnings.push(`Row ${r}: type value ${JSON.stringify(text(row[cType]))} matches neither debit nor credit tokens — row kept with null amounts`);
      } else {
        // No type column: the amount's sign is the direction.
        if (amount < 0) debit = Math.abs(amount);
        else credit = amount;
      }
    } else {
      debit = cDebit !== -1 ? parseAmount(row[cDebit]) : null;
      credit = cCredit !== -1 ? parseAmount(row[cCredit]) : null;
      if (debit === null && credit === null) {
        warnings.push(`Row ${r}: neither debit nor credit present — row kept with null amounts`);
      } else if (debit !== null && credit !== null) {
        warnings.push(`Row ${r}: BOTH debit and credit present — check the mapping`);
      }
    }

    let balance = null;
    let balanceType = null;
    if (cBalance !== -1) {
      const parsed = parseBalanceWithOption(row[cBalance], options.balanceSuffix);
      balance = parsed.balance;
      balanceType = parsed.type;
      if (balance === null && text(row[cBalance]) !== null) {
        warnings.push(`Row ${r}: balance cell unparseable (${JSON.stringify(text(row[cBalance]))})`);
      }
    }

    transactions.push({
      txn_date: txnDate,
      value_date: null,
      narration: cNarration !== -1 ? text(row[cNarration]) : null,
      debit_amount: debit,
      credit_amount: credit,
      balance,
      balance_type: balanceType,
      ref_no: cRef !== -1 ? text(row[cRef]) : null,
      source_row: r,
    });
  }

  if (transactions.length === 0) {
    const err = new Error('No transaction rows found under the mapped header — check the date column mapping.');
    err.code = 'NO_TRANSACTIONS';
    throw err;
  }

  // Account facts: preamble sniff + statement period from the data itself.
  const facts = sniffPreambleFacts(rows, headerRow);
  const dates = transactions.map((t) => t.txn_date).sort();
  const account = {
    account_number: facts.account_number,
    account_holder: null,
    ifsc: facts.ifsc,
    bank_name: opts.bankName || facts.bank_name || null,
    branch: null,
    statement_period_from: dates[0],
    statement_period_to: dates[dates.length - 1],
  };

  return { bank: account.bank_name, account, transactions, warnings };
}

// ─── Running-balance continuity ──────────────────────────────────────

/**
 * Sanity-check a mapped parse without a second format to reconcile against:
 * does each row's balance equal the neighbouring row's balance ± the row's
 * amount? Statements come both oldest-first and newest-first, so both
 * directions are evaluated and the better-fitting one is reported. Breaks
 * are WARNINGS (parse-quality signal for the investigator), never failures.
 *
 * @param {Array<object>} transactions - canonical rows in file order.
 * @returns {{ checked: boolean, direction: ('oldest-first'|'newest-first'|null),
 *   breakCount: number, warnings: string[] }}
 */
function validateBalanceContinuity(transactions) {
  const rows = transactions.filter((t) => t.balance !== null && t.balance !== undefined);
  if (rows.length < 2) {
    return { checked: false, direction: null, breakCount: 0, warnings: [] };
  }

  const net = (t) => (t.credit_amount || 0) - (t.debit_amount || 0);
  const breaksFor = (chronological) => {
    const breaks = [];
    for (let i = 1; i < rows.length; i++) {
      // oldest-first: balance[i] = balance[i-1] + net[i]
      // newest-first: balance[i] = balance[i-1] - net[i-1]
      const expected = chronological
        ? rows[i - 1].balance + net(rows[i])
        : rows[i - 1].balance - net(rows[i - 1]);
      if (Math.abs(rows[i].balance - expected) > CONTINUITY_EPSILON) {
        breaks.push({ row: rows[i].source_row, expected, actual: rows[i].balance });
      }
    }
    return breaks;
  };

  const oldestFirst = breaksFor(true);
  const newestFirst = breaksFor(false);
  const chronological = oldestFirst.length <= newestFirst.length;
  const breaks = chronological ? oldestFirst : newestFirst;
  const direction = chronological ? 'oldest-first' : 'newest-first';

  const warnings = breaks.slice(0, MAX_CONTINUITY_WARNINGS).map((b) =>
    `Balance continuity break at source row ${b.row}: balance ${b.actual} but ` +
    `previous balance ± amount gives ${Math.round(b.expected * 100) / 100} — ` +
    'check the amount/balance column mapping');
  if (breaks.length > MAX_CONTINUITY_WARNINGS) {
    warnings.push(`…and ${breaks.length - MAX_CONTINUITY_WARNINGS} more continuity breaks`);
  }
  if (breaks.length === 0) {
    // Positive signal: the mapping reproduces the running balance exactly.
    warnings.push(`Balance continuity verified: ${rows.length} rows reconcile (${direction})`);
  }

  return { checked: true, direction, breakCount: breaks.length, warnings };
}

module.exports = {
  parseWithMapping,
  validateMapping,
  validateBalanceContinuity,
  ROLES,
  // Exposed for unit tests; not part of the public contract.
  _internals: Object.freeze({
    parseDateWithFormat, parseBalanceWithOption, locateMappedHeader,
  }),
};
