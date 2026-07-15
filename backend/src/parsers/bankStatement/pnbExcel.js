'use strict';

/**
 * FinTrace Bank Statement module — PNB (Punjab National Bank) Excel parser.
 *
 * Reads a "PNB ONE" account-statement export (.xls, old BIFF format — SheetJS
 * reads it natively) and normalises it to the canonical bank-statement
 * transaction shape shared with the PDF parser (see parsePnbPdf):
 *
 *   {
 *     bank: 'PNB',
 *     account: { account_number, account_holder, ifsc, bank_name, branch,
 *                statement_period_from, statement_period_to },
 *     transactions: [{ txn_date, value_date, narration, debit_amount,
 *                      credit_amount, balance, balance_type, ref_no,
 *                      source_row }],
 *     warnings: [...],
 *   }
 *
 * Real file layout (fixture pnb_statement.xls, account …6079):
 *   rows 0-18   metadata (branch block, customer block, statement period)
 *   row  19     header: Txn No. | Txn Date | Description | (blank) |
 *               Branch Name | Cheque No. | Dr Amount | Cr Amount | Balance
 *   rows 20+    data (reverse-chronological), then blank rows + footer
 *               boilerplate ("***Generated through PNB ONE***", legend).
 *
 * The header row is FOUND by matching header labels ("Txn Date",
 * "Description", "Dr Amount"…), never hardcoded, so minor layout shifts in
 * the metadata block don't break parsing. Data rows are accepted only when
 * the Txn Date cell parses as a real date — blank separator rows and the
 * footer legend fail that gate and are skipped.
 *
 * Dr Amount / Cr Amount are SEPARATE columns (exactly one populated per row),
 * so direction is explicit. Balance carries a "Cr." / "Dr." suffix which is
 * split into `balance` (number) + `balance_type` ('Cr'|'Dr').
 *
 * @module backend/src/parsers/bankStatement/pnbExcel
 */

const XLSX = require('xlsx');

// Reuse the NCRP date parser (DD/MM/YYYY & DD-MM-YYYY → ISO-8601 UTC,
// Indian-convention default). Exposed by ncrpParser for advanced callers.
const { _internals: ncrpInternals } = require('../ncrpParser');
const { parseDate } = ncrpInternals;

// ─── Header detection ────────────────────────────────────────────────

/** Rows scanned for the header (PNB puts it around row 19; allow drift). */
const HEADER_SCAN_DEPTH = 40;

/**
 * Canonical column key → normalised header label(s) accepted for it.
 * Normalisation strips everything but [a-z0-9] so "Txn No." ≡ "txnno".
 */
const COLUMN_LABELS = Object.freeze({
  ref_no: ['txnno'],
  txn_date: ['txndate'],
  narration: ['description'],
  branch_name: ['branchname'],
  cheque_no: ['chequeno'],
  debit_amount: ['dramount', 'debitamount'],
  credit_amount: ['cramount', 'creditamount'],
  balance: ['balance'],
});

/** Columns that MUST resolve for a row of cells to be accepted as the header. */
const REQUIRED_COLUMNS = Object.freeze(['txn_date', 'narration', 'debit_amount', 'credit_amount']);

