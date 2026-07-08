'use strict';

/**
 * "Old Transaction" sheet support + zero-financial-impact unblocking.
 *
 * Real NCRP BankAction CompleteTrail exports add a separate "Old Transaction"
 * tab for transactions the bank flags as older than the 6-month NCRP window.
 * These rows carry no recoverable money (typically ₹0.00) and must NOT block
 * the upload, NOR contribute to any financial figure — but they must be parsed,
 * stored, and surfaced.
 *
 * This suite locks in:
 *   1. classifySheet recognises "Old Transaction" / "Old Transactions".
 *   2. The parser routes those rows into `oldTransactions`, never `rows`,
 *      and raises no blocking error.
 *   3. pifsc_code drives IFSC-authoritative bank resolution.
 *   4. PART 2 — an UNRECOGNISED sheet whose rows are all ₹0.00 warns + skips
 *      instead of refusing the whole upload (non-zero rows still hard-block).
 *   5. Route: upload succeeds (202), the response carries the masked
 *      OLD_TRANSACTIONS_FOUND banner, and the analysis summary excludes them.
 */

process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('supertest');
const XLSX = require('xlsx');

const { parseNcrpFile, _internals } = require('../parsers/ncrpParser');
const { initializeDatabase } = require('../db/schema');
const { createApp } = require('../server');
const { loginAs, authed } = require('./helpers/auth');

const { SHEET_CATEGORY, classifySheet } = _internals;

const tempFiles = [];
afterAll(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch (_e) { /* best effort */ }
  }
});

function writeTempWorkbook(sheetDefs) {
  const wb = XLSX.utils.book_new();
  for (const def of sheetDefs) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(def.rows), def.name);
  }
  const filePath = path.join(
    os.tmpdir(),
    `ncrp-oldtxn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`
  );
  XLSX.writeFile(wb, filePath);
  tempFiles.push(filePath);
  return filePath;
}

function workbookBuffer(sheetDefs) {
  const wb = XLSX.utils.book_new();
  for (const def of sheetDefs) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(def.rows), def.name);
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/** One real money-transfer hop so the file is a valid CompleteTrail export. */
function transferSheet() {
  return {
    name: 'Money Transfer to',
    rows: [
      ['Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Bank/FIs', 'Layer',
        'Account No', 'Action Taken By bank', 'IFSC Code', 'Transaction Date',
        'Transaction Amount', 'Disputed Amount', 'UTR/Reference No', 'Remarks'],
      ['ACK1', 'V0001', 'HDFC Bank', 1,
        'MULE1', 'ICICI Bank', 'ICIC0001234', '2024-01-15 10:00:00',
        100000, 100000, 'UTR1', 'IMPS'],
    ],
  };
}

/**
 * "Old Transaction" sheet matching the real export shape (singular name, extra
 * ptrans / paccountno / pifsc_code columns). One ₹0.00 row.
 */
function oldTransactionSheet(name = 'Old Transaction', { pifsc = '' } = {}) {
  return {
    name,
    rows: [
      ['S No.', 'Acknowledgement No', 'Account No.', 'Transaction Id', 'Transaction Date',
        'Transaction Amount', 'Reference No', 'Remarks', 'Action Taken By bank',
        'Date of Action', 'Layer', 'pisnodal', 'ptrans', 'paccountno', 'pifsc_code'],
      [1, 'ACK1', '43619403919', 'TXN9001', '2023-01-10 09:00:00',
        0, 'REF9001', 'Txn more then six month old', 'State Bank of India',
        '2024-01-20', 3, 'N', 'PTXN1', '99887766', pifsc],
    ],
  };
}

// ─── 1. Sheet-name classification ───────────────────────────────────────

describe('classifySheet recognises the Old Transaction tab', () => {
  test('singular and plural both map to OLD_TRANSACTION, known', () => {
    expect(classifySheet('Old Transaction')).toEqual({
      category: SHEET_CATEGORY.OLD_TRANSACTION, known: true,
    });
    expect(classifySheet('Old Transactions')).toEqual({
      category: SHEET_CATEGORY.OLD_TRANSACTION, known: true,
    });
    // Punctuation / case variants resolve via the keyword fallback.
    expect(classifySheet('OLD_TRANSACTION (1)').category).toBe(SHEET_CATEGORY.OLD_TRANSACTION);
  });
});

// ─── 2 & 3. Parser routing + IFSC resolution ────────────────────────────

