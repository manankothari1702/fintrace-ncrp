'use strict';

/**
 * PNB PDF statement parser — verified against the real fixture
 * pnb_statement.pdf (same account/period as pnb_statement.xls: 96
 * transactions, 85 debits ₹50,196.00 + 11 credits ₹43,852.00). The PDF is a
 * digital text PDF (pdfjs text extraction, no OCR); rows wrap across
 * physical lines and footer boilerplate appears inside the table region, so
 * the assertions here specifically cover reassembly and boilerplate
 * filtering.
 */

const path = require('path');

const { parsePnbPdf, _internals } = require('../parsers/bankStatement/pnbPdf');

const FIXTURE = path.join(__dirname, 'fixtures', 'pnb_statement.pdf');

describe('parsePnbPdf — real PNB fixture', () => {
  let result;
  beforeAll(async () => { result = await parsePnbPdf(FIXTURE); });

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

  test('parses exactly 96 transactions across all pages', () => {
    expect(result.transactions).toHaveLength(96);
  });

  test('single Type column maps CR/DR onto split credit/debit amounts', () => {
    const first = result.transactions[0];
    expect(first).toMatchObject({
      txn_date: '2026-07-02T00:00:00.000Z',
      credit_amount: 500,
      debit_amount: null,
      balance: 2274.95,
      balance_type: null, // PDF balance has no Cr./Dr. suffix
      value_date: null,
    });
    const second = result.transactions[1];
    expect(second).toMatchObject({
      txn_date: '2026-07-01T00:00:00.000Z',
      debit_amount: 300,
      credit_amount: null,
      balance: 1774.95,
    });
  });

  test('wrapped Remarks lines are reassembled into one narration', () => {
    // Physical layout: "UPI/CR/168797098045/Mrs" + next line "Lale/IDIB/…".
    expect(result.transactions[0].narration)
      .toBe('UPI/CR/168797098045/Mrs Lale/IDIB/9631574663-2@yb/');
    // Three-line NEFT wrap, including the M INTERGRAPH counterparty text —
    // parsed as plain narration, no special-casing.
    const neft = result.transactions.filter((t) => (t.narration || '').includes('M INTERGRAPH SYSTEMS PVT'));
    expect(neft.length).toBeGreaterThan(0);
    for (const t of neft) {
      expect(t.narration).toMatch(/^NEFT_IN:/);
      expect(t.credit_amount).not.toBeNull();
    }
  });

  test('footer boilerplate never leaks into narrations', () => {
    for (const t of result.transactions) {
      expect(t.narration || '').not.toMatch(
        /Generated through|Abbreviations|Page \d|minimum average|cheque leaves|POINT OF/i,
      );
    }
  });

  test('every row has exactly one of debit/credit, a numeric balance, an ISO date', () => {
    for (const t of result.transactions) {
      const sides = [t.debit_amount, t.credit_amount].filter((v) => v !== null);
      expect(sides).toHaveLength(1);
      expect(t.balance).toEqual(expect.any(Number));
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

describe('parsePnbPdf — error paths', () => {
  test('throws PNB_PDF_UNREADABLE on a non-PDF buffer', async () => {
    await expect(parsePnbPdf(Buffer.from('not a pdf at all')))
      .rejects.toMatchObject({ code: 'PNB_PDF_UNREADABLE' });
  });
});

describe('pnbPdf row assembly internals', () => {
  const { buildTransaction } = _internals;

  const mkItems = (...pairs) => ({ items: pairs.map(([x, str]) => ({ x, str })) });

  test('numeric Instrument ID is never mistaken for the amount', () => {
    // Date | instrument 123456 | amount 500.0 | DR | balance 900.00 | remarks
    const line = mkItems([43, '01/06/2026'], [120, '123456'], [183, '500.0'],
      [234, 'DR'], [281, '900.00'], [346, 'CHQ paid']);
    const warnings = [];
    const built = buildTransaction(line, '2026-06-01T00:00:00.000Z', 7, warnings);
    expect(built.txn).toMatchObject({
      ref_no: '123456', debit_amount: 500, credit_amount: null,
      balance: 900, narration: 'CHQ paid', source_row: 7,
    });
    expect(built.remarksStartX).toBe(346);
    expect(warnings).toEqual([]);
  });

  test('a date-anchored line without a CR/DR backbone is skipped with a warning', () => {
    const warnings = [];
    const built = buildTransaction(mkItems([43, '01/06/2026'], [385, 'stray text']),
      '2026-06-01T00:00:00.000Z', 9, warnings);
    expect(built).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('line 9');
  });
});
