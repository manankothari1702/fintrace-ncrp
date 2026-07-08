'use strict';

/**
 * Integration tests for backend/src/routes/ncrp.js.
 *
 * Drives the Express app via supertest against an in-memory SQLite database,
 * so every endpoint touches real persistence, real parsing, and the real
 * background-analysis pipeline — only the filesystem destinations are shared.
 *
 * The analysis runs in a setImmediate after POST /upload returns. Tests that
 * need analysis output (mules, lien, emails) poll the report until its
 * analysis_status flips to 'complete'.
 */

// Must be set before requiring server.js — see the routes for the snapshot.
process.env.NODE_ENV = 'test';

const request = require('supertest');

const { initializeDatabase } = require('../../db/schema');
const { createApp } = require('../../server');
const { makeTestXlsx, buildStandardRows } = require('../helpers/xlsx');

/**
 * Poll the report until its analysis_status leaves 'pending'/'processing'.
 *
 * @param {import('supertest').SuperTest<request.Test>} agent
 * @param {number} reportId
 * @param {number} [timeoutMs=8000]
 */
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

beforeAll(() => {
  db = initializeDatabase(':memory:');
  app = createApp(db);
  agent = request(app);
});

afterAll(() => {
  try { db.close(); } catch (_e) { /* best effort */ }
});

// ─── Health + empty-list endpoints ───────────────────────────────────

describe('GET /api/health', () => {
  test('returns 200 + { status: "ok" }', async () => {
    const res = await agent.get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.timestamp).toEqual(expect.any(String));
  });
});

describe('GET /api/ncrp/reports (empty)', () => {
  test('returns 200 + empty array before any uploads', async () => {
    // Fresh DB per file (Jest runs files in isolated workers) — list is empty.
    const res = await agent.get('/api/ncrp/reports');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([]);
  });
});

// ─── Upload → analysis → fetch flow ──────────────────────────────────

