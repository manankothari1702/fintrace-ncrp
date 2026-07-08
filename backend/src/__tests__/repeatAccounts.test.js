'use strict';

/**
 * repeat_accounts registry — contribution-ledger correctness.
 *
 * The registry was rebuilt around repeat_account_reports (one row per
 * canonical account per report) after an audit found three bookkeeping bugs
 * in the legacy increment-on-upsert design:
 *   1. re-analysing a report inflated appearance_count / total_amount_passed;
 *   2. keys were raw display strings, so zero-padded variants of one account
 *      split into two registry rows (and never matched the analyzer rollup);
 *   3. deleting a report left its contributions orphaned in the aggregates.
 *
 * These tests pin the fixed behaviour: idempotent replace, canonical keys,
 * withdrawal on delete, and the one-time legacy rebuild migration.
 */

const { initializeDatabase, rebuildRepeatRegistryFromSnapshots } = require('../db/schema');
const {
  insertReport,
  replaceReportRepeatContributions,
  removeReportRepeatContributions,
} = require('../db/queries');

let db;
let reportA;
let reportB;

const aggregate = (accountNo) =>
  db.prepare('SELECT * FROM repeat_accounts WHERE account_no = ?').get(accountNo);
const aggregateCount = () =>
  db.prepare('SELECT COUNT(*) AS n FROM repeat_accounts').get().n;
const ledgerRows = (reportId) =>
  db.prepare('SELECT * FROM repeat_account_reports WHERE report_id = ? ORDER BY account_no').all(reportId);

beforeEach(() => {
  db = initializeDatabase(':memory:');
  reportA = insertReport(db, {
    filename: 'a.xlsx', original_filename: 'a.xlsx',
    upload_date: new Date().toISOString(),
  });
  reportB = insertReport(db, {
    filename: 'b.xlsx', original_filename: 'b.xlsx',
    upload_date: new Date().toISOString(),
  });
});

afterEach(() => {
  try { db.close(); } catch (_e) { /* best effort */ }
});

describe('replaceReportRepeatContributions — idempotent re-analysis', () => {
  test('re-running the same report does not inflate counts or amounts', () => {
    const mules = [
      { account_no: 'ACC-1', bank_name: 'HDFC', amount_passed: 5000, mule_score: 60 },
    ];
    replaceReportRepeatContributions(db, reportA, mules);
    replaceReportRepeatContributions(db, reportA, mules); // simulated re-analysis
    replaceReportRepeatContributions(db, reportA, mules); // and again

    const row = aggregate('ACC-1');
    expect(row.appearance_count).toBe(1);
    expect(row.total_amount_passed).toBe(5000);
    expect(row.mule_score).toBe(60);
    expect(row.first_seen_report_id).toBe(reportA);
  });

  test('re-analysis with CHANGED figures replaces, never accumulates', () => {
    replaceReportRepeatContributions(db, reportA, [
      { account_no: 'ACC-1', amount_passed: 5000, mule_score: 90 },
    ]);
    replaceReportRepeatContributions(db, reportA, [
      { account_no: 'ACC-1', amount_passed: 3000, mule_score: 40 },
    ]);

    const row = aggregate('ACC-1');
    expect(row.appearance_count).toBe(1);
    expect(row.total_amount_passed).toBe(3000); // replaced, not 8000
    expect(row.mule_score).toBe(40);            // replaced, not lifted to 90
  });

  test('an account dropped by re-analysis is withdrawn from the aggregates', () => {
    replaceReportRepeatContributions(db, reportA, [
      { account_no: 'ACC-1', amount_passed: 1000, mule_score: 50 },
      { account_no: 'ACC-2', amount_passed: 2000, mule_score: 30 },
    ]);
    // Re-analysis no longer flags ACC-2 (e.g. thresholds changed).
    replaceReportRepeatContributions(db, reportA, [
      { account_no: 'ACC-1', amount_passed: 1000, mule_score: 50 },
    ]);

    expect(aggregate('ACC-1')).toBeTruthy();
    expect(aggregate('ACC-2')).toBeUndefined();
    expect(ledgerRows(reportA)).toHaveLength(1);
  });

  test('two reports containing the same account count as 2 — and stay 2 across re-analyses', () => {
    replaceReportRepeatContributions(db, reportA, [
      { account_no: 'ACC-1', amount_passed: 1000, mule_score: 50 },
    ]);
    replaceReportRepeatContributions(db, reportB, [
      { account_no: 'ACC-1', amount_passed: 500, mule_score: 80 },
    ]);
    replaceReportRepeatContributions(db, reportB, [
      { account_no: 'ACC-1', amount_passed: 500, mule_score: 80 },
    ]); // re-analysis of B

    const row = aggregate('ACC-1');
    expect(row.appearance_count).toBe(2);
    expect(row.total_amount_passed).toBe(1500);
    expect(row.mule_score).toBe(80);            // MAX across reports
    expect(row.first_seen_report_id).toBe(reportA);
  });

  test('rejects a non-positive reportId', () => {
    expect(() => replaceReportRepeatContributions(db, 0, [])).toThrow(TypeError);
    expect(() => replaceReportRepeatContributions(db, -3, [])).toThrow(TypeError);
  });
});

