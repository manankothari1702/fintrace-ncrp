'use strict';

/**
 * Parser-hardening tests for backend/src/parsers/ncrpParser.js.
 *
 * Covers the format-variance defences:
 *   • shifted header rows (banner/title rows above the table, rows 0–10)
 *   • merged header + data cells (forward-fill)
 *   • fuzzy sheet-name matching (renamed / oddly-cased / extra sheets)
 *   • FAIL LOUD — structured ParseError when a required column cannot be
 *     mapped on a sheet that has data, blocked at the upload route (422)
 *   • expanded header synonyms (abbreviations, punctuation drift, Hindi)
 */

process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('supertest');
const XLSX = require('xlsx');

const { parseNcrpFile, detectColumnMapping, _internals } = require('../parsers/ncrpParser');
const { initializeDatabase } = require('../db/schema');
const { createApp } = require('../server');
const { loginAs, authed } = require('./helpers/auth');
const { STANDARD_HEADERS, buildStandardRows, makeTestXlsx } = require('./helpers/xlsx');

const { SHEET_CATEGORY, classifySheet, HEADER_SCAN_DEPTH } = _internals;

// ─── Local fixture builders ─────────────────────────────────────────────

const tempFiles = [];
afterAll(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch (_e) { /* best effort */ }
  }
});

/**
 * Write a multi-sheet workbook (optionally with merged regions) to a temp
 * .xlsx file and return its path.
 *
 * @param {Array<{ name: string, rows: Array<Array<unknown>>, merges?: Array<object> }>} sheetDefs
 * @returns {string}
 */
function writeTempWorkbook(sheetDefs) {
  const wb = XLSX.utils.book_new();
  for (const def of sheetDefs) {
    const ws = XLSX.utils.aoa_to_sheet(def.rows);
    if (def.merges) ws['!merges'] = def.merges;
    XLSX.utils.book_append_sheet(wb, ws, def.name);
  }
  const filePath = path.join(
    os.tmpdir(),
    `ncrp-hardening-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`
  );
  XLSX.writeFile(wb, filePath);
  tempFiles.push(filePath);
  return filePath;
}

/** A minimal transfer-channel data row matching STANDARD_HEADERS order. */
function standardDataRow(overrides = {}) {
  const row = [
    'NCRP202612345678', '2024-01-14T00:00:00.000Z',
    'V0001', 'HDFC Bank',
    'M0001', 'ICICI Bank', 'Mule One', 'ICIC0001234',
    '2024-01-15T05:00:00.000Z', 100000, 100000,
    'UTR0001', 'IMPS', 1,
    null, null, 'Mumbai', 'Maharashtra', 'leg',
  ];
  for (const [idx, val] of Object.entries(overrides)) row[Number(idx)] = val;
  return row;
}

// ─── 1. Shifted header rows ─────────────────────────────────────────────

describe('shifted header detection (banner rows above the table)', () => {
  test('header on row 3 below three banner rows is found and parsed', () => {
    const filePath = writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [
        ['National Cybercrime Reporting Portal'],
        ['BankAction CompleteTrail Report'],
        ['Generated: 2026-01-05'],
        [...STANDARD_HEADERS],
        standardDataRow(),
        standardDataRow({ 4: 'M0002', 11: 'UTR0002' }),
      ],
    }]);

    const { rows, errors, sheets } = parseNcrpFile(filePath);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows[0].beneficiary_account).toBe('M0001');
    expect(rows[0].transaction_amount).toBe(100000);
    expect(sheets[0].accepted).toBe(true);
    expect(sheets[0].headerRow).toBe(3);
  });

  test('header on row 10 (last row of the scan window) is still found', () => {
    const banners = Array.from({ length: 10 }, (_, i) => [`banner line ${i + 1}`]);
    const filePath = writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [...banners, [...STANDARD_HEADERS], standardDataRow()],
    }]);

    const { rows, errors, sheets } = parseNcrpFile(filePath);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(sheets[0].headerRow).toBe(10);
  });

  test(`header beyond the ${HEADER_SCAN_DEPTH}-row window is NOT silently used`, () => {
    const banners = Array.from({ length: 12 }, (_, i) => [`banner line ${i + 1}`]);
    const filePath = writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [...banners, [...STANDARD_HEADERS], standardDataRow()],
    }]);

    const { rows, warnings } = parseNcrpFile(filePath);
    expect(rows).toEqual([]);
    expect(warnings.some((w) => /header/i.test(w))).toBe(true);
  });
});