describe('POST /api/ncrp/upload + full analysis flow', () => {
  /** @type {number} */
  let reportId;

  test('uploading a valid NCRP Excel returns 202 + reportId', async () => {
    const buf = makeTestXlsx(buildStandardRows());
    const res = await agent
      .post('/api/ncrp/upload')
      .attach('ncrpFile', buf, 'sample_ncrp.xlsx');

    expect(res.status).toBe(202);
    expect(res.body.reportId).toEqual(expect.any(Number));
    expect(res.body.rowCount).toBeGreaterThan(0);
    expect(Array.isArray(res.body.warnings)).toBe(true);
    reportId = res.body.reportId;
  });

  test('GET /api/ncrp/:id returns the report once analysis completes', async () => {
    const report = await waitForAnalysis(agent, reportId);
    expect(report.id).toBe(reportId);
    expect(report.analysis_status).toBe('complete');
    expect(report.total_transactions).toBeGreaterThan(0);
    // analysis_json is parsed back to an object server-side.
    expect(report.analysis_json).toEqual(expect.any(Object));
    expect(Array.isArray(report.analysis_json.key_findings)).toBe(true);
  });

  test('GET /api/ncrp/:id/transactions returns paginated rows', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/transactions`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.total).toBeGreaterThan(0);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBeGreaterThan(0);
  });

  test('GET /api/ncrp/:id/transactions?layer=2 returns only layer-2 rows', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/transactions?layer=2`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) {
      expect(row.layer_no).toBe(2);
    }
  });

  test('GET /api/ncrp/:id/transactions?sort=transaction_amount&dir=asc sorts ascending', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/transactions?sort=transaction_amount&dir=asc&limit=200`);
    expect(res.status).toBe(200);
    const amts = res.body.data.map((r) => Number(r.transaction_amount));
    for (let i = 1; i < amts.length; i += 1) {
      expect(amts[i]).toBeGreaterThanOrEqual(amts[i - 1]);
    }
  });

  test('GET /api/ncrp/:id/transactions with an unknown sort key falls back to default order (no error)', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/transactions?sort=DROP TABLE&dir=asc`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });

  // Exact-match filters (2026-07 audit, finding 2b): previously only reachable
  // through a dead query helper; now first-class route params.

  test('GET /api/ncrp/:id/transactions?beneficiary_account=M0002 matches exactly', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/transactions?beneficiary_account=M0002`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) {
      expect(row.beneficiary_account).toBe('M0002');
    }
  });

  test('beneficiary_account is exact, not substring (prefix must NOT match)', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/transactions?beneficiary_account=M000`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
  });

  test('GET /api/ncrp/:id/transactions?state=Maharashtra filters by state', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/transactions?state=Maharashtra`);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) {
      expect(row.state).toBe('Maharashtra');
    }
  });

  test('GET /api/ncrp/:id/transactions?city=Delhi filters by city and combines with state', async () => {
    const res = await agent
      .get(`/api/ncrp/${reportId}/transactions`)
      .query({ city: 'Delhi', state: 'Delhi' });
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    for (const row of res.body.data) {
      expect(row.city).toBe('Delhi');
      expect(row.state).toBe('Delhi');
    }
  });

  test('POST /api/ncrp/:id/lien creates a lien record for a new account', async () => {
    const res = await agent
      .post(`/api/ncrp/${reportId}/lien`)
      .send({ account_no: 'NEW-LIEN-1', lien_status: 'pending', remarks: 'note' });

    // 201 for a new record (we picked an account that was not in the fixture
    // lien worksheet under this name).
    expect([200, 201]).toContain(res.status);
    expect(res.body.account_no).toBe('NEW-LIEN-1');
    expect(res.body.lien_status).toBe('pending');
  });

  test('POST /api/ncrp/:id/lien updates an existing lien record', async () => {
    // Second call on the same account → update path (status flip + remarks).
    const res = await agent
      .post(`/api/ncrp/${reportId}/lien`)
      .send({ account_no: 'NEW-LIEN-1', lien_status: 'applied', remarks: 'updated' });
    expect(res.status).toBe(200);
    expect(res.body.lien_status).toBe('applied');
    expect(res.body.remarks).toBe('updated');
  });

  test('GET /api/ncrp/:id/layers returns persisted layer aggregates', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/layers`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toEqual(expect.objectContaining({
      layer_no: expect.any(Number),
      account_count: expect.any(Number),
    }));
  });

  test('GET /api/ncrp/:id/mules returns the mule detection snapshot', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/mules`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/ncrp/:id/lien returns the lien worksheet', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/lien`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/ncrp/:id/emails returns letters + non-actionable sections', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/emails`);
    expect(res.status).toBe(200);
    // New payload shape: { emails, wallet_instruments, masked_accounts }.
    expect(res.body).toEqual(expect.objectContaining({
      emails: expect.any(Array),
      wallet_instruments: expect.any(Array),
      masked_accounts: expect.any(Array),
    }));
    if (res.body.emails.length > 0) {
      expect(res.body.emails[0]).toEqual(expect.objectContaining({
        bank_name: expect.any(String),
        subject: expect.any(String),
        body: expect.any(String),
        status: 'draft',
      }));
      expect(Array.isArray(res.body.emails[0].account_list)).toBe(true);
      expect(Array.isArray(res.body.emails[0].flagged_accounts)).toBe(true);
      // Letters carry no baked-in date (injected at render/copy/export time).
      expect(res.body.emails[0].body).not.toMatch(/^Date:/m);
    }
  });

  test('GET /api/ncrp/:id/timeline returns the timeline snapshot', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/timeline`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /api/ncrp/:id/geography returns by_state + by_city', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/geography`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({
      by_state: expect.any(Array),
      by_city: expect.any(Array),
    }));
  });

  test('GET /api/ncrp/:id/audit returns audit log rows', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/audit`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    // The upload + analysis pipeline writes at least one audit entry.
    const actions = res.body.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['upload.ingested']));
  });

  test('GET /api/ncrp/:id/pdf streams a PDF file > 10 KB', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/pdf`).buffer().parse((r, cb) => {
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.length).toBeGreaterThan(10 * 1024);
    // PDFs start with the literal "%PDF-" magic.
    expect(res.body.slice(0, 5).toString('ascii')).toBe('%PDF-');
  });

  test('POST /api/ncrp/:id/emails/:emailId updates the email status', async () => {
    const list = await agent.get(`/api/ncrp/${reportId}/emails`);
    if (list.body.emails.length === 0) {
      // No actionable letters generated for this fixture → nothing to update.
      return;
    }
    const target = list.body.emails[0];
    const res = await agent
      .post(`/api/ncrp/${reportId}/emails/${target.id}`)
      .send({ status: 'sent' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sent');
  });

  test('GET /api/ncrp/:id/transactions with multi-filter combo', async () => {
    // Layer + payment_mode + amount range + search — exercises every filter
    // branch in the listing route.
    const res = await agent
      .get(`/api/ncrp/${reportId}/transactions`)
      .query({
        layer: '1,2',
        payment_mode: 'IMPS',
        min_amount: 1,
        max_amount: 1000000,
        search: 'M',
        page: 1,
        limit: 10,
      });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.page).toBe(1);
    expect(res.body.limit).toBe(10);
  });

  test('GET /api/ncrp/:id/transactions with invalid page → 400', async () => {
    const res = await agent.get(`/api/ncrp/${reportId}/transactions?page=0`);
    expect(res.status).toBe(400);
  });

  test('DELETE /api/ncrp/:id cascades transactions away', async () => {
    const del = await agent.delete(`/api/ncrp/${reportId}`);
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);
    expect(del.body.id).toBe(reportId);
    expect(del.body.removed).toEqual(expect.objectContaining({
      transactions: expect.any(Number),
    }));
    expect(del.body.removed.transactions).toBeGreaterThan(0);

    // Subsequent fetch must 404 — report and its rows are gone.
    const after = await agent.get(`/api/ncrp/${reportId}`);
    expect(after.status).toBe(404);

    // Direct DB read of transactions for the deleted report → zero rows.
    const remaining = db
      .prepare('SELECT COUNT(*) AS n FROM ncrp_transactions WHERE report_id = ?')
      .get(reportId).n;
    expect(remaining).toBe(0);
  });
});

// ─── 404 / not-found paths ───────────────────────────────────────────

describe('404 handling', () => {
  test('GET /api/ncrp/999 → 404 COMPLAINT_NOT_FOUND', async () => {
    const res = await agent.get('/api/ncrp/999');
    expect(res.status).toBe(404);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'COMPLAINT_NOT_FOUND' }),
    }));
  });
});
