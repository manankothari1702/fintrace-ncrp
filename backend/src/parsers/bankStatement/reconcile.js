'use strict';

/**
 * FinTrace Bank Statement module — cross-format reconciliation.
 *
 * The accuracy anchor for bank-statement ingestion (analogous to the NCRP
 * gold-standard tests): the same account's statement parsed from Excel and
 * from PDF MUST yield the same transactions. Any disagreement means a parser
 * bug, never a data difference.
 *
 * Transactions are compared positionally — both PNB exports list the same
 * period in the same (reverse-chronological) order — on the hard fields:
 *   txn_date, direction (debit vs credit side), amount, balance.
 *
 * Narration is compared separately as a SOFT check: the PDF wraps remarks
 * across physical lines and the wrap point swallows whether a space was
 * present ("…0240//" + "HDFCH…" vs Excel's "…0240//HDFCH…"), so narrations
 * are compared with ALL whitespace stripped. balance_type and ref_no are NOT
 * reconciled — the PDF format simply doesn't carry them (no Cr./Dr. suffix,
 * no Txn No. column); that's a format difference, not a parser bug.
 *
 * @module backend/src/parsers/bankStatement/reconcile
 */

/** Amount/balance tolerance (both formats print exact paise; keep it tight). */
const EPSILON = 0.005;

/** @param {unknown} s @returns {string} narration with all whitespace removed */
function normalizeNarration(s) {
  return String(s === null || s === undefined ? '' : s).replace(/\s+/g, '');
}

/** @param {object} t @returns {'debit'|'credit'|'none'} which side carries the amount */
function direction(t) {
  if (t.debit_amount !== null && t.debit_amount !== undefined) return 'debit';
  if (t.credit_amount !== null && t.credit_amount !== undefined) return 'credit';
  return 'none';
}

/** @param {object} t @returns {number|null} the populated amount */
function amountOf(t) {
  return t.debit_amount !== null && t.debit_amount !== undefined ? t.debit_amount : t.credit_amount;
}

/** @param {number|null} a @param {number|null} b */
function numbersEqual(a, b) {
  if (a === null || b === null) return a === b;
  return Math.abs(a - b) <= EPSILON;
}

/**
 * Reconcile two parsed statements (canonical parser output shape).
 *
 * @param {{ account: object, transactions: Array<object> }} excel
 * @param {{ account: object, transactions: Array<object> }} pdf
 * @returns {{
 *   excelCount: number, pdfCount: number, compared: number,
 *   matched: number,
 *   mismatches: Array<{ index: number, field: string, excel: unknown, pdf: unknown }>,
 *   narrationMatched: number,
 *   narrationMismatches: Array<{ index: number, excel: string|null, pdf: string|null }>,
 *   accountMismatches: Array<{ field: string, excel: unknown, pdf: unknown }>,
 *   ok: boolean,
 * }}
 */
function reconcileStatements(excel, pdf) {
  const et = excel.transactions;
  const pt = pdf.transactions;
  const compared = Math.min(et.length, pt.length);

  const mismatches = [];
  const narrationMismatches = [];
  let matched = 0;
  let narrationMatched = 0;

  for (let i = 0; i < compared; i++) {
    const a = et[i];
    const b = pt[i];
    const rowMismatches = [];

    if (a.txn_date !== b.txn_date) {
      rowMismatches.push({ index: i, field: 'txn_date', excel: a.txn_date, pdf: b.txn_date });
    }
    if (direction(a) !== direction(b)) {
      rowMismatches.push({ index: i, field: 'direction', excel: direction(a), pdf: direction(b) });
    } else if (!numbersEqual(amountOf(a), amountOf(b))) {
      rowMismatches.push({ index: i, field: 'amount', excel: amountOf(a), pdf: amountOf(b) });
    }
    if (!numbersEqual(a.balance, b.balance)) {
      rowMismatches.push({ index: i, field: 'balance', excel: a.balance, pdf: b.balance });
    }

    if (rowMismatches.length === 0) matched++;
    else mismatches.push(...rowMismatches);

    if (normalizeNarration(a.narration) === normalizeNarration(b.narration)) narrationMatched++;
    else narrationMismatches.push({ index: i, excel: a.narration, pdf: b.narration });
  }

  const accountMismatches = [];
  for (const field of ['account_number', 'ifsc', 'statement_period_from', 'statement_period_to']) {
    const av = excel.account ? excel.account[field] : null;
    const bv = pdf.account ? pdf.account[field] : null;
    if (av !== bv) accountMismatches.push({ field, excel: av, pdf: bv });
  }

  return {
    excelCount: et.length,
    pdfCount: pt.length,
    compared,
    matched,
    mismatches,
    narrationMatched,
    narrationMismatches,
    accountMismatches,
    ok: et.length === pt.length && mismatches.length === 0 && accountMismatches.length === 0,
  };
}

module.exports = { reconcileStatements, normalizeNarration };