// ─── 2. Merged cells ────────────────────────────────────────────────────

describe('merged-cell forward-fill', () => {
  test('vertically merged data cells (Ack No spanning 3 rows) are filled', () => {
    // Ack No present only on the first data row; rows 2-3 covered by a merge.
    const filePath = writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [
        [...STANDARD_HEADERS],
        standardDataRow(),
        standardDataRow({ 0: null, 4: 'M0002', 11: 'UTR0002' }),
        standardDataRow({ 0: null, 4: 'M0003', 11: 'UTR0003' }),
      ],
      // A2:A4 (r1..r3, c0) — the Ack No block.
      merges: [{ s: { r: 1, c: 0 }, e: { r: 3, c: 0 } }],
    }]);

    const { rows, errors, warnings } = parseNcrpFile(filePath);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.ack_no).toBe('NCRP202612345678');
    expect(warnings.some((w) => /merged/i.test(w))).toBe(true);
  });

  test('two-row merged header parses cleanly (no phantom header-copy data row)', () => {
    // Every header cell merged vertically across rows 0-1; after forward-fill
    // row 1 is an exact copy of the header and must be skipped, not parsed as
    // a transaction whose amount is the string "Transaction Amount".
    const merges = STANDARD_HEADERS.map((_, c) => ({ s: { r: 0, c }, e: { r: 1, c } }));
    const filePath = writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [
        [...STANDARD_HEADERS],
        STANDARD_HEADERS.map(() => null),
        standardDataRow(),
        standardDataRow({ 4: 'M0002', 11: 'UTR0002' }),
      ],
      merges,
    }]);

    const { rows, errors, warnings } = parseNcrpFile(filePath);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => typeof r.transaction_amount === 'number')).toBe(true);
    expect(rows.every((r) => r.transaction_amount === 100000)).toBe(true);
    expect(warnings.some((w) => /repeated header/i.test(w))).toBe(true);
  });
});

// ─── 3. Fuzzy sheet-name matching ───────────────────────────────────────

describe('fuzzy sheet-name matching', () => {
  test('classifySheet normalises case / whitespace / punctuation', () => {
    expect(classifySheet(' MONEY_transfer  TO ')).toEqual({ category: SHEET_CATEGORY.TRANSFER, known: true });
    expect(classifySheet('Withdrawal-Through-ATM')).toEqual({ category: SHEET_CATEGORY.ATM, known: true });
    expect(classifySheet('POS')).toEqual({ category: SHEET_CATEGORY.POS, known: true });
    expect(classifySheet('aeps ')).toEqual({ category: SHEET_CATEGORY.AEPS, known: true });
    expect(classifySheet('Transaction put on hold')).toEqual({ category: SHEET_CATEGORY.HOLD, known: true });
    expect(classifySheet('OTHERS LESS THEN 500')).toEqual({ category: SHEET_CATEGORY.OTHER, known: true });
    expect(classifySheet('Others Less Than 500')).toEqual({ category: SHEET_CATEGORY.OTHER, known: true });
    expect(classifySheet('Quarterly Budget')).toEqual({ category: SHEET_CATEGORY.OTHER, known: false });
  });

  test('renamed ATM sheet still folds the channel into payment_mode', () => {
    const atmHeaders = [
      'Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer',
      'Withdrawal Amount', 'Withdrawal Date', 'ATM ID', 'Place of ATM', 'Remarks',
    ];
    const filePath = writeTempWorkbook([{
      name: 'WITHDRAWAL_THROUGH_ATM (1)',
      rows: [
        atmHeaders,
        ['NCRP1', 'A1', 1, 5000, '2024-01-16', 'ATM99', 'LUCKNOW', null],
      ],
    }]);

    const { rows, errors, sheets } = parseNcrpFile(filePath);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(sheets[0].category).toBe(SHEET_CATEGORY.ATM);
    expect(rows[0].payment_mode).toBe('ATM');
    expect(rows[0].atm_id).toBe('ATM99');
  });

  test('unknown-but-NCRP-shaped sheet is parsed and flagged; junk sheet skipped and logged', () => {
    const filePath = writeTempWorkbook([
      { name: 'My Renamed Export', rows: [[...STANDARD_HEADERS], standardDataRow()] },
      { name: 'Notes', rows: [['lorem', 'ipsum'], ['dolor', 'sit amet']] },
    ]);

    const { rows, errors, warnings, sheets } = parseNcrpFile(filePath);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(warnings.some((w) => /My Renamed Export.*does not match any known NCRP sheet name/i.test(w))).toBe(true);
    expect(warnings.some((w) => /Skipped 1 sheet/i.test(w) && /Notes/.test(w))).toBe(true);
    const notes = sheets.find((s) => s.name === 'Notes');
    expect(notes.accepted).toBe(false);
  });
});

