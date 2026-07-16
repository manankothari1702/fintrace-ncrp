'use strict';

/**
 * Generic mapping-driven parser + tabular reader — the wizard/template
 * ingestion path for banks without a dedicated parser.
 *
 * Two synthetic fixtures prove the layout variations the mapping must
 * encode (deliberately DIFFERENT from PNB's):
 *   • generic_single_amount.csv — comma CSV, metadata preamble, ONE amount
 *     column + a CR/DR type column, plain balances, oldest-first.
 *   • generic_split_semicolon.csv — SEMICOLON CSV, quoted fields with
 *     embedded semicolons, split withdrawal/deposit columns, Indian-grouped
 *     balances with a "Cr." suffix, newest-first.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseWithMapping, validateMapping, validateBalanceContinuity, _internals,
} = require('../parsers/bankStatement/genericMapped');
const {
  readTabularRows, findHeaderRowGeneric, previewRows, suggestMapping, sniffPreambleFacts,
} = require('../parsers/bankStatement/tabular');

const FIXTURES = path.join(__dirname, 'fixtures');
const SINGLE = path.join(FIXTURES, 'generic_single_amount.csv');
const SPLIT = path.join(FIXTURES, 'generic_split_semicolon.csv');

const SINGLE_MAPPING = {
  version: 1,
  columns: {
    Date: 'date', Details: 'narration', 'Ref No': 'ref_no',
    Amount: 'amount', Type: 'type', Balance: 'balance',
  },
  options: {},
};
const SPLIT_MAPPING = {
  version: 1,
  columns: {
    'Txn Date': 'date', Particulars: 'narration',
    'Withdrawal Amt.': 'debit', 'Deposit Amt.': 'credit', 'Closing Balance': 'balance',
  },
  options: {},
};

const writeTmpCsv = (content) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'genmap-')), 'stmt.csv');
  fs.writeFileSync(file, content, 'utf8');
  return file;
};

describe('single amount + type column CSV (comma, preamble, footer)', () => {
  let result;
  beforeAll(() => { result = parseWithMapping(SINGLE, SINGLE_MAPPING, { bankName: 'Synthetic Bank of Bharat' }); });

  test('parses 10 transactions; preamble and footer are excluded by the date gate', () => {
    expect(result.transactions).toHaveLength(10);
    expect(result.warnings).toEqual([]);
  });

  test('type column CR/DR drives the split debit/credit canonical fields', () => {
    const first = result.transactions[0];
    expect(first).toMatchObject({
      txn_date: '2026-06-01T00:00:00.000Z',
      narration: 'NEFT; SALARY CREDIT ACME CORP',
      credit_amount: 5000,
      debit_amount: null,
      balance: 15000,
      balance_type: null, // plain balances — no suffix in this layout
      ref_no: 'R001',
    });
    const second = result.transactions[1];
    expect(second).toMatchObject({ debit_amount: 2000, credit_amount: null, balance: 13000 });
    const debits = result.transactions.filter((t) => t.debit_amount !== null);
    expect(debits).toHaveLength(6);
  });

  test('quoted fields with embedded commas survive ("UPI, GROCERY MART")', () => {
    expect(result.transactions[2].narration).toBe('UPI, GROCERY MART');
    expect(result.transactions[2].debit_amount).toBe(450.5);
  });

  test('account facts sniffed from the preamble; period derived from the data', () => {
    expect(result.account).toMatchObject({
      account_number: '991100223344',
      ifsc: 'SYNB0001234',
      bank_name: 'Synthetic Bank of Bharat',
      statement_period_from: '2026-06-01T00:00:00.000Z',
      statement_period_to: '2026-06-30T00:00:00.000Z',
    });
  });
});

describe('split debit/credit CSV (semicolon, Cr. suffix, newest-first)', () => {
  let result;
  beforeAll(() => { result = parseWithMapping(SPLIT, SPLIT_MAPPING); });

  test('semicolon delimiter is sniffed; 5 transactions parse', () => {
    expect(result.transactions).toHaveLength(5);
    expect(result.warnings).toEqual([]);
  });

  test('Indian-grouped balance with Cr. suffix splits into number + type', () => {
    expect(result.transactions[0]).toMatchObject({
      txn_date: '2026-06-28T00:00:00.000Z',
      credit_amount: 250000,
      debit_amount: null,
      balance: 305210.4,
      balance_type: 'Cr',
    });
    expect(result.transactions[1]).toMatchObject({ debit_amount: 29579.1, balance: 55210.4 });
  });

  test('quoted embedded semicolons survive', () => {
    expect(result.transactions[0].narration).toBe('RTGS; PROPERTY ADVANCE RECEIVED');
    expect(result.transactions[3].narration).toBe('TRANSFER; FROM SAVINGS');
  });

  test('IFSC + account number sniffed from a differently-worded preamble', () => {
    expect(result.account.ifsc).toBe('MUCB0000062');
    expect(result.account.account_number).toBe('5566778899001122');
  });
});

describe('mapping variations', () => {
  test('single amount column with NO type column: sign gives direction', () => {
    const file = writeTmpCsv([
      'Date,Description,Amount,Balance',
      '01/06/2026,SALARY,5000.00,15000.00',
      '02/06/2026,ATM,-2000.00,13000.00',
    ].join('\n'));
    const r = parseWithMapping(file, {
      columns: { Date: 'date', Description: 'narration', Amount: 'amount', Balance: 'balance' },
    });
    expect(r.transactions[0]).toMatchObject({ credit_amount: 5000, debit_amount: null });
    expect(r.transactions[1]).toMatchObject({ debit_amount: 2000, credit_amount: null });
  });

  test('custom type tokens (Withdrawal/Deposit words instead of DR/CR)', () => {
    const file = writeTmpCsv([
      'Date,Description,Amount,Kind,Balance',
      '01/06/2026,X,100.00,Deposit,1100.00',
      '02/06/2026,Y,40.00,Withdrawal,1060.00',
    ].join('\n'));
    const r = parseWithMapping(file, {
      columns: { Date: 'date', Description: 'narration', Amount: 'amount', Kind: 'type', Balance: 'balance' },
      options: { debitValues: ['Withdrawal'], creditValues: ['Deposit'] },
    });
    expect(r.transactions[0].credit_amount).toBe(100);
    expect(r.transactions[1].debit_amount).toBe(40);
  });

  test('MDY date format hint reorders ambiguous dates', () => {
    const file = writeTmpCsv([
      'Date,Description,Amount,Balance',
      '06/01/2026,US-STYLE JUNE FIRST,10.00,110.00',
    ].join('\n'));
    const auto = parseWithMapping(file, {
      columns: { Date: 'date', Description: 'narration', Amount: 'amount', Balance: 'balance' },
    });
    expect(auto.transactions[0].txn_date).toBe('2026-01-06T00:00:00.000Z'); // Indian default: 6 Jan
    const mdy = parseWithMapping(file, {
      columns: { Date: 'date', Description: 'narration', Amount: 'amount', Balance: 'balance' },
      options: { dateFormat: 'MDY' },
    });
    expect(mdy.transactions[0].txn_date).toBe('2026-06-01T00:00:00.000Z'); // hinted: 1 Jun
  });

  test('unmatched type token keeps the row but warns', () => {
    const file = writeTmpCsv([
      'Date,Description,Amount,Type,Balance',
      '01/06/2026,OK,10.00,CR,110.00',
      '02/06/2026,ODD,10.00,??,120.00',
    ].join('\n'));
    const r = parseWithMapping(file, {
      columns: { Date: 'date', Description: 'narration', Amount: 'amount', Type: 'type', Balance: 'balance' },
    });
    expect(r.transactions).toHaveLength(2);
    expect(r.transactions[1].debit_amount).toBeNull();
    expect(r.transactions[1].credit_amount).toBeNull();
    expect(r.warnings.some((w) => /matches neither debit nor credit/.test(w))).toBe(true);
  });
});

describe('validateMapping — structural gate', () => {
  const bad = (mapping, msgRe) => {
    expect(() => validateMapping(mapping)).toThrow(expect.objectContaining({ code: 'INVALID_MAPPING' }));
    try { validateMapping(mapping); } catch (e) { expect(e.message).toMatch(msgRe); }
  };

  test('requires a date column', () => {
    bad({ columns: { A: 'amount' } }, /"date" column is required/);
  });
  test('requires an amount shape (split or single)', () => {
    bad({ columns: { D: 'date', N: 'narration' } }, /either debit\/credit columns or a single amount/);
  });
  test('rejects mixing split and single amount', () => {
    bad({ columns: { D: 'date', Dr: 'debit', A: 'amount' } }, /not both/);
  });
  test('rejects a type column without a single amount column', () => {
    bad({ columns: { D: 'date', Dr: 'debit', T: 'type' } }, /"type" column only applies/);
  });
  test('rejects duplicate roles and unknown roles', () => {
    bad({ columns: { A: 'date', B: 'date', C: 'amount' } }, /more than one column/);
    bad({ columns: { A: 'date', C: 'wat' } }, /unknown role/);
  });
  test('rejects a bad dateFormat', () => {
    bad({ columns: { D: 'date', A: 'amount' }, options: { dateFormat: 'DDMM' } }, /dateFormat/);
  });
});

describe('validateBalanceContinuity', () => {
  test('verifies both fixtures (oldest-first and newest-first)', () => {
    const f1 = validateBalanceContinuity(parseWithMapping(SINGLE, SINGLE_MAPPING).transactions);
    expect(f1).toMatchObject({ checked: true, direction: 'oldest-first', breakCount: 0 });
    expect(f1.warnings[0]).toMatch(/continuity verified: 10 rows/);

    const f2 = validateBalanceContinuity(parseWithMapping(SPLIT, SPLIT_MAPPING).transactions);
    expect(f2).toMatchObject({ checked: true, direction: 'newest-first', breakCount: 0 });
  });

  test('flags a deliberately corrupted balance as a break (warning, not failure)', () => {
    const txns = parseWithMapping(SINGLE, SINGLE_MAPPING).transactions;
    txns[4].balance += 1000; // corrupt one running balance
    const c = validateBalanceContinuity(txns);
    expect(c.checked).toBe(true);
    // One wrong balance breaks the chain into AND out of the row.
    expect(c.breakCount).toBe(2);
    expect(c.warnings[0]).toMatch(/continuity break at source row/);
    expect(c.warnings[0]).toMatch(/check the amount\/balance column mapping/);
  });

  test('a wrong direction-mapping (swapped debit/credit) breaks loudly', () => {
    const txns = parseWithMapping(SINGLE, {
      ...SINGLE_MAPPING,
      options: { debitValues: ['CR'], creditValues: ['DR'] }, // deliberately swapped
    }).transactions;
    const c = validateBalanceContinuity(txns);
    expect(c.breakCount).toBeGreaterThan(5); // nearly every row breaks
  });

  test('skips cleanly when balance is not mapped', () => {
    const file = writeTmpCsv(['Date,Description,Amount', '01/06/2026,X,10.00'].join('\n'));
    const txns = parseWithMapping(file, {
      columns: { Date: 'date', Description: 'narration', Amount: 'amount' },
    }).transactions;
    expect(validateBalanceContinuity(txns)).toMatchObject({ checked: false, breakCount: 0, warnings: [] });
  });
});

describe('tabular reader + wizard support', () => {
  test('findHeaderRowGeneric picks the real header over preamble label:value rows', () => {
    const rows = readTabularRows(SINGLE);
    const found = findHeaderRowGeneric(rows);
    expect(found.headerRow).toBe(6);
    expect(found.headers).toEqual(['Date', 'Details', 'Ref No', 'Amount', 'Type', 'Balance']);
  });

  test('previewRows returns data rows under the header, skipping blanks', () => {
    const rows = readTabularRows(SINGLE);
    const preview = previewRows(rows, 6, 6);
    expect(preview).toHaveLength(5);
    expect(preview[0][0]).toBe('01-06-2026');
    expect(preview[0][3]).toBe('5,000.00');
  });

  test('suggestMapping proposes sensible roles for both layouts', () => {
    expect(suggestMapping(['Date', 'Details', 'Ref No', 'Amount', 'Type', 'Balance'])).toEqual({
      Date: 'date', Details: 'narration', 'Ref No': 'ref_no',
      Amount: 'amount', Type: 'type', Balance: 'balance',
    });
    expect(suggestMapping(['Txn Date', 'Particulars', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'])).toEqual({
      'Txn Date': 'date', Particulars: 'narration',
      'Withdrawal Amt.': 'debit', 'Deposit Amt.': 'credit', 'Closing Balance': 'balance',
    });
  });

  test('sniffPreambleFacts finds IFSC/account across wording variants', () => {
    const rows = readTabularRows(SPLIT);
    expect(sniffPreambleFacts(rows, 5)).toMatchObject({
      ifsc: 'MUCB0000062', account_number: '5566778899001122',
    });
  });

  test('parseWithMapping fails loud when mapped headers are absent', () => {
    expect(() => parseWithMapping(SINGLE, {
      columns: { 'Nonexistent Col': 'date', Amount: 'amount' },
    })).toThrow(expect.objectContaining({ code: 'MAPPED_HEADER_NOT_FOUND' }));
  });
});

describe('date-format internals', () => {
  const { parseDateWithFormat } = _internals;
  test('YMD passes ISO-style through; auto handles unambiguous forms', () => {
    expect(parseDateWithFormat('2026-06-01', 'YMD')).toBe('2026-06-01T00:00:00.000Z');
    expect(parseDateWithFormat('25/12/2026', 'auto')).toBe('2026-12-25T00:00:00.000Z');
    expect(parseDateWithFormat('12/25/2026', 'MDY')).toBe('2026-12-25T00:00:00.000Z');
    expect(parseDateWithFormat('not a date', 'auto')).toBeNull();
  });
});