describe('canonical account keys', () => {
  test('zero-padded and bare variants across reports are ONE account', () => {
    replaceReportRepeatContributions(db, reportA, [
      { account_no: '00044021519366', amount_passed: 1000, mule_score: 40 },
    ]);
    replaceReportRepeatContributions(db, reportB, [
      { account_no: '44021519366', amount_passed: 2000, mule_score: 70 },
    ]);

    expect(aggregateCount()).toBe(1);
    const row = aggregate('44021519366'); // canonical: leading zeros stripped
    expect(row.appearance_count).toBe(2);
    expect(row.total_amount_passed).toBe(3000);
    expect(row.mule_score).toBe(70);
  });

  test('two display variants WITHIN one report fold into one contribution', () => {
    replaceReportRepeatContributions(db, reportA, [
      { account_no: '007', bank_name: null, amount_passed: 100, mule_score: 20 },
      { account_no: '7', bank_name: 'SBI', amount_passed: 200, mule_score: 90 },
    ]);

    const rows = ledgerRows(reportA);
    expect(rows).toHaveLength(1);
    expect(rows[0].account_no).toBe('7');
    expect(rows[0].amount_passed).toBe(300); // summed
    expect(rows[0].mule_score).toBe(90);     // max
    expect(rows[0].bank_name).toBe('SBI');   // first non-null wins
    expect(aggregate('7').appearance_count).toBe(1);
  });

  test('non-numeric identifiers stay verbatim and case-sensitive (never wrongly merged)', () => {
    replaceReportRepeatContributions(db, reportA, [
      { account_no: 'NA', amount_passed: 10, mule_score: 1 },
      { account_no: 'Na', amount_passed: 20, mule_score: 2 },
    ]);
    expect(ledgerRows(reportA)).toHaveLength(2);
    expect(aggregate('NA')).toBeTruthy();
    expect(aggregate('Na')).toBeTruthy();
  });

  test('blank / null account numbers are skipped, not inserted', () => {
    const res = replaceReportRepeatContributions(db, reportA, [
      { account_no: '', amount_passed: 10, mule_score: 1 },
      { account_no: null, amount_passed: 20, mule_score: 2 },
      { account_no: '  ', amount_passed: 30, mule_score: 3 },
    ]);
    expect(res.accounts).toBe(0);
    expect(ledgerRows(reportA)).toHaveLength(0);
  });
});

describe('removeReportRepeatContributions — report deletion cleanup', () => {
  test('deleting one contributing report decrements the shared account', () => {
    replaceReportRepeatContributions(db, reportA, [
      { account_no: 'ACC-1', amount_passed: 1000, mule_score: 50 },
    ]);
    replaceReportRepeatContributions(db, reportB, [
      { account_no: 'ACC-1', amount_passed: 500, mule_score: 80 },
    ]);

    const removed = removeReportRepeatContributions(db, reportB);
    expect(removed).toBe(1);

    const row = aggregate('ACC-1');
    expect(row.appearance_count).toBe(1);
    expect(row.total_amount_passed).toBe(1000);
    expect(row.mule_score).toBe(50);            // B's higher score withdrawn
    expect(row.first_seen_report_id).toBe(reportA);
  });

  test('deleting the ONLY contributing report removes the aggregate row entirely', () => {
    replaceReportRepeatContributions(db, reportA, [
      { account_no: 'ACC-1', amount_passed: 1000, mule_score: 50 },
      { account_no: 'ACC-2', amount_passed: 2000, mule_score: 30 },
    ]);

    const removed = removeReportRepeatContributions(db, reportA);
    expect(removed).toBe(2);
    expect(aggregateCount()).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM repeat_account_reports').get().n).toBe(0);
  });

  test('removing a report with no contributions is a harmless no-op', () => {
    expect(removeReportRepeatContributions(db, reportB)).toBe(0);
  });
});

