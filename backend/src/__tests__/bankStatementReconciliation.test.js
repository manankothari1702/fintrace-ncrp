'use strict';

/**
 * Cross-format reconciliation — THE accuracy anchor for bank-statement
 * ingestion (analogous to the NCRP gold-standard tests).
 *
 * pnb_statement.xls and pnb_statement.pdf are the SAME account
 * (4563000100036079) over the SAME period exported in the two formats, so
 * both parsers must produce identical transactions. Verified result for
 * these fixtures: Excel 96 / PDF 96, 96 hard-field matched, 0 mismatched,
 * 96/96 narrations equal after whitespace normalisation.
 */

const path = require('path');

const { parsePnbExcel } = require('../parsers/bankStatement/pnbExcel');
const { parsePnbPdf } = require('../parsers/bankStatement/pnbPdf');
const { reconcileStatements, normalizeNarration } = require('../parsers/bankStatement/reconcile');

const FIXTURES = path.join(__dirname, 'fixtures');

describe('PNB Excel ⇄ PDF reconciliation (same account, both formats)', () => {
  let excel, pdf, r;
  beforeAll(async () => {
    excel = parsePnbExcel(path.join(FIXTURES, 'pnb_statement.xls'));
    pdf = await parsePnbPdf(path.join(FIXTURES, 'pnb_statement.pdf'));
    r = reconcileStatements(excel, pdf);
  });

  test('both formats yield the same transaction count (96)', () => {
    expect(r.excelCount).toBe(96);
    expect(r.pdfCount).toBe(96);
  });

  test('all 96 transactions match on date, direction, amount, and balance', () => {
    expect(r.mismatches).toEqual([]);
    expect(r.matched).toBe(96);
    expect(r.ok).toBe(true);
  });

  test('all 96 narrations agree (whitespace-insensitive — PDF wrap points lose spaces)', () => {
    expect(r.narrationMismatches).toEqual([]);
    expect(r.narrationMatched).toBe(96);
  });

  test('account metadata agrees across formats', () => {
    expect(r.accountMismatches).toEqual([]);
    expect(excel.account.account_number).toBe(pdf.account.account_number);
    expect(excel.account.ifsc).toBe(pdf.account.ifsc);
  });

  test('running balances line up row-for-row (strongest ordering check)', () => {
    for (let i = 0; i < 96; i++) {
      expect(pdf.transactions[i].balance).toBeCloseTo(excel.transactions[i].balance, 2);
    }
  });
});

describe('reconcileStatements unit behaviour', () => {
  const txn = (over = {}) => ({
    txn_date: '2026-06-15T00:00:00.000Z', value_date: null, narration: 'UPI/DR/1/x',
    debit_amount: 100, credit_amount: null, balance: 900, balance_type: null,
    ref_no: null, source_row: 1, ...over,
  });
  const stmt = (txns) => ({ account: { account_number: '1', ifsc: 'PUNB0000100' }, transactions: txns });

  test('flags an amount disagreement as a hard mismatch', () => {
    const r = reconcileStatements(stmt([txn()]), stmt([txn({ debit_amount: 101 })]));
    expect(r.ok).toBe(false);
    expect(r.mismatches).toEqual([{ index: 0, field: 'amount', excel: 100, pdf: 101 }]);
  });

  test('flags a direction flip (Dr vs Cr) even when the amount is equal', () => {
    const r = reconcileStatements(
      stmt([txn()]),
      stmt([txn({ debit_amount: null, credit_amount: 100 })]),
    );
    expect(r.mismatches).toEqual([{ index: 0, field: 'direction', excel: 'debit', pdf: 'credit' }]);
  });

  test('a count difference fails reconciliation even if the overlap matches', () => {
    const r = reconcileStatements(stmt([txn(), txn()]), stmt([txn()]));
    expect(r.ok).toBe(false);
    expect(r.matched).toBe(1);
  });

  test('narration comparison ignores whitespace but nothing else', () => {
    expect(normalizeNarration('NEFT_IN:x// HDFC Y')).toBe(normalizeNarration('NEFT_IN:x//HDFCY'));
    expect(normalizeNarration('abc')).not.toBe(normalizeNarration('abd'));
  });
});
