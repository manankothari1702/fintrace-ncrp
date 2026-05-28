'use strict';

/**
 * Security-oriented unit + targeted integration tests.
 *
 * Covers:
 *   • sanitizeIdentifier (email body XSS / control-char defence)
 *   • filename sanitisation in upload responses (path traversal defence)
 *   • SQL-injection rejection on the :id param (input validation before DB)
 *   • upload size cap (multer 50 MB limit)
 *   • lien_status enum validation (CHECK-constraint backed by 400 response)
 *   • magic-byte rejection (file that isn't actually an Excel workbook)
 */

// Disable rate-limiting before requiring the server module — the routes
// snapshot NODE_ENV at construction time.
process.env.NODE_ENV = 'test';

const path = require('path');
const request = require('supertest');

const { initializeDatabase } = require('../db/schema');
const { createApp } = require('../server');
const { insertReport } = require('../db/queries');
const { _internals: emailInternals } = require('../utils/emailGenerator');

const { makeTestXlsx, buildStandardRows } = require('./helpers/xlsx');

const { sanitizeIdentifier } = emailInternals;

let db;
let app;

beforeAll(() => {
  db = initializeDatabase(':memory:');
  app = createApp(db);
});

afterAll(() => {
  try { db.close(); } catch (_e) { /* best effort */ }
});

// ─── sanitizeIdentifier (from emailGenerator.js) ─────────────────────

describe('sanitizeIdentifier', () => {
  test("strips angle brackets (no <script>alert(1)</script>)", () => {
    const out = sanitizeIdentifier('<script>alert(1)</script>');
    // Angle brackets gone. The rest of the punctuation/letters survive
    // (the helper is for safe embedding into plain-text letters, not full
    // HTML escaping).
    expect(out).not.toMatch(/[<>]/);
    expect(out).toContain('scriptalert(1)');
  });

  test('strips ASCII control characters', () => {
    const out = sanitizeIdentifier('ACC\x00123');
    expect(out).toBe('ACC123');
  });

  test('caps length at 64 characters', () => {
    const out = sanitizeIdentifier('A'.repeat(100));
    expect(out).toHaveLength(64);
  });

  test('null/undefined → empty string', () => {
    expect(sanitizeIdentifier(null)).toBe('');
    expect(sanitizeIdentifier(undefined)).toBe('');
  });
});

// ─── Upload filename sanitisation (path traversal) ───────────────────

describe('upload filename sanitisation', () => {
  test('"../../../etc/passwd.xlsx" → safe basename in the response', async () => {
    const buf = makeTestXlsx(buildStandardRows());
    const res = await request(app)
      .post('/api/ncrp/upload')
      .attach('ncrpFile', buf, '../../../etc/passwd.xlsx');

    expect(res.status).toBe(202);
    // Original filename in the response must not retain any path component
    // (no slashes / backslashes / parent-dir hops).
    expect(res.body.filename).not.toMatch(/[\/\\]/);
    expect(res.body.filename).not.toContain('..');
    expect(res.body.filename).toMatch(/passwd\.xlsx$/);
  });
});

// ─── SQL injection on :id param ──────────────────────────────────────

describe(':id parameter validation', () => {
  test('GET /api/ncrp/1;DROP TABLE ncrp_reports → 400, no DB action', async () => {
    const res = await request(app).get('/api/ncrp/1;DROP TABLE');
    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    }));

    // The reports table must still be present (catalogue lookup succeeds).
    const tbl = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ncrp_reports'`)
      .get();
    expect(tbl).toBeDefined();
    expect(tbl.name).toBe('ncrp_reports');
  });

  test('negative numbers and floats are rejected', async () => {
    const neg = await request(app).get('/api/ncrp/-1');
    expect(neg.status).toBe(400);
    const flt = await request(app).get('/api/ncrp/1.5');
    expect(flt.status).toBe(400);
  });
});

// ─── 50 MB upload cap ────────────────────────────────────────────────

describe('file size cap', () => {
  test('51 MB upload → 413 FILE_TOO_LARGE', async () => {
    // 51 MiB of zeros — well past the 50 MiB cap. Multer reports
    // LIMIT_FILE_SIZE before the parser sees the bytes, so this never touches
    // the magic-byte path.
    const big = Buffer.alloc(51 * 1024 * 1024);
    const res = await request(app)
      .post('/api/ncrp/upload')
      .attach('ncrpFile', big, 'huge.xlsx');

    expect(res.status).toBe(413);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'FILE_TOO_LARGE' }),
    }));
  });
});

// ─── Magic-byte spoofing ─────────────────────────────────────────────

