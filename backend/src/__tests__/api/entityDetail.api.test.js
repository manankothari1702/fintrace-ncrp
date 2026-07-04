'use strict';

/**
 * Integration tests for the Row Drill-Down Modal entity endpoints:
 *
 *   GET /api/ncrp/:id/entity/:type          (Phase A: account)
 *   GET /api/ncrp/:id/entity/:type/excel
 *
 * Parity contract under test: the payload's roll-ups must EQUAL the analysis
 * snapshot's own per-account figures (never a re-derivation), and the detail
 * rows must be exactly the ledger legs where the account is a party. The Excel
 * export must contain exactly the rows the modal's search filter would show.
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const XLSX = require('xlsx');

const { initializeDatabase } = require('../../db/schema');
const { createApp } = require('../../server');
const { makeTestXlsx, buildStandardRows } = require('../helpers/xlsx');
const { filterRows, canonAcct } = require('../../utils/entityDetail');

async function waitForAnalysis(agent, reportId, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await agent.get(`/api/ncrp/${reportId}`);
    if (res.status === 200) {
      const status = res.body && res.body.analysis_status;
      if (status === 'complete' || status === 'error') return res.body;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`analysis did not complete for report ${reportId} within ${timeoutMs}ms`);
}

let db;
let app;
let agent;
let reportId;
let report;

beforeAll(async () => {
  db = initializeDatabase(':memory:');
  app = createApp(db);
  agent = request(app);

  const buf = makeTestXlsx(buildStandardRows());
  const res = await agent.post('/api/ncrp/upload').attach('ncrpFile', buf, 'sample_ncrp.xlsx');
  expect(res.status).toBe(202);
  reportId = res.body.reportId;
  report = await waitForAnalysis(agent, reportId);
  expect(report.analysis_status).toBe('complete');
});

afterAll(() => {
  try { db.close(); } catch (_e) { /* best effort */ }
});

// ─── Helpers under test (shared client/server search + canonical key) ─

describe('entityDetail helpers', () => {
  test('canonAcct strips leading zeros from all-digit ids only', () => {
    expect(canonAcct('0001234')).toBe('1234');
    expect(canonAcct('1234')).toBe('1234');
    expect(canonAcct(' M0003 ')).toBe('M0003'); // non-numeric: trim only
    expect(canonAcct(null)).toBe('');
  });

  test('filterRows matches case-insensitive substrings over the searchable fields only', () => {
    const rows = [
      { utr: 'UTR0001', bank: 'ICICI Bank', secret: 'findme' },
      { utr: 'UTR0002', bank: 'SBI', secret: null },
    ];
    expect(filterRows(rows, ['utr', 'bank'], 'icici')).toHaveLength(1);
    expect(filterRows(rows, ['utr', 'bank'], 'UTR000')).toHaveLength(2);
    expect(filterRows(rows, ['utr', 'bank'], 'findme')).toHaveLength(0); // field not searchable
    expect(filterRows(rows, ['utr', 'bank'], '')).toHaveLength(2);
    expect(filterRows(rows, ['utr', 'bank'], null)).toHaveLength(2);
  });
});

// ─── GET /api/ncrp/:id/entity/account ────────────────────────────────

