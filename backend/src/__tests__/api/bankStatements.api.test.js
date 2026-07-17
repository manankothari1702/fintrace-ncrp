'use strict';

/**
 * Bank-statement routes — authenticated end-to-end tests over the real app
 * (createApp + in-memory DB + real login), mirroring reports.api.test.js.
 * Covers: PNB Excel/PDF upload → persisted canonical transactions, listing,
 * pagination, unrecognised-file fallback, upload security (extension
 * allow-list + magic bytes), RBAC per role, and audit logging.
 */

process.env.NODE_ENV = 'test'; // before requiring server.js (disables limiters)

const fs = require('fs');
const os = require('os');
const path = require('path');

// Redirect upload storage into a throwaway dir BEFORE the routes module
// computes UPLOADS_DIR at require time.
const TEST_UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'bankstmt-uploads-'));
process.env.FINTRACE_UPLOADS_DIR = TEST_UPLOADS;

const request = require('supertest');
const XLSX = require('xlsx');

const { initializeDatabase } = require('../../db/schema');
const { createApp } = require('../../server');
const { ROLES } = require('../../lib/roles');
const { loginAs, authed } = require('../helpers/auth');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const PNB_XLS = path.join(FIXTURES, 'pnb_statement.xls');
const PNB_PDF = path.join(FIXTURES, 'pnb_statement.pdf');

let db, app, admin;

beforeAll(async () => {
  db = initializeDatabase(':memory:');
  app = createApp(db);
  admin = authed(app, await loginAs(app));
});

afterAll(() => {
  try { db.close(); } catch (_e) { /* already closed */ }
  try { fs.rmSync(TEST_UPLOADS, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
});

describe('POST /api/bank-statement/upload', () => {
  test('rejects unauthenticated requests', async () => {
    // Buffer attach (not a streamed file path): the 401 is sent before the
    // body is consumed, and a streamed attach would die with ECONNRESET.
    const res = await request(app).post('/api/bank-statement/upload')
      .attach('statementFile', fs.readFileSync(PNB_XLS), 'pnb.xls');
    expect(res.status).toBe(401);
  });

  test('ingests the PNB .xls: 96 canonical transactions + provenance', async () => {
    const res = await admin.post('/api/bank-statement/upload')
      .attach('statementFile', PNB_XLS);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      recognized: true,
      bank: 'PNB',
      bankName: 'Punjab National Bank',
      format: 'excel',
      txnCount: 96,
    });
    expect(res.body.statementId).toEqual(expect.any(Number));
    expect(res.body.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.account).toMatchObject({
      account_number: '4563000100036079',
      account_holder: 'ABHISHEK BHARDWAJ',
      ifsc: 'PUNB0456300',
    });
    expect(res.body.warnings).toEqual([]);

    // Audit trail carries the acting user + provenance.
    const auditRow = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'bank_statement.uploaded' ORDER BY id DESC LIMIT 1",
    ).get();
    expect(auditRow).toBeDefined();
    const details = JSON.parse(auditRow.details);
    expect(details).toMatchObject({
      statement_id: res.body.statementId,
      bank: 'PNB',
      source_format: 'excel',
      txn_count: 96,
    });
    expect(auditRow.username).toBe(`test_${ROLES.SYSTEM_ADMIN}`);
  });

  test('ingests the PNB .pdf with identical figures (cross-format anchor)', async () => {
    const res = await admin.post('/api/bank-statement/upload')
      .attach('statementFile', PNB_PDF);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      recognized: true, bank: 'PNB', format: 'pdf', txnCount: 96,
    });
    expect(res.body.account.account_number).toBe('4563000100036079');
  });

  test('a valid but unrecognised workbook returns recognized:false + sniffed headers (nothing persisted)', async () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Some Other Bank Statement'],
      ['Date', 'Details', 'Withdrawal', 'Deposit', 'Balance'],
      ['01/06/2026', 'ATM CASH', '500', '', '1000.00'],
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const file = path.join(TEST_UPLOADS, 'other_bank.xlsx');
    XLSX.writeFile(wb, file);

    const before = db.prepare('SELECT COUNT(*) AS n FROM bank_statements').get().n;
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', file);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recognized: false, format: 'excel' });
    expect(res.body.detectedHeaders).toEqual(['Date', 'Details', 'Withdrawal', 'Deposit', 'Balance']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_statements').get().n).toBe(before);
  });

  test('rejects disallowed extensions', async () => {
    const file = path.join(TEST_UPLOADS, 'notes.txt');
    fs.writeFileSync(file, 'hello');
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', file);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_TYPE');
  });

  test('rejects content that fails the magic-byte check (text renamed to .pdf)', async () => {
    const file = path.join(TEST_UPLOADS, 'fake.pdf');
    fs.writeFileSync(file, 'this is not a pdf');
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', file);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_FILE_CONTENT');
  });

  test('requires the statementFile field', async () => {
    const res = await admin.post('/api/bank-statement/upload');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NO_FILE');
  });
});