describe('rebuildRepeatRegistryFromSnapshots — one-time legacy migration', () => {
  /** Simulate a pre-ledger database: legacy inflated/raw-keyed aggregates. */
  const insertLegacyAggregate = (accountNo, count, amount, score) => {
    db.prepare(`
      INSERT INTO repeat_accounts
        (account_no, appearance_count, total_amount_passed, mule_score)
      VALUES (?, ?, ?, ?)
    `).run(accountNo, count, amount, score);
  };
  const setSnapshot = (reportId, muleDetection) => {
    db.prepare(`
      UPDATE ncrp_reports
         SET analysis_status = 'complete', analysis_json = ?
       WHERE id = ?
    `).run(JSON.stringify({ mule_detection: muleDetection }), reportId);
  };

  test('rebuilds canonical, deduplicated aggregates from stored analysis_json', () => {
    // Legacy state: same physical account split across two raw keys, counts
    // inflated by historical re-analyses; plus a stale orphan row.
    insertLegacyAggregate('00044021519366', 7, 99999, 95);
    insertLegacyAggregate('44021519366', 3, 12345, 40);
    insertLegacyAggregate('ORPHAN-OLD', 5, 555, 10);
    setSnapshot(reportA, [
      { account_no: '00044021519366', bank_name: 'HDFC', total_received: 5000, mule_score: 60 },
    ]);
    setSnapshot(reportB, [
      { account_no: '44021519366', bank_name: 'HDFC', total_received: 2500, mule_score: 75 },
    ]);

    rebuildRepeatRegistryFromSnapshots(db);

    expect(aggregateCount()).toBe(1); // orphan dropped, variants merged
    const row = aggregate('44021519366');
    expect(row.appearance_count).toBe(2);
    expect(row.total_amount_passed).toBe(7500);
    expect(row.mule_score).toBe(75);
    expect(row.first_seen_report_id).toBe(reportA);
  });

  test('guard: never runs once the ledger is populated', () => {
    replaceReportRepeatContributions(db, reportA, [
      { account_no: 'ACC-1', amount_passed: 100, mule_score: 10 },
    ]);
    insertLegacyAggregate('STALE-ROW', 9, 999, 99);
    setSnapshot(reportB, [
      { account_no: 'STALE-ROW', total_received: 1, mule_score: 1 },
    ]);

    rebuildRepeatRegistryFromSnapshots(db);

    // Untouched: STALE-ROW keeps its legacy figures because the guard saw a
    // non-empty ledger and skipped the rebuild.
    expect(aggregate('STALE-ROW').appearance_count).toBe(9);
    expect(ledgerRows(reportB)).toHaveLength(0);
  });

  test('guard: no-op on a fresh database (nothing legacy to rebuild)', () => {
    expect(() => rebuildRepeatRegistryFromSnapshots(db)).not.toThrow();
    expect(aggregateCount()).toBe(0);
  });

  test('malformed analysis_json is skipped; other reports still rebuild', () => {
    insertLegacyAggregate('ACC-1', 4, 4444, 44);
    db.prepare(`
      UPDATE ncrp_reports SET analysis_status = 'complete', analysis_json = '{not json'
       WHERE id = ?
    `).run(reportA);
    setSnapshot(reportB, [
      { account_no: 'ACC-1', total_received: 800, mule_score: 55 },
    ]);

    rebuildRepeatRegistryFromSnapshots(db);

    const row = aggregate('ACC-1');
    expect(row.appearance_count).toBe(1);      // only report B backs it now
    expect(row.total_amount_passed).toBe(800);
  });
});