// ─── 4. FAIL LOUD: required columns ─────────────────────────────────────

describe('required-column enforcement (FAIL LOUD)', () => {
  test('transfer sheet with data but no Transaction Amount → structured ParseError, zero rows', () => {
    const headers = STANDARD_HEADERS.filter((h) => h !== 'Transaction Amount');
    const dataRow = standardDataRow();
    dataRow.splice(STANDARD_HEADERS.indexOf('Transaction Amount'), 1);

    const filePath = writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [headers, dataRow, dataRow],
    }]);

    const { rows, errors, sheets } = parseNcrpFile(filePath);
    expect(rows).toEqual([]);                 // NO guessed figures, ever
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: 'REQUIRED_COLUMN_MISSING',
      sheet: 'Money Transfer to',
      category: SHEET_CATEGORY.TRANSFER,
      expectedColumn: 'Transaction Amount',
      dataRows: 2,
    });
    expect(errors[0].foundHeaders).toEqual(expect.arrayContaining(['Acknowledgement No', 'Disputed Amount']));
    expect(errors[0].message).toMatch(/Money Transfer to/);
    expect(errors[0].message).toMatch(/Transaction Amount/);
    expect(sheets[0]).toMatchObject({ accepted: false, reason: 'missing-required-columns' });
  });

  test('transfer sheet missing Disputed Amount → ParseError (victim loss would be silently zero)', () => {
    const headers = STANDARD_HEADERS.filter((h) => h !== 'Disputed Amount');
    const dataRow = standardDataRow();
    dataRow.splice(STANDARD_HEADERS.indexOf('Disputed Amount'), 1);

    const { errors } = parseNcrpFile(writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [headers, dataRow],
    }]));
    expect(errors).toHaveLength(1);
    expect(errors[0].expectedColumn).toBe('Disputed Amount');
  });

  test('data sheet with no account column at all → ParseError, not a silent skip', () => {
    const filePath = writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [
        ['Acknowledgement No', 'Transaction Amount', 'Disputed Amount', 'Layer', 'Transaction Date'],
        ['NCRP1', 1000, 1000, 1, '2024-01-16'],
      ],
    }]);
    const { rows, errors } = parseNcrpFile(filePath);
    expect(rows).toEqual([]);
    expect(errors.some((e) =>
      e.code === 'REQUIRED_COLUMN_MISSING' && /Account/i.test(e.expectedColumn))).toBe(true);
  });

  test('errored sheet contributes nothing while a good sheet still parses (route blocks anyway)', () => {
    const badHeaders = STANDARD_HEADERS.filter((h) => h !== 'Transaction Amount');
    const badRow = standardDataRow();
    badRow.splice(STANDARD_HEADERS.indexOf('Transaction Amount'), 1);

    const { rows, errors } = parseNcrpFile(writeTempWorkbook([
      { name: 'Money Transfer to', rows: [[...STANDARD_HEADERS], standardDataRow()] },
      { name: 'Withdrawal through ATM', rows: [badHeaders, badRow] },
    ]));
    expect(errors).toHaveLength(1);
    expect(errors[0].sheet).toBe('Withdrawal through ATM');
    expect(rows).toHaveLength(1); // only the good sheet's row
  });

  test('header-only sheet (no data rows) missing columns is NOT an error', () => {
    const headers = STANDARD_HEADERS.filter((h) => h !== 'Transaction Amount');
    const { errors } = parseNcrpFile(writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [headers],
    }]));
    expect(errors).toEqual([]);
  });

  test('"Others Less Then 500" without an amount column stays valid (real exports omit it)', () => {
    const filePath = writeTempWorkbook([{
      name: 'Others Less Then 500',
      rows: [
        ['S No.', 'Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer', 'Action Taken By bank', 'Remarks'],
        [1, 'NCRP1', 'A1', 1, 'HDFC Bank', 'misc'],
      ],
    }]);
    const { rows, errors } = parseNcrpFile(filePath);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(1);
  });
});