describe('RBAC — bank-statement permissions mirror NCRP upload/view', () => {
  test('sho (no upload_report) cannot upload but can read', async () => {
    const sho = authed(app, await loginAs(app, ROLES.SHO));
    // Buffer attach — the 403 lands before the multipart body is consumed.
    const up = await sho.post('/api/bank-statement/upload')
      .attach('statementFile', fs.readFileSync(PNB_XLS), 'pnb.xls');
    expect(up.status).toBe(403);
    expect(up.body.error.code).toBe('FORBIDDEN');

    const list = await sho.get('/api/bank-statement/statements');
    expect(list.status).toBe(200);
  });

  test('data_entry_operator can upload (same as NCRP uploads)', async () => {
    const deo = authed(app, await loginAs(app, ROLES.DATA_ENTRY_OPERATOR));
    const res = await deo.post('/api/bank-statement/upload').attach('statementFile', PNB_XLS);
    expect(res.status).toBe(201);
    expect(res.body.txnCount).toBe(96);
  });
});

describe('GET /api/bank-statement/statements (+ detail)', () => {
  test('lists uploads newest-first with account metadata', async () => {
    const res = await admin.get('/api/bank-statement/statements');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(3); // xls + pdf + deo xls
    const first = res.body.data[0];
    expect(first).toMatchObject({
      account_number: '4563000100036079',
      bank_name: 'Punjab National Bank',
      txn_count: 96,
    });
    expect(first).toHaveProperty('source_format');
    expect(first).toHaveProperty('uploaded_at');
  });

  test('statement detail returns parse_warnings as an array', async () => {
    const list = await admin.get('/api/bank-statement/statements');
    const id = list.body.data[0].id;
    const res = await admin.get(`/api/bank-statement/statements/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(Array.isArray(res.body.parse_warnings)).toBe(true);
  });

  test('validates the id and 404s on unknown statements', async () => {
    expect((await admin.get('/api/bank-statement/statements/abc')).status).toBe(400);
    expect((await admin.get('/api/bank-statement/statements/99999')).status).toBe(404);
  });
});

describe('GET /api/bank-statement/statements/:id/transactions', () => {
  let statementId;
  beforeAll(async () => {
    const list = await admin.get('/api/bank-statement/statements');
    // Oldest row = the first .xls upload from this suite.
    statementId = list.body.data[list.body.data.length - 1].id;
  });

  test('pages in native statement order with the NCRP response shape', async () => {
    const p1 = await admin.get(`/api/bank-statement/statements/${statementId}/transactions?page=1&limit=50`);
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ total: 96, page: 1, limit: 50, total_pages: 2 });
    expect(p1.body.data).toHaveLength(50);
    // Native (reverse-chronological) order: newest statement row first.
    expect(p1.body.data[0]).toMatchObject({
      txn_date: '2026-07-02T00:00:00.000Z',
      credit_amount: 500,
      debit_amount: null,
      balance: 2274.95,
      balance_type: 'Cr',
      ref_no: 'U12010768',
    });

    const p2 = await admin.get(`/api/bank-statement/statements/${statementId}/transactions?page=2&limit=50`);
    expect(p2.body.data).toHaveLength(46);
    const last = p2.body.data[p2.body.data.length - 1];
    expect(last).toMatchObject({ txn_date: '2026-06-02T00:00:00.000Z', credit_amount: 141, balance: 8759.95 });
  });

  test('narrations round-trip untouched (NEFT counterparty text preserved)', async () => {
    const res = await admin.get(`/api/bank-statement/statements/${statementId}/transactions?limit=500`);
    const neft = res.body.data.filter((t) => (t.narration || '').includes('M INTERGRAPH SYSTEMS PVT'));
    expect(neft.length).toBeGreaterThan(0);
    expect(neft[0].narration).toMatch(/^NEFT_IN:/);
  });

  test('rejects malformed pagination', async () => {
    expect((await admin.get(`/api/bank-statement/statements/${statementId}/transactions?page=0`)).status).toBe(400);
    expect((await admin.get(`/api/bank-statement/statements/${statementId}/transactions?limit=9999`)).status).toBe(400);
  });
});

// ─── Milestone 2: wizard + template flow ─────────────────────────────

describe('wizard + template flow (CSV/Excel without a dedicated parser)', () => {
  const CSV_SINGLE = path.join(FIXTURES, 'generic_single_amount.csv');
  const CSV_SPLIT = path.join(FIXTURES, 'generic_split_semicolon.csv');
  const SINGLE_MAPPING = {
    version: 1,
    columns: {
      Date: 'date', Details: 'narration', 'Ref No': 'ref_no',
      Amount: 'amount', Type: 'type', Balance: 'balance',
    },
    options: {},
  };
  let pendingFileId; // captured from the wizard-eligible upload

  test('unrecognised CSV → wizard-eligible: kept file + headers + suggestions + preview + inferred facts', async () => {
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', CSV_SINGLE);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      recognized: false,
      wizardEligible: true,
      format: 'csv',
      detectedHeaders: ['Date', 'Details', 'Ref No', 'Amount', 'Type', 'Balance'],
    });
    expect(res.body.suggested).toEqual({
      Date: 'date', Details: 'narration', 'Ref No': 'ref_no',
      Amount: 'amount', Type: 'type', Balance: 'balance',
    });
    expect(res.body.preview).toHaveLength(5);
    expect(res.body.preview[0][0]).toBe('01-06-2026');
    expect(res.body.inferred).toMatchObject({
      ifsc: 'SYNB0001234', account_number: '991100223344',
    });
    // The pending file is KEPT for apply-mapping.
    expect(res.body.fileId).toMatch(/^bankstmt-[0-9a-f-]{36}\.csv$/);
    expect(fs.existsSync(path.join(TEST_UPLOADS, res.body.fileId))).toBe(true);
    pendingFileId = res.body.fileId;
  });

  test('apply-mapping input gate: traversal, unknown file, missing bank name, broken mapping', async () => {
    const post = (body) => admin.post('/api/bank-statement/apply-mapping').send(body);

    // Path traversal / non-pending names never reach the filesystem.
    expect((await post({ fileId: '../../etc/passwd', mapping: SINGLE_MAPPING })).status).toBe(400);
    expect((await post({ fileId: 'pnb_statement.xls', mapping: SINGLE_MAPPING })).status).toBe(400);
    // Well-formed but vanished pending file.
    const gone = await post({
      fileId: 'bankstmt-00000000-0000-4000-8000-000000000000.csv', mapping: SINGLE_MAPPING,
    });
    expect(gone.status).toBe(404);
    expect(gone.body.error.code).toBe('PENDING_FILE_NOT_FOUND');
    // Saving a template needs a bank name.
    const noName = await post({
      fileId: pendingFileId, mapping: SINGLE_MAPPING, saveAsTemplate: true,
    });
    expect(noName.status).toBe(400);
    // Structurally invalid mapping → 422 with the parser's reason.
    const badMap = await post({
      fileId: pendingFileId, mapping: { columns: { Details: 'narration' } },
    });
    expect(badMap.status).toBe(422);
    expect(badMap.body.error.code).toBe('MAPPING_FAILED');
  });

  test('apply-mapping ingests, verifies balance continuity, and saves the template', async () => {
    const res = await admin.post('/api/bank-statement/apply-mapping').send({
      fileId: pendingFileId,
      filename: 'synth_bank_june.csv',
      mapping: SINGLE_MAPPING,
      bankName: 'Synthetic Bank of Bharat',
      saveAsTemplate: true,
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      recognized: true,
      via: 'wizard',
      bank: 'Synthetic Bank of Bharat',
      format: 'csv',
      txnCount: 10,
      continuity: { checked: true, direction: 'oldest-first', breakCount: 0 },
    });
    expect(res.body.templateId).toEqual(expect.any(Number));
    expect(res.body.warnings).toEqual(
      expect.arrayContaining([expect.stringMatching(/Balance continuity verified: 10 rows/)]),
    );
    expect(res.body.account).toMatchObject({
      account_number: '991100223344', ifsc: 'SYNB0001234',
    });

    // Canonical rows landed and read back through the normal route.
    const txns = await admin.get(
      `/api/bank-statement/statements/${res.body.statementId}/transactions?limit=100`,
    );
    expect(txns.body.total).toBe(10);
    expect(txns.body.data[0]).toMatchObject({
      txn_date: '2026-06-01T00:00:00.000Z', credit_amount: 5000, balance: 15000,
    });

    // Template save is audited.
    const auditRow = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'bank_statement.template_saved' ORDER BY id DESC LIMIT 1",
    ).get();
    expect(JSON.parse(auditRow.details)).toMatchObject({
      template_id: res.body.templateId, bank_name: 'Synthetic Bank of Bharat',
    });
  });

  test('round trip: the same layout now auto-detects via the template — no wizard', async () => {
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', CSV_SINGLE);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      recognized: true,
      via: 'template',
      bank: 'Synthetic Bank of Bharat',
      txnCount: 10,
      continuity: { checked: true, breakCount: 0 },
    });
    expect(res.body.templateId).toEqual(expect.any(Number));
    // Audit records the template-driven ingestion.
    const auditRow = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'bank_statement.uploaded' ORDER BY id DESC LIMIT 1",
    ).get();
    expect(JSON.parse(auditRow.details)).toMatchObject({ via: 'template' });
  });

  test('a DIFFERENT layout still goes to the wizard (template does not overreach)', async () => {
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', CSV_SPLIT);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recognized: false, wizardEligible: true });
    expect(res.body.detectedHeaders).toEqual(
      ['Txn Date', 'Particulars', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    );
    expect(res.body.suggested).toMatchObject({
      'Withdrawal Amt.': 'debit', 'Deposit Amt.': 'credit',
    });
  });

  test('PNB priority: the dedicated parser still wins while templates exist', async () => {
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', PNB_XLS);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ recognized: true, bank: 'PNB', txnCount: 96 });
    expect(res.body.via).toBeUndefined(); // dedicated path, not template/wizard
  });

  test('unrecognised PDF → no wizard, clear dedicated-parser message', async () => {
    // Generate a real (non-PNB) PDF with pdfkit — already a backend dep.
    const PDFDocument = require('pdfkit');
    const pdfPath = path.join(TEST_UPLOADS, 'other_bank_statement.pdf');
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument();
      const out = fs.createWriteStream(pdfPath);
      out.on('finish', resolve);
      out.on('error', reject);
      doc.pipe(out);
      doc.text('Some Other Bank — Account Statement');
      doc.text('01/06/2026  ATM CASH  500.00  900.00');
      doc.end();
    });

    const before = db.prepare('SELECT COUNT(*) AS n FROM bank_statements').get().n;
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', pdfPath);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      recognized: false,
      wizardEligible: false,
      reason: 'PDF_NEEDS_DEDICATED_PARSER',
      format: 'pdf',
    });
    expect(res.body.message).toMatch(/dedicated per-bank parser/i);
    expect(db.prepare('SELECT COUNT(*) AS n FROM bank_statements').get().n).toBe(before);
  });

  test('a table-less CSV is not wizard-eligible (NO_TABLE_HEADER)', async () => {
    const file = path.join(TEST_UPLOADS, 'numbers_only.csv');
    fs.writeFileSync(file, '1,2,3\n4,5,6\n7,8,9\n');
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', file);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      recognized: false, wizardEligible: false, reason: 'NO_TABLE_HEADER',
    });
  });
});

describe('template registry routes + RBAC', () => {
  test('lists templates with parsed signature and mapping objects', async () => {
    const res = await admin.get('/api/bank-statement/templates');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    const t = res.body.data.find((x) => x.bank_name === 'Synthetic Bank of Bharat');
    expect(t).toBeDefined();
    expect(t.source_format).toBe('csv');
    expect(t.signature.headers).toEqual(['date', 'details', 'refno', 'amount', 'type', 'balance']);
    expect(t.signature.ifscPrefix).toBe('SYNB0');
    expect(t.mapping.columns).toMatchObject({ Amount: 'amount', Type: 'type' });
    expect(t.created_by).toBe(`test_${ROLES.SYSTEM_ADMIN}`);
  });

  test('sho can view templates but cannot apply mappings or delete templates', async () => {
    const sho = authed(app, await loginAs(app, ROLES.SHO));
    expect((await sho.get('/api/bank-statement/templates')).status).toBe(200);
    expect((await sho.post('/api/bank-statement/apply-mapping').send({})).status).toBe(403);
    expect((await sho.delete('/api/bank-statement/templates/1')).status).toBe(403);
  });

  test('deleting the template returns the layout to the wizard path', async () => {
    const list = await admin.get('/api/bank-statement/templates');
    const t = list.body.data.find((x) => x.bank_name === 'Synthetic Bank of Bharat');

    const del = await admin.delete(`/api/bank-statement/templates/${t.id}`);
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ deleted: true, id: t.id });
    expect((await admin.delete(`/api/bank-statement/templates/${t.id}`)).status).toBe(404);

    // Same layout, no template → wizard again.
    const res = await admin.post('/api/bank-statement/upload')
      .attach('statementFile', path.join(FIXTURES, 'generic_single_amount.csv'));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ recognized: false, wizardEligible: true });
  });

  test('validates the template id shape', async () => {
    expect((await admin.delete('/api/bank-statement/templates/abc')).status).toBe(400);
  });
});

// ─── Milestone 3: counterparty extraction ────────────────────────────

describe('counterparty extraction at ingest + re-extraction', () => {
  let statementId;

  beforeAll(async () => {
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', PNB_XLS);
    expect(res.status).toBe(201);
    statementId = res.body.statementId;
  });

  test('ingested transactions carry extracted counterparty fields (raw narration untouched)', async () => {
    const res = await admin.get(
      `/api/bank-statement/statements/${statementId}/transactions?limit=500`,
    );
    expect(res.status).toBe(200);

    const ram = res.body.data.find((t) => (t.narration || '').includes('RAM BAHA'));
    expect(ram).toMatchObject({
      narration: 'UPI/DR/360729244657/RAM BAHA/BARB/8004806574@axl/P',
      counterparty_name: 'RAM BAHA',
      counterparty_bank_code: 'BARB',
      counterparty_vpa: '8004806574@axl',
      counterparty_ifsc: null,
      counterparty_phone: null,
      txn_channel: 'UPI',
      extraction_confidence: 'high',
    });

    const neft = res.body.data.find((t) => (t.narration || '').includes('INTERGRAPH'));
    expect(neft).toMatchObject({
      counterparty_name: 'M INTERGRAPH SYSTEMS PVT',
      counterparty_ifsc: 'HDFC0000240',
      counterparty_bank_code: 'HDFC',
      txn_channel: 'NEFT',
      extraction_confidence: 'high',
    });

    const interest = res.body.data.find((t) => (t.narration || '').includes('Int.Pd'));
    expect(interest).toMatchObject({
      counterparty_name: null,
      counterparty_vpa: null,
      txn_channel: 'INTEREST',
      extraction_confidence: 'none',
    });

    const high = res.body.data.filter((t) => t.extraction_confidence === 'high');
    expect(high).toHaveLength(95);
  });

  test('reextract backfills wiped fields and reports coverage (pre-m3 data path)', async () => {
    // Simulate a statement ingested BEFORE extraction existed.
    db.prepare(`
      UPDATE bank_statement_transactions
         SET counterparty_name = NULL, counterparty_bank_code = NULL,
             counterparty_ifsc = NULL, counterparty_vpa = NULL,
             counterparty_phone = NULL, txn_channel = NULL,
             extraction_confidence = NULL
       WHERE statement_id = ?
    `).run(statementId);

    const res = await admin.post(`/api/bank-statement/statements/${statementId}/reextract`);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(96);
    expect(res.body.coverage).toMatchObject({
      total: 96,
      byChannel: { UPI: 92, IMPS: 1, NEFT: 2, INTEREST: 1 },
      byConfidence: { high: 95, low: 0, none: 1 },
      withName: 95,
      withVpa: 92,
      withIfsc: 2,
      withPhone: 1,
    });

    const txns = await admin.get(
      `/api/bank-statement/statements/${statementId}/transactions?limit=500`,
    );
    const ram = txns.body.data.find((t) => (t.narration || '').includes('RAM BAHA'));
    expect(ram.counterparty_name).toBe('RAM BAHA');

    // Audited with the coverage detail.
    const auditRow = db.prepare(
      "SELECT * FROM audit_log WHERE action = 'bank_statement.reextracted' ORDER BY id DESC LIMIT 1",
    ).get();
    expect(JSON.parse(auditRow.details)).toMatchObject({ statement_id: statementId, updated: 96 });
  });

  test('reextract is idempotent — a second run reproduces identical rows', async () => {
    const before = db.prepare(
      'SELECT * FROM bank_statement_transactions WHERE statement_id = ? ORDER BY id',
    ).all(statementId);
    const res = await admin.post(`/api/bank-statement/statements/${statementId}/reextract`);
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(96);
    const after = db.prepare(
      'SELECT * FROM bank_statement_transactions WHERE statement_id = ? ORDER BY id',
    ).all(statementId);
    expect(after).toEqual(before);
  });

  test('reextract validates id, 404s on unknown statements, and enforces RBAC', async () => {
    expect((await admin.post('/api/bank-statement/statements/abc/reextract')).status).toBe(400);
    expect((await admin.post('/api/bank-statement/statements/99999/reextract')).status).toBe(404);
    const sho = authed(app, await loginAs(app, ROLES.SHO));
    expect((await sho.post(`/api/bank-statement/statements/${statementId}/reextract`)).status).toBe(403);
  });
});

// ─── Milestone 4: single-statement analysis (cached) ─────────────────

describe('GET /statements/:id/analysis — computed once, served cached', () => {
  let statementId;

  beforeAll(async () => {
    const res = await admin.post('/api/bank-statement/upload').attach('statementFile', PNB_XLS);
    statementId = res.body.statementId;
  });

  test('analysis is cached at ingest and reconciles with ingestion totals', async () => {
    // Cache exists on the row before any analysis GET.
    const cachedRow = db.prepare(
      'SELECT analysis_json, analyzed_at FROM bank_statements WHERE id = ?',
    ).get(statementId);
    expect(cachedRow.analysis_json).toBeTruthy();
    expect(cachedRow.analyzed_at).toBeTruthy();

    const res = await admin.get(`/api/bank-statement/statements/${statementId}/analysis`);
    expect(res.status).toBe(200);
    expect(res.body.statementId).toBe(statementId);
    expect(res.body.analysis.summary).toMatchObject({
      total_credit: 43852,   // = ingestion credit total (the anchor)
      total_debit: 50196,    // = ingestion debit total
      net_flow: -6344,
      credit_count: 11,
      debit_count: 85,
      txn_count: 96,
      opening_balance: 8618.95,
      closing_balance: 2274.95,
    });
    expect(res.body.analysis.counterparties).toHaveLength(70);
    expect(res.body.analysis.flags.map((f) => f.id).sort()).toEqual(
      ['pass_through_days', 'rapid_transaction_days', 'repeat_counterparties'],
    );
  });

  test('statements without a cache (pre-m4 data) compute lazily on first read', async () => {
    db.prepare('UPDATE bank_statements SET analysis_json = NULL, analyzed_at = NULL WHERE id = ?')
      .run(statementId);
    const res = await admin.get(`/api/bank-statement/statements/${statementId}/analysis`);
    expect(res.status).toBe(200);
    expect(res.body.analysis.summary.txn_count).toBe(96);
    // …and the cache is filled for the next read.
    const row = db.prepare('SELECT analysis_json FROM bank_statements WHERE id = ?').get(statementId);
    expect(JSON.parse(row.analysis_json).summary.total_debit).toBe(50196);
  });

  test('reextract refreshes the cached analysis', async () => {
    const before = db.prepare('SELECT analyzed_at FROM bank_statements WHERE id = ?').get(statementId);
    // Make the timestamps distinguishable (CURRENT_TIMESTAMP is second-granular).
    db.prepare("UPDATE bank_statements SET analyzed_at = '2000-01-01 00:00:00' WHERE id = ?").run(statementId);
    await admin.post(`/api/bank-statement/statements/${statementId}/reextract`);
    const after = db.prepare('SELECT analyzed_at, analysis_json FROM bank_statements WHERE id = ?').get(statementId);
    expect(after.analyzed_at).not.toBe('2000-01-01 00:00:00');
    expect(JSON.parse(after.analysis_json).counterparties).toHaveLength(70);
    expect(before).toBeTruthy();
  });

  test('validates id, 404s unknown, and readers (sho) may view', async () => {
    expect((await admin.get('/api/bank-statement/statements/abc/analysis')).status).toBe(400);
    expect((await admin.get('/api/bank-statement/statements/99999/analysis')).status).toBe(404);
    const sho = authed(app, await loginAs(app, ROLES.SHO));
    expect((await sho.get(`/api/bank-statement/statements/${statementId}/analysis`)).status).toBe(200);
  });
});