describe('parser: Old Transaction rows are set aside, not blocked', () => {
  test('no blocking error; one old transaction; zero contamination of rows', () => {
    const parsed = parseNcrpFile(writeTempWorkbook([
      transferSheet(),
      oldTransactionSheet(),
    ]));

    expect(parsed.errors).toEqual([]);
    expect(parsed.oldTransactions).toHaveLength(1);

    const ot = parsed.oldTransactions[0];
    expect(ot.account_no).toBe('43619403919');
    expect(ot.transaction_amount).toBe(0);
    expect(ot.layer_no).toBe(3);
    expect(ot.bank).toMatch(/State Bank of India/i); // resolved from text (no IFSC)
    expect(ot.remarks).toMatch(/six month old/i);
    expect(ot.parent_txn).toBe('PTXN1');
    expect(ot.parent_account).toBe('99887766');

    // The canonical rows the analyzer reads contain ONLY the real hop.
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].beneficiary_account).toBe('MULE1');
    expect(parsed.rows.some((r) => r.victim_account === '43619403919'
      || r.beneficiary_account === '43619403919')).toBe(false);

    // Sheet is recorded as accepted, with an explicit old-transaction count.
    const sheet = parsed.sheets.find((s) => s.name === 'Old Transaction');
    expect(sheet).toMatchObject({ accepted: true, category: SHEET_CATEGORY.OLD_TRANSACTION, oldTransactionRows: 1 });

    expect(parsed.warnings.some((w) => /old transaction/i.test(String(w)))).toBe(true);
  });

  test('pifsc_code drives IFSC-authoritative bank resolution', () => {
    const parsed = parseNcrpFile(writeTempWorkbook([
      transferSheet(),
      oldTransactionSheet('Old Transactions', { pifsc: 'SBIN0000123' }),
    ]));
    const ot = parsed.oldTransactions[0];
    expect(ot.ifsc_code).toBe('SBIN0000123');
    expect(ot.bank_source).toBe('IFSC');
    expect(ot.bank).toBe('State Bank of India');
  });
});

// ─── 4. PART 2 — zero-amount unrecognised sheet no longer blocks ─────────

describe('unrecognised sheet with all-zero amounts warns + skips (no block)', () => {
  test('all ₹0.00 rows → 0 errors, sheet skipped, transfer row survives', () => {
    const parsed = parseNcrpFile(writeTempWorkbook([
      transferSheet(),
      {
        name: 'Reference Tab',  // unknown name, no channel hint
        rows: [
          ['Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer', 'Transaction Amount', 'Transaction Date'],
          ['ACK1', 'X0001', 1, 0, '2024-01-15'],
          ['ACK1', 'X0002', 1, '₹0.00', '2024-01-15'],
        ],
      },
    ]));

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    const skipped = parsed.sheets.find((s) => s.name === 'Reference Tab');
    expect(skipped).toMatchObject({ accepted: false, reason: 'unrecognised-zero-amount' });
    expect(parsed.warnings.some((w) => /all .*0\.00|no financial impact/i.test(String(w)))).toBe(true);
  });

  test('non-zero amount on an unrecognised sheet still hard-blocks', () => {
    const parsed = parseNcrpFile(writeTempWorkbook([
      transferSheet(),
      {
        name: 'Reference Tab',
        rows: [
          ['Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer', 'Transaction Amount', 'Transaction Date'],
          ['ACK1', 'X0001', 1, 0, '2024-01-15'],
          ['ACK1', 'X0002', 1, 5000, '2024-01-15'],   // real money → must block
        ],
      },
    ]));
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({
      code: 'UNKNOWN_CHANNEL_WITH_TRANSACTIONS',
      sheet: 'Reference Tab',
      dataRows: 1,   // only the non-zero row is counted
    });
  });
});

// ─── 5. Route-level: upload succeeds, banner present, summary excludes ───

describe('upload route: Old Transaction sheet does not block the upload', () => {
  let db;
  let agent;

  beforeAll(async () => {
    db = initializeDatabase(':memory:');
    const app = createApp(db);
    agent = authed(app, await loginAs(app));
  });
  afterAll(() => {
    try { db.close(); } catch (_e) { /* best effort */ }
  });

  test('202, masked OLD_TRANSACTIONS_FOUND warning, analysis excludes old rows', async () => {
    const buf = workbookBuffer([transferSheet(), oldTransactionSheet()]);

    const res = await agent
      .post('/api/ncrp/upload')
      .attach('ncrpFile', buf, 'with_old_txn.xlsx');

    expect(res.status).toBe(202);
    expect(res.body.rowCount).toBe(1); // the real hop only

    const banner = (res.body.warnings || []).find((w) => w && w.code === 'OLD_TRANSACTIONS_FOUND');
    expect(banner).toBeTruthy();
    expect(banner.count).toBe(1);
    expect(banner.message).toMatch(/excluded from all financial calculations/i);
    // Account is masked (last 4 digits only), never shown in full.
    expect(banner.message).not.toMatch(/43619403919/);
    expect(banner.accounts.join(',')).toMatch(/3919$/);

    // Wait for background analysis to settle, then confirm exclusion.
    const reportId = res.body.reportId;
    let report;
    for (let i = 0; i < 40; i++) {
      report = (await agent.get(`/api/ncrp/${reportId}`)).body;
      if (report.analysis_status === 'complete' || report.analysis_status === 'error') break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(report.analysis_status).toBe('complete');
    expect(report.total_transactions).toBe(1);          // old txn NOT counted
    expect(report.analysis_json.summary.total_transactions).toBe(1);
    // The old transaction is carried into the analysis snapshot for Annexure H.
    expect(Array.isArray(report.analysis_json.old_transactions)).toBe(true);
    expect(report.analysis_json.old_transactions).toHaveLength(1);
    expect(report.analysis_json.old_transactions[0].account_no).toBe('43619403919');
  });
});
