'use strict';

/**
 * Unit tests for backend/src/db/queries.js.
 *
 * Drives the prepared-statement helpers against an in-memory SQLite so the
 * filter-building branches in getTransactionsByReport are exercised (the
 * route layer composes its own SQL, so this only fires when the helper is
 * called directly).
 */

const { initializeDatabase } = require('../db/schema');
const {
  insertReport,
  insertTransaction,
  insertManyTransactions,
  getReportById,
  getTransactionsByReport,
  insertLayerAnalysis,
  insertLienRecord,
  updateLienStatus,
  insertDraftEmail,
  insertAuditLog,
  upsertRepeatAccount,
  updateTransactionCashout,
} = require('../db/queries');

let db;
let reportId;

beforeAll(() => {
  db = initializeDatabase(':memory:');
  reportId = insertReport(db, {
    filename: 'q.xlsx', original_filename: 'q.xlsx',
    upload_date: new Date().toISOString(),
  });
  // Seed a small mixed dataset.
  insertManyTransactions(db, [
    {
      report_id: reportId, ack_no: 'A1',
      beneficiary_account: 'B1', beneficiary_bank: 'HDFC',
      transaction_date: '2024-01-15T05:00:00.000Z', transaction_amount: 1000,
      payment_mode: 'IMPS', layer_no: 1, state: 'Maharashtra',
    },
    {
      report_id: reportId, ack_no: 'A1',
      beneficiary_account: 'B2', beneficiary_bank: 'ICICI',
      transaction_date: '2024-01-16T05:00:00.000Z', transaction_amount: 5000,
      payment_mode: 'NEFT', layer_no: 2, state: 'Karnataka',
    },
    {
      report_id: reportId, ack_no: 'A1',
      beneficiary_account: 'B3', beneficiary_bank: 'SBI',
      transaction_date: '2024-01-17T05:00:00.000Z', transaction_amount: 50000,
      payment_mode: 'ATM', layer_no: 3, atm_id: 'ATM1', city: 'Delhi', state: 'Delhi',
    },
  ]);
});

afterAll(() => {
  try { db.close(); } catch (_e) { /* best effort */ }
});

// ─── getTransactionsByReport with filters ────────────────────────────

describe('getTransactionsByReport', () => {
  test('no filters → returns every transaction', () => {
    const res = getTransactionsByReport(db, reportId);
    expect(res.items.length).toBe(3);
    expect(res.total).toBe(3);
    expect(res.pageCount).toBe(1);
  });

  test('filter by layer_no', () => {
    const res = getTransactionsByReport(db, reportId, { layer_no: 2 });
    expect(res.items.length).toBe(1);
    expect(res.items[0].beneficiary_account).toBe('B2');
  });

  test('filter by beneficiary_bank', () => {
    const res = getTransactionsByReport(db, reportId, { beneficiary_bank: 'HDFC' });
    expect(res.items.length).toBe(1);
    expect(res.items[0].beneficiary_account).toBe('B1');
  });

  test('filter by date range', () => {
    const res = getTransactionsByReport(db, reportId, {
      date_from: '2024-01-16T00:00:00.000Z',
      date_to: '2024-01-16T23:59:59.000Z',
    });
    expect(res.items.length).toBe(1);
    expect(res.items[0].beneficiary_account).toBe('B2');
  });

  test('filter by amount range', () => {
    const res = getTransactionsByReport(db, reportId, {
      amount_min: 4000,
      amount_max: 10000,
    });
    expect(res.items.length).toBe(1);
    expect(res.items[0].beneficiary_account).toBe('B2');
  });

  test('cashout_only flag keeps ATM / POS rows', () => {
    const res = getTransactionsByReport(db, reportId, { cashout_only: true });
    expect(res.items.length).toBe(1);
    expect(res.items[0].payment_mode).toBe('ATM');
  });

  test('pagination caps and offsets', () => {
    const res = getTransactionsByReport(db, reportId, {}, 2, 2);
    expect(res.page).toBe(2);
    expect(res.limit).toBe(2);
    expect(res.items.length).toBe(1); // only one row on page 2
  });

  test('rejects a non-positive-integer reportId', () => {
    expect(() => getTransactionsByReport(db, 0)).toThrow();
    expect(() => getTransactionsByReport(db, -1)).toThrow();
  });
});

// ─── helper-side branch coverage ─────────────────────────────────────