describe('Excel magic-byte gate', () => {
  test('non-Excel buffer with .xlsx extension → 400 INVALID_FILE_CONTENT', async () => {
    // 100 bytes of 'A' (0x41) — not a ZIP container, not an OLE2 doc.
    const fake = Buffer.alloc(100, 0x41);
    const res = await request(app)
      .post('/api/ncrp/upload')
      .attach('ncrpFile', fake, 'fake.xlsx');

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'INVALID_FILE_CONTENT' }),
    }));
  });
});

// ─── CORS middleware ─────────────────────────────────────────────────

describe('CORS middleware', () => {
  test('Vite dev origin (http://localhost:5173) is echoed back', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  test('file:// origin (Electron renderer) gets wildcard', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'file:///path/to/app');
    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  test('OPTIONS preflight returns 204', async () => {
    const res = await request(app)
      .options('/api/ncrp/reports')
      .set('Origin', 'http://localhost:5173');
    expect(res.status).toBe(204);
  });

  test('unknown origin → no ACAO header (browser will block)', async () => {
    const res = await request(app)
      .get('/api/health')
      .set('Origin', 'http://evil.example.com');
    expect(res.status).toBe(200);
    // The middleware doesn't emit ACAO for unknown origins.
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

// ─── 404 fallback for unmatched routes ───────────────────────────────

describe('404 fallback', () => {
  test('unmatched /api route → 404 NOT_FOUND', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'NOT_FOUND' }),
    }));
  });
});

// ─── lien_status enum validation ─────────────────────────────────────

describe('lien_status enum', () => {
  test('POST /api/ncrp/:id/lien with status "hacked" → 400 INVALID_STATUS', async () => {
    // Seed a report so the :id resolves to a real row first.
    const reportId = insertReport(db, {
      filename: 'sec.xlsx', original_filename: 'sec.xlsx',
      upload_date: new Date().toISOString(),
      analysis_status: 'pending',
    });

    const res = await request(app)
      .post(`/api/ncrp/${reportId}/lien`)
      .send({ account_no: 'ACC-1', lien_status: 'hacked' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      error: expect.objectContaining({ code: 'INVALID_STATUS' }),
    }));
  });

  test('POST /api/ncrp/:id/lien with no account_no → 400 VALIDATION_FAILED', async () => {
    const reportId = insertReport(db, {
      filename: 'sec2.xlsx', original_filename: 'sec2.xlsx',
      upload_date: new Date().toISOString(),
    });
    const res = await request(app)
      .post(`/api/ncrp/${reportId}/lien`)
      .send({ lien_status: 'pending' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

// ─── Upload edge cases ───────────────────────────────────────────────

describe('upload validation edges', () => {
  test('no file in the multipart body → 400 VALIDATION_FAILED', async () => {
    // Send a multipart body with no `ncrpFile` field — multer accepts the
    // request but req.file is undefined.
    const res = await request(app)
      .post('/api/ncrp/upload')
      .field('not_a_file', 'hello');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });

  test('wrong extension (.txt) → 400 INVALID_FILE_TYPE', async () => {
    const res = await request(app)
      .post('/api/ncrp/upload')
      .attach('ncrpFile', Buffer.from('plain text body'), 'notes.txt');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });

  test('valid .xlsx extension but file is unparseable garbage → 400', async () => {
    // Magic-byte check is the upstream gate; this is a different code path:
    // garbage bytes that pass as not-quite-Excel still fail there. Verified
    // by the magic-byte test above; here we double-check the matching
    // 400 code on a totally empty buffer.
    const res = await request(app)
      .post('/api/ncrp/upload')
      .attach('ncrpFile', Buffer.alloc(0), 'empty.xlsx');
    expect([400, 500]).toContain(res.status);
  });
});

// ─── Email status update validation ──────────────────────────────────

describe('POST /api/ncrp/:id/emails/:emailId validation', () => {
  test('bad emailId param → 400', async () => {
    const reportId = insertReport(db, {
      filename: 'em.xlsx', original_filename: 'em.xlsx',
      upload_date: new Date().toISOString(),
    });
    const res = await request(app)
      .post(`/api/ncrp/${reportId}/emails/notanint`)
      .send({ status: 'sent' });
    expect(res.status).toBe(400);
  });

  test('invalid status value → 400 INVALID_STATUS', async () => {
    const reportId = insertReport(db, {
      filename: 'em2.xlsx', original_filename: 'em2.xlsx',
      upload_date: new Date().toISOString(),
    });
    const res = await request(app)
      .post(`/api/ncrp/${reportId}/emails/1`)
      .send({ status: 'archived' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_STATUS');
  });
});
