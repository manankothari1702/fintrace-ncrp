'use strict';

/**
 * PNB Excel statement parser — verified against the real fixture
 * pnb_statement.xls (account 4563000100036079, ABHISHEK BHARDWAJ,
 * period 02-06-2026 → 02-07-2026, 96 transactions: 85 debits ₹50,196.00 +
 * 11 credits ₹43,852.00). These figures are the Excel half of the
 * cross-format reconciliation anchor (see bankStatementReconciliation.test.js).
 */

const path = require('path');
const XLSX = require('xlsx');

const { parsePnbExcel, _internals } = require('../parsers/bankStatement/pnbExcel');

const FIXTURE = path.join(__dirname, 'fixtures', 'pnb_statement.xls');

describe('parsePnbExcel — real PNB fixture', () => {
  let result;
  beforeAll(() => { result = parsePnbExcel(FIXTURE); });

  test('identifies the bank and account metadata', () => {
    expect(result.bank).toBe('PNB');
    expect(result.account).toMatchObject({
      account_number: '4563000100036079',
      account_holder: 'ABHISHEK BHARDWAJ',
      ifsc: 'PUNB0456300',
      bank_name: 'Punjab National Bank',
      branch: 'DELHI MAMS CD-BLOCK PITAMPURA',
    });
    expect(result.account.statement_period_from).toBe('2026-06-02T00:00:00.000Z');
    expect(result.account.statement_period_to).toBe('2026-07-02T00:00:00.000Z');
  });

  test('parses exactly 96 transactions (metadata + footer excluded)', () => {
    expect(result.transactions).toHaveLength(96);
  });

  test('first row: credit with split Dr/Cr columns and balance suffix stripped', () => {
    const first = result.transactions[0];
    expect(first).toMatchObject({
      ref_no: 'U12010768',
      txn_date: '2026-07-02T00:00:00.000Z',
      narration: 'UPI/CR/168797098045/Mrs Lale/IDIB/9631574663-2@yb/',
      debit_amount: null,
      credit_amount: 500,
      balance: 2274.95,
      balance_type: 'Cr',
      value_date: null,
      source_row: 20,
    });
  });

  test('last row: interest credit (narration containing dates parses cleanly)', () => {
    const last = result.transactions[95];
    expect(last).toMatchObject({
      ref_no: 'U90904741',
      txn_date: '2026-06-02T00:00:00.000Z',
      narration: '4563000100036079:Int.Pd:01-03-2026 to 31-05-2026',
      debit_amount: null,
      credit_amount: 141,
      balance: 8759.95,
      balance_type: 'Cr',
    });
  });

  test('NEFT counterparty narration is kept as raw text (no special-casing)', () => {
    const neft = result.transactions.find((t) => t.ref_no === 'S1937240');
    expect(neft).toBeDefined();
    expect(neft.credit_amount).toBe(21180);
    expect(neft.debit_amount).toBeNull();
    expect(neft.narration).toContain('M INTERGRAPH SYSTEMS PVT');
    expect(neft.narration).toContain('NEFT_IN:');
  });

  test('every row has exactly one of debit/credit, a balance, and an ISO date', () => {
    for (const t of result.transactions) {
      const sides = [t.debit_amount, t.credit_amount].filter((v) => v !== null);
      expect(sides).toHaveLength(1);
      expect(t.balance).toEqual(expect.any(Number));
      expect(t.balance_type).toBe('Cr');
      expect(t.txn_date).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/);
    }
  });

  test('aggregate anchor: 85 debits ₹50,196.00 and 11 credits ₹43,852.00', () => {
    const debits = result.transactions.filter((t) => t.debit_amount !== null);
    const credits = result.transactions.filter((t) => t.credit_amount !== null);
    expect(debits).toHaveLength(85);
    expect(credits).toHaveLength(11);
    const sum = (xs, k) => xs.reduce((a, t) => a + t[k], 0);
    expect(sum(debits, 'debit_amount')).toBeCloseTo(50196.0, 2);
    expect(sum(credits, 'credit_amount')).toBeCloseTo(43852.0, 2);
  });

  test('produces no structural warnings on the clean fixture', () => {
    expect(result.warnings).toEqual([]);
  });
});

describe('parsePnbExcel — header detection resilience', () => {
  /** Build an in-memory workbook file with the given AOA rows. */
  function writeTempXls(rows) {
    const os = require('os');
    const fs = require('fs');
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'STATEMENT');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pnb-')), 'stmt.xls');
    XLSX.writeFile(wb, file, { bookType: 'biff8' });
    return file;
  }

  const HEADER = ['Txn No.', 'Txn Date', 'Description', '', 'Branch Name', 'Cheque No.', 'Dr Amount', 'Cr Amount', 'Balance'];
  const TXN = ['T1', '15/06/2026', 'UPI/DR/x/y', '', '-', '', '100.0', '', '900.00 Cr.'];

  test('finds the header when the metadata block height shifts', () => {
    const rows = [
      ['Account Statement for Account Number 9999000011112222'],
      ['IFSC:', 'PUNB0123400'],
      ['Customer Name:', 'TEST HOLDER'],
      // header on row 3 instead of 19
      HEADER,
      TXN,
    ];
    const parsed = parsePnbExcel(writeTempXls(rows));
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0].debit_amount).toBe(100);
    expect(parsed.transactions[0].balance).toBe(900);
    expect(parsed.account.account_number).toBe('9999000011112222');
  });

  test('throws PNB_HEADER_NOT_FOUND on a non-PNB workbook', () => {
    const file = writeTempXls([
      ['Layer', 'Beneficiary Account', 'Disputed Amount'],
      ['1', 'ACC1', '5000'],
    ]);
    expect(() => parsePnbExcel(file)).toThrow(expect.objectContaining({ code: 'PNB_HEADER_NOT_FOUND' }));
  });

  test('throws PNB_NO_TRANSACTIONS when the table has a header but no data', () => {
    const file = writeTempXls([HEADER]);
    expect(() => parsePnbExcel(file)).toThrow(expect.objectContaining({ code: 'PNB_NO_TRANSACTIONS' }));
  });
});

describe('pnbExcel cell parsers', () => {
  const { parseBalance, parseAmount } = _internals;

  test('parseBalance strips the Cr/Dr suffix and keeps the indicator', () => {
    expect(parseBalance('2274.95 Cr.')).toEqual({ balance: 2274.95, type: 'Cr' });
    expect(parseBalance('1,50,000.00 Dr.')).toEqual({ balance: 150000, type: 'Dr' });
    expect(parseBalance('42.00 cr')).toEqual({ balance: 42, type: 'Cr' });
    expect(parseBalance(1234.5)).toEqual({ balance: 1234.5, type: null });
    expect(parseBalance('')).toEqual({ balance: null, type: null });
    expect(parseBalance('n/a')).toEqual({ balance: null, type: null });
  });

  test('parseAmount handles strings, thousands separators, and blanks', () => {
    expect(parseAmount('21,180.0')).toBe(21180);
    expect(parseAmount('500.0')).toBe(500);
    expect(parseAmount(75)).toBe(75);
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('-')).toBeNull();
    expect(parseAmount(null)).toBeNull();
  });
});
