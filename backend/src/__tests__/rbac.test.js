'use strict';

/**
 * RBAC tests (Phase 1 Sub-step C).
 *
 * Verifies the role→permission map (lib/roles.js) is actually enforced on the
 * live routes via the requireAuth + requirePermission choke-point, and that the
 * audit log now records WHO acted. Every request authenticates through the REAL
 * login path (helpers/auth) — auth is never bypassed.
 */

process.env.NODE_ENV = 'test';

const request = require('supertest');
const { initializeDatabase } = require('../db/schema');
const { createApp } = require('../server');
const { ROLES } = require('../lib/roles');
const { makeTestXlsx, buildStandardRows } = require('./helpers/xlsx');
const { loginAs, authed } = require('./helpers/auth');

let db;
let app;
let admin; let io; let sho; let deo;
let reportId;

async function waitForAnalysis(agent, id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await agent.get(`/api/ncrp/${id}`);
    if (res.status === 200 && ['complete', 'error'].includes(res.body.analysis_status)) return res.body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('analysis did not complete');
}

beforeAll(async () => {
  db = initializeDatabase(':memory:');
  app = createApp(db);
  admin = authed(app, await loginAs(app, ROLES.SYSTEM_ADMIN));
  io = authed(app, await loginAs(app, ROLES.IO));
  sho = authed(app, await loginAs(app, ROLES.SHO));
  deo = authed(app, await loginAs(app, ROLES.DATA_ENTRY_OPERATOR));

  // Seed a fully-analysed report (as admin) for read/export/case-work checks.
  const buf = makeTestXlsx(buildStandardRows());
  const up = await admin.post('/api/ncrp/upload').attach('ncrpFile', buf, 'rbac.xlsx');
  reportId = up.body.reportId;
  await waitForAnalysis(admin, reportId);
});

afterAll(() => { try { db.close(); } catch (_e) { /* ignore */ } });

describe('unauthenticated access', () => {
  test('no token → 401 on a protected route', async () => {
    const res = await request(app).get('/api/ncrp/reports');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });
  test('health stays public', async () => {
    expect((await request(app).get('/api/health')).status).toBe(200);
  });
});

describe('VIEW_CASES — every role can read', () => {
  test.each([['admin'], ['io'], ['sho'], ['deo']])('%s can GET /reports', async (who) => {
    const agent = { admin, io, sho, deo }[who];
    expect((await agent.get('/api/ncrp/reports')).status).toBe(200);
  });
});

describe('UPLOAD_REPORT — admin/io/deo yes, sho no', () => {
  async function tryUpload(agent) {
    const buf = makeTestXlsx(buildStandardRows());
    return agent.post('/api/ncrp/upload').attach('ncrpFile', buf, 'x.xlsx');
  }
  test('io can upload', async () => { expect((await tryUpload(io)).status).toBe(202); });
  test('deo can upload', async () => { expect((await tryUpload(deo)).status).toBe(202); });
  test('sho is forbidden (403)', async () => {
    const res = await tryUpload(sho);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });
});

describe('EXPORT — admin/io/sho yes, deo no', () => {
  test('io can export PDF', async () => {
    expect((await io.get(`/api/ncrp/${reportId}/pdf`)).status).toBe(200);
  });
  test('sho can export PDF', async () => {
    expect((await sho.get(`/api/ncrp/${reportId}/pdf`)).status).toBe(200);
  });
  test('deo is forbidden from export (403)', async () => {
    expect((await deo.get(`/api/ncrp/${reportId}/pdf`)).status).toBe(403);
    expect((await deo.get(`/api/ncrp/${reportId}/excel`)).status).toBe(403);
  });
});

describe('CASE_WORK — admin/io yes, sho/deo no (POST lien)', () => {
  const body = { account_no: 'M0002', lien_status: 'pending' };
  test('io may perform case work (not 403)', async () => {
    expect((await io.post(`/api/ncrp/${reportId}/lien`).send(body)).status).not.toBe(403);
  });
  test('sho is forbidden (403)', async () => {
    expect((await sho.post(`/api/ncrp/${reportId}/lien`).send(body)).status).toBe(403);
  });
  test('deo is forbidden (403)', async () => {
    expect((await deo.post(`/api/ncrp/${reportId}/lien`).send(body)).status).toBe(403);
  });
});

describe('VIEW_AUDIT — admin/io/sho yes, deo no', () => {
  test('sho can read the audit trail', async () => {
    expect((await sho.get(`/api/ncrp/${reportId}/audit`)).status).toBe(200);
  });
  test('deo is forbidden (403)', async () => {
    expect((await deo.get(`/api/ncrp/${reportId}/audit`)).status).toBe(403);
  });
});

describe('MANAGE_USERS — admin only', () => {
  test('admin can list users', async () => {
    const res = await admin.get('/api/users');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.users)).toBe(true);
  });
  test.each([['io'], ['sho'], ['deo']])('%s is forbidden from user management', async (who) => {
    const agent = { io, sho, deo }[who];
    expect((await agent.get('/api/users')).status).toBe(403);
    const created = await agent.post('/api/users').send({ username: 'x123', role: ROLES.IO, password: 'GoodPass!2026' });
    expect(created.status).toBe(403);
  });
  test('admin can create a user', async () => {
    const res = await admin.post('/api/users').send({ username: 'newio', role: ROLES.IO, password: 'GoodPass!2026' });
    expect(res.status).toBe(201);
    expect(res.body.user.role).toBe(ROLES.IO);
    expect(res.body.user.must_change_password).toBe(true);
  });
});

describe('DELETE_REPORT — admin only', () => {
  test('io/sho/deo are forbidden (403)', async () => {
    for (const agent of [io, sho, deo]) {
      expect((await agent.delete(`/api/ncrp/${reportId}`)).status).toBe(403);
    }
  });
  test('admin can delete a (throwaway) report', async () => {
    const buf = makeTestXlsx(buildStandardRows());
    const up = await admin.post('/api/ncrp/upload').attach('ncrpFile', buf, 'del.xlsx');
    const res = await admin.delete(`/api/ncrp/${up.body.reportId}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });
});

describe('audit log records the acting user (Sub-step C)', () => {
  test('upload.ingested carries the uploader username', async () => {
    const buf = makeTestXlsx(buildStandardRows());
    const up = await io.post('/api/ncrp/upload').attach('ncrpFile', buf, 'audit.xlsx');
    const rid = up.body.reportId;
    const row = db.prepare(
      "SELECT * FROM audit_log WHERE action='upload.ingested' AND report_id=? ORDER BY id DESC",
    ).get(rid);
    expect(row).toBeTruthy();
    expect(row.username).toBe(`test_${ROLES.IO}`);
    expect(row.user_id).toEqual(expect.any(Number));
  });
  test('user.created audit row names the admin', async () => {
    await admin.post('/api/users').send({ username: 'audituser', role: ROLES.SHO, password: 'GoodPass!2026' });
    const row = db.prepare("SELECT * FROM audit_log WHERE action='user.created' ORDER BY id DESC").get();
    expect(row.username).toBe(`test_${ROLES.SYSTEM_ADMIN}`);
  });
});