describe('helper edge cases', () => {
  test('updateTransactionCashout patches the two derived columns', () => {
    const id = insertTransaction(db, {
      report_id: reportId, ack_no: 'A1',
      beneficiary_account: 'X', payment_mode: 'IMPS', layer_no: 1,
      transaction_amount: 10, transaction_date: '2024-02-01T00:00:00.000Z',
    });
    const changed = updateTransactionCashout(db, id, {
      same_day_cashout: true, cashout_mode: 'ATM_WITHDRAWAL',
    });
    expect(changed).toBe(1);
    const row = db.prepare('SELECT * FROM ncrp_transactions WHERE id = ?').get(id);
    expect(row.same_day_cashout).toBe(1);
    expect(row.cashout_mode).toBe('ATM_WITHDRAWAL');
  });

  test('updateTransactionCashout coerces missing patch to null/0', () => {
    const id = insertTransaction(db, {
      report_id: reportId, ack_no: 'A1',
      beneficiary_account: 'Y', payment_mode: 'IMPS', layer_no: 1,
      transaction_amount: 1, transaction_date: '2024-02-02T00:00:00.000Z',
    });
    updateTransactionCashout(db, id, {});
    const row = db.prepare('SELECT * FROM ncrp_transactions WHERE id = ?').get(id);
    expect(row.same_day_cashout).toBe(0);
    expect(row.cashout_mode).toBeNull();
  });

  test('insertLienRecord + updateLienStatus stamp applied_date', () => {
    const lienId = insertLienRecord(db, {
      report_id: reportId, account_no: 'L-1',
      bank_name: 'X', ifsc_code: 'XYZ', lien_amount: 999, lien_status: 'pending',
    });
    expect(lienId).toBeGreaterThan(0);
    const before = db.prepare('SELECT * FROM lien_records WHERE id = ?').get(lienId);
    expect(before.applied_date).toBeNull();

    updateLienStatus(db, lienId, 'applied');
    const after = db.prepare('SELECT * FROM lien_records WHERE id = ?').get(lienId);
    expect(after.lien_status).toBe('applied');
    expect(after.applied_date).not.toBeNull();
  });

  test('updateLienStatus rejects an invalid enum value', () => {
    expect(() => updateLienStatus(db, 1, 'hacked')).toThrow(RangeError);
  });

  test('insertDraftEmail JSON-stringifies an array account_list', () => {
    const id = insertDraftEmail(db, {
      report_id: reportId, bank_name: 'TestBank',
      subject: 'subj', body: 'body',
      account_list: ['A', 'B', 'C'],
    });
    const row = db.prepare('SELECT * FROM draft_emails WHERE id = ?').get(id);
    expect(JSON.parse(row.account_list)).toEqual(['A', 'B', 'C']);
  });

  test('insertAuditLog accepts an object details payload', () => {
    const id = insertAuditLog(db, {
      report_id: reportId, action: 'test.action', details: { foo: 'bar' },
    });
    const row = db.prepare('SELECT * FROM audit_log WHERE id = ?').get(id);
    expect(JSON.parse(row.details)).toEqual({ foo: 'bar' });
  });

  test('upsertRepeatAccount inserts then increments on second call', () => {
    upsertRepeatAccount(db, {
      account_no: 'REP-1', bank_name: 'Z', amount_passed: 100, mule_score: 50,
    });
    upsertRepeatAccount(db, {
      account_no: 'REP-1', bank_name: 'Z', amount_passed: 200, mule_score: 70,
    });
    const row = db.prepare('SELECT * FROM repeat_accounts WHERE account_no = ?').get('REP-1');
    expect(row.appearance_count).toBe(2);
    expect(row.total_amount_passed).toBe(300);
    expect(row.mule_score).toBe(70);
  });

  test('insertLayerAnalysis is idempotent on (report_id, layer_no)', () => {
    insertLayerAnalysis(db, { report_id: reportId, layer_no: 7, account_count: 1 });
    insertLayerAnalysis(db, { report_id: reportId, layer_no: 7, account_count: 5 });
    const row = db
      .prepare('SELECT * FROM layer_analysis WHERE report_id = ? AND layer_no = ?')
      .get(reportId, 7);
    expect(row.account_count).toBe(5);
  });

  test('getReportById returns the seeded row', () => {
    const row = getReportById(db, reportId);
    expect(row).toBeDefined();
    expect(row.id).toBe(reportId);
  });
});