describe('GET /api/ncrp/:id/entity/account', () => {
  test('returns every ledger leg where the account is a party, chronological', async () => {
    // M0003 receives the L3 transfer + 2 ATM legs and never sends: 3 rows, all IN.
    const res = await agent.get(`/api/ncrp/${reportId}/entity/account?id=M0003`);
    expect(res.status).toBe(200);
    expect(res.body.entity_type).toBe('account');
    expect(res.body.entity_id).toBe('M0003');
    expect(res.body.rows).toHaveLength(3);
    expect(res.body.rows.every((r) => r.direction === 'in')).toBe(true);
    expect(res.body.rows.every((r) => r.counterparty === 'M0002')).toBe(true);
    const dates = res.body.rows.map((r) => r.date);
    expect([...dates].sort()).toEqual(dates); // backend serves date-ASC
    expect(res.body.summary.row_count).toBe(3);
    expect(Array.isArray(res.body.searchable)).toBe(true);
    expect(res.body.searchable).toContain('utr');
  });

  test('a mid-trail account carries both directions', async () => {
    // M0002: 1 inbound (M0001→M0002) + 3 outbound (transfer + 2 ATM legs).
    const res = await agent.get(`/api/ncrp/${reportId}/entity/account?id=M0002`);
    expect(res.status).toBe(200);
    const dirs = res.body.rows.map((r) => r.direction);
    expect(dirs.filter((d) => d === 'in')).toHaveLength(1);
    expect(dirs.filter((d) => d === 'out')).toHaveLength(3);
  });

  test('summary roll-ups EQUAL the analysis snapshot values (no re-derivation)', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/entity/account?id=M0003`);
    expect(res.status).toBe(200);
    const mule = (report.analysis_json.mule_detection || [])
      .find((m) => m.account_no === 'M0003');
    expect(mule).toBeDefined();
    expect(res.body.summary.total_received).toBe(mule.total_received);
    expect(res.body.summary.disputed_received).toBe(mule.disputed_received ?? null);
    expect(res.body.summary.total_cashout).toBe(mule.total_cashout);
    expect(res.body.context.mule_score).toBe(mule.mule_score);
    expect(res.body.context.risk_label).toBe(mule.risk_label);
    expect(res.body.notes).toEqual(mule.suspicion_reasons || []);

    const lien = (report.analysis_json.lien_calculation || [])
      .find((l) => l.account_no === 'M0003');
    if (lien) {
      expect(res.body.summary.lien_eligible_amount).toBe(lien.lien_eligible_amount);
      expect(res.body.summary.total_on_hold).toBe(lien.total_on_hold ?? null);
    } else {
      expect(res.body.summary.lien_eligible_amount).toBeNull();
    }
  });

  test('a victim (layer-0) account reads amount_sent from victim_accounts', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/entity/account?id=V0001`);
    expect(res.status).toBe(200);
    const victim = (report.analysis_json.victim_accounts || [])
      .find((v) => v.account_no === 'V0001');
    expect(victim).toBeDefined();
    expect(res.body.context.is_victim).toBe(true);
    expect(res.body.summary.amount_sent).toBe(victim.amount_sent);
    expect(res.body.rows.every((r) => r.direction === 'out')).toBe(true);
  });

  test('an account with no ledger rows returns an empty row set (not an error)', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/entity/account?id=NO_SUCH_ACCT`);
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([]);
    expect(res.body.summary.row_count).toBe(0);
    expect(res.body.summary.total_received).toBeNull();
  });

  test('validation: unknown entity type → 400, missing id → 400, bad report → 404', async () => {
    const badType = await agent.get(`/api/ncrp/${reportId}/entity/starship?id=M0003`);
    expect(badType.status).toBe(400);
    expect(badType.body.error.code).toBe('VALIDATION_FAILED');

    const noId = await agent.get(`/api/ncrp/${reportId}/entity/account`);
    expect(noId.status).toBe(400);

    const noReport = await agent.get('/api/ncrp/999999/entity/account?id=M0003');
    expect(noReport.status).toBe(404);
  });
});

// ─── GET /api/ncrp/:id/entity/account/excel ──────────────────────────

describe('GET /api/ncrp/:id/entity/account/excel', () => {
  test('streams a real workbook whose Rows sheet holds every ledger leg', async () => {
    const res = await agent
      .get(`/api/ncrp/${reportId}/entity/account/excel?id=M0003`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    // XLSX magic bytes (ZIP container).
    expect(res.body[0]).toBe(0x50);
    expect(res.body[1]).toBe(0x4b);

    const wb = XLSX.read(res.body, { type: 'buffer' });
    expect(wb.SheetNames).toContain('Drill-Down Summary');
    expect(wb.SheetNames).toContain('Rows');
    const rows = XLSX.utils.sheet_to_json(wb.Sheets.Rows, { header: 1, blankrows: false });
    expect(rows).toHaveLength(1 + 3); // header + M0003's 3 legs
    expect(rows[0]).toContain('Counterparty A/C');
  });

  test('?search= exports exactly the filtered view (modal parity)', async () => {
    // Only the two ATM legs carry mode "ATM".
    const res = await agent
      .get(`/api/ncrp/${reportId}/entity/account/excel?id=M0003&search=atm`)
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    expect(res.status).toBe(200);
    const wb = XLSX.read(res.body, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(wb.Sheets.Rows, { header: 1, blankrows: false });
    expect(rows).toHaveLength(1 + 2);
  });

  test('?mode=file writes to EXPORTS_DIR and returns { fileName }', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/entity/account/excel?id=M0003&mode=file`);
    expect(res.status).toBe(200);
    expect(res.body.fileName).toMatch(/^FinTrace-Drilldown-account-.*\.xlsx$/);
  });
});