// ─── 5. Expanded synonyms ───────────────────────────────────────────────

describe('expanded header synonyms', () => {
  test.each([
    ['Txn Amt', 'transaction_amount'],
    ['Transaction Amount (INR)', 'transaction_amount'],
    ['Amount in INR', 'transaction_amount'],
    ['लेनदेन राशि', 'transaction_amount'],
    ['Disputed Amount (INR)', 'disputed_amount'],
    ['Fraud Amount', 'disputed_amount'],
    ['विवादित राशि', 'disputed_amount'],
    ['Layer No.', 'layer_no'],
    ['Layer #', 'layer_no'],
    ['लेयर', 'layer_no'],
    ['Action Taken By Bank/FI', 'beneficiary_bank'],
    ['Account No. / (Wallet /PG/PA) Id', 'victim_account'],
    ['Victim A/c No.', 'victim_account'],
    ['खाता संख्या', 'victim_account'],
  ])('%s → %s', (header, canonical) => {
    const { mapping } = detectColumnMapping([header]);
    expect(mapping[canonical]).toBe(0);
  });

  test('trailing/leading whitespace and punctuation drift still map (loose matching)', () => {
    const { mapping } = detectColumnMapping([
      '  Transaction Amount  ',  // padding
      'Layer-No.',               // punctuation drift, not in the synonym list
      'Disputed  Amount',        // doubled internal space
    ]);
    expect(mapping.transaction_amount).toBe(0);
    expect(mapping.layer_no).toBe(1);
    expect(mapping.disputed_amount).toBe(2);
  });

  test('ambiguous loose keys are refused, not guessed', () => {
    // "Bank" alone matches nothing — it must NOT loosely resolve to one of the
    // several bank columns.
    const { mapping, unmapped } = detectColumnMapping(['Bank']);
    expect(Object.keys(mapping)).toEqual([]);
    expect(unmapped).toEqual(['Bank']);
  });
});

// ─── 6. Upload route blocks on ParseError (422) ─────────────────────────

describe('POST /api/ncrp/upload blocks files with missing required columns', () => {
  let db;
  let app;
  let agent;

  beforeAll(async () => {
    db = initializeDatabase(':memory:');
    app = createApp(db);
    agent = authed(app, await loginAs(app));
  });

  afterAll(() => {
    try { db.close(); } catch (_e) { /* best effort */ }
  });

  test('missing-required-column file → 422 PARSE_BLOCKED with structured details, no report created', async () => {
    const headers = STANDARD_HEADERS.filter((h) => h !== 'Transaction Amount');
    const dataRow = standardDataRow();
    dataRow.splice(STANDARD_HEADERS.indexOf('Transaction Amount'), 1);
    const buf = makeTestXlsx([headers, dataRow], 'Money Transfer to');

    const res = await agent
      .post('/api/ncrp/upload')
      .attach('ncrpFile', buf, 'broken_ncrp.xlsx');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PARSE_BLOCKED');
    expect(res.body.error.message).toMatch(/Transaction Amount/);
    expect(res.body.error.message).toMatch(/No figures were computed/i);
    expect(res.body.error.details.parseErrors).toHaveLength(1);
    expect(res.body.error.details.parseErrors[0]).toMatchObject({
      code: 'REQUIRED_COLUMN_MISSING',
      sheet: 'Money Transfer to',
      expectedColumn: 'Transaction Amount',
    });

    // Nothing was ingested — the reports list stays empty.
    const list = await agent.get('/api/ncrp/reports');
    expect(list.body).toEqual([]);
  });

  test('a healthy file still uploads (202) after the hardening', async () => {
    const buf = makeTestXlsx(buildStandardRows(), 'Money Transfer to');
    const res = await agent
      .post('/api/ncrp/upload')
      .attach('ncrpFile', buf, 'sample_ncrp.xlsx');
    expect(res.status).toBe(202);
    expect(res.body.reportId).toEqual(expect.any(Number));
    expect(res.body.rowCount).toBe(5);
  });
});