/** @param {unknown} v @returns {string} lowercase alphanumerics only */
function normalizeHeader(v) {
  return String(v === null || v === undefined ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Locate the header row and build the column-index map.
 *
 * @param {Array<Array<unknown>>} rows - sheet as array-of-arrays.
 * @returns {{ headerRow: number, columns: Record<string, number> }|null}
 */
function findHeaderRow(rows) {
  const labelToKey = new Map();
  for (const [key, labels] of Object.entries(COLUMN_LABELS)) {
    for (const label of labels) labelToKey.set(label, key);
  }
  const depth = Math.min(rows.length, HEADER_SCAN_DEPTH);
  for (let r = 0; r < depth; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const columns = {};
    for (let c = 0; c < row.length; c++) {
      const key = labelToKey.get(normalizeHeader(row[c]));
      if (key && columns[key] === undefined) columns[key] = c;
    }
    if (REQUIRED_COLUMNS.every((k) => columns[k] !== undefined)) {
      return { headerRow: r, columns };
    }
  }
  return null;
}

// ─── Cell parsing ────────────────────────────────────────────────────

/**
 * Parse an amount cell (number, or string like "21,180.0"). Blank → null.
 *
 * @param {unknown} v
 * @returns {number|null}
 */
function parseAmount(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/[,\s ]/g, '');
  if (s === '' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a PNB balance cell — "2274.95 Cr." → { balance: 2274.95, type: 'Cr' }.
 * A plain number (no suffix) yields type null.
 *
 * @param {unknown} v
 * @returns {{ balance: number|null, type: ('Cr'|'Dr'|null) }}
 */
function parseBalance(v) {
  if (v === null || v === undefined) return { balance: null, type: null };
  if (typeof v === 'number') {
    return { balance: Number.isFinite(v) ? v : null, type: null };
  }
  const m = String(v).trim().match(/^(-?[\d,]+(?:\.\d+)?)\s*(Cr|Dr)?\.?$/i);
  if (!m) return { balance: null, type: null };
  const n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return { balance: null, type: null };
  const type = m[2] ? (m[2].toLowerCase() === 'cr' ? 'Cr' : 'Dr') : null;
  return { balance: n, type };
}

/** @param {unknown} v @returns {string|null} trimmed string or null */
function cellText(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

// ─── Statement metadata ──────────────────────────────────────────────

const RE_ACCOUNT_NUMBER = /Account\s+Statement\s+for\s+Account\s+Number\s*:?\s*(\d{6,})/i;
const RE_PERIOD = /Statement\s+Period\s*:?\s*([0-9][0-9\/.-]+)\s+to\s+([0-9][0-9\/.-]+)/i;

/**
 * Extract account-level metadata from the rows ABOVE the header. Labeled
 * rows put the label in column 0 ("IFSC:") and the value in column 1; the
 * account number and period are embedded in single banner cells.
 *
 * @param {Array<Array<unknown>>} rows
 * @param {number} headerRow
 * @returns {{ account: object, warnings: string[] }}
 */
function extractMetadata(rows, headerRow) {
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
  let inCustomerBlock = false;

  for (let r = 0; r < headerRow; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    const first = cellText(row[0]);
    if (!first) continue;

    const acctMatch = first.match(RE_ACCOUNT_NUMBER);
    if (acctMatch) { account.account_number = acctMatch[1]; continue; }

    const periodMatch = first.match(RE_PERIOD);
    if (periodMatch) {
      account.statement_period_from = parseDate(periodMatch[1]);
      account.statement_period_to = parseDate(periodMatch[2]);
      continue;
    }

    if (/^Customer\s+Details$/i.test(first)) { inCustomerBlock = true; continue; }
    if (/^Branch\s+Details$/i.test(first)) { inCustomerBlock = false; continue; }

    const label = normalizeHeader(first);
    const value = cellText(row[1]);
    if (label === 'branchname' && !inCustomerBlock) account.branch = value;
    else if (label === 'ifsc') account.ifsc = value ? value.toUpperCase() : null;
    else if (label === 'customername') account.account_holder = value;
  }

  if (!account.account_number) warnings.push('PNB Excel: account number not found in statement banner');
  if (!account.ifsc) warnings.push('PNB Excel: IFSC not found in branch details');
  return { account, warnings };
}

// ─── Parser ──────────────────────────────────────────────────────────

/**
 * Parse a PNB Excel account statement into canonical transactions.
 *
 * @param {string} filePath - path to the .xls/.xlsx file.
 * @returns {{ bank: string, account: object, transactions: Array<object>, warnings: string[] }}
 * @throws {Error} code 'PNB_EXCEL_UNREADABLE' | 'PNB_HEADER_NOT_FOUND' | 'PNB_NO_TRANSACTIONS'
 */
function parsePnbExcel(filePath) {
  let wb;
  try {
    wb = XLSX.readFile(filePath, { raw: true });
  } catch (e) {
    const err = new Error(`PNB Excel statement could not be read: ${e.message}`);
    err.code = 'PNB_EXCEL_UNREADABLE';
    throw err;
  }

  const sheetName = wb.SheetNames[0];
  const ws = sheetName ? wb.Sheets[sheetName] : null;
  const rows = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null }) : [];

  const header = findHeaderRow(rows);
  if (!header) {
    const err = new Error('PNB statement header row (Txn Date / Description / Dr Amount / Cr Amount) not found');
    err.code = 'PNB_HEADER_NOT_FOUND';
    throw err;
  }
  const { headerRow, columns } = header;

  const { account, warnings } = extractMetadata(rows, headerRow);

  const transactions = [];
  for (let r = headerRow + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;

    // Date gate: blank separator rows and the footer legend have no valid
    // date in the Txn Date column, so they are skipped — never position-based.
    const txnDate = parseDate(row[columns.txn_date]);
    if (!txnDate) continue;

    const debit = parseAmount(row[columns.debit_amount]);
    const credit = parseAmount(row[columns.credit_amount]);
    const { balance, type: balanceType } = parseBalance(row[columns.balance]);

    if (debit === null && credit === null) {
      warnings.push(`PNB Excel row ${r}: neither Dr nor Cr amount present — row kept with null amounts`);
    } else if (debit !== null && credit !== null) {
      warnings.push(`PNB Excel row ${r}: BOTH Dr and Cr amounts present — check source file`);
    }
    if (balance === null) {
      warnings.push(`PNB Excel row ${r}: balance cell unparseable (${JSON.stringify(row[columns.balance])})`);
    }

    transactions.push({
      txn_date: txnDate,
      value_date: null, // PNB statements carry no separate value date
      narration: cellText(row[columns.narration]),
      debit_amount: debit,
      credit_amount: credit,
      balance,
      balance_type: balanceType,
      ref_no: columns.ref_no !== undefined ? cellText(row[columns.ref_no]) : null,
      source_row: r,
    });
  }

  if (transactions.length === 0) {
    const err = new Error('PNB statement contains no transaction rows');
    err.code = 'PNB_NO_TRANSACTIONS';
    throw err;
  }

  return { bank: 'PNB', account, transactions, warnings };
}

module.exports = {
  parsePnbExcel,
  // Exposed for unit tests; not part of the public contract.
  _internals: Object.freeze({
    findHeaderRow, parseAmount, parseBalance, extractMetadata, normalizeHeader,
  }),
};
