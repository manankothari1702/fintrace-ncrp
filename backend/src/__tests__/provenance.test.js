'use strict';

/**
 * Evidentiary-provenance tests — the SHA-256 source-file traceability feature.
 *
 * Covers the four guarantees the feature makes:
 *   1. the source hash is STABLE for a fixed file (Node crypto, byte-exact);
 *   2. on upload the hash is recorded on the case record AND in the audit_log
 *      (with filename, upload timestamp, and app version);
 *   3. the hash is stamped into the generated PDF dossier (cover block, every
 *      page footer, and the PDF metadata);
 *   4. re-ingesting the SAME case (ack no.) from a file with a DIFFERENT hash
 *      raises a changed-source warning — and an identical re-upload does not.
 *
 * The route tests drive the real Express app via supertest against an in-memory
 * SQLite DB, so persistence, parsing, and the background analysis are all real.
 */

process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');

const { initializeDatabase } = require('../db/schema');
const { createApp } = require('../server');
const { makeTestXlsx, buildStandardRows, STANDARD_HEADERS } = require('./helpers/xlsx');
const { extractPdfText } = require('./helpers/pdfText');
const { sha256File, sha256Buffer, appVersion } = require('../lib/provenance');

const SHA_HEX = /^[0-9a-f]{64}$/;

/** Capture a binary response body (the PDF download) as a Buffer. */
function binaryParser(res, cb) {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(Buffer.from(chunk, 'binary')));
  res.setEncoding('binary');
  res.on('end', () => cb(null, Buffer.concat(chunks.map((c) => Buffer.from(c, 'binary')))));
}

/** Standard rows with an explicit ack no. and a tweakable remark (to vary bytes). */
function buildRowsWithAck(ack, remark) {
  return [
    STANDARD_HEADERS,
    [
      ack, '2024-01-14T00:00:00.000Z',
      'V0001', 'HDFC Bank',
      'M0001', 'ICICI Bank', 'Mule One', 'ICIC0001234',
      '2024-01-15T05:00:00.000Z', 100000, 100000,
      'UTR0001', 'IMPS', 1,
      null, null, 'Mumbai', 'Maharashtra', remark,
    ],
    [
      ack, '2024-01-14T00:00:00.000Z',
      'M0001', 'ICICI Bank',
      'M0002', 'SBI', 'Mule Two', 'SBIN0009876',
      '2024-01-16T09:00:00.000Z', 80000, 100000,
      'UTR0002', 'ATM', 2,
      'ATM1234', 'NSP Branch', 'Delhi', 'Delhi', 'cashout',
    ],
  ];
}

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
  throw new Error(`analysis did not complete for report ${reportId}`);
}

let db;
let agent;

beforeAll(() => {
  db = initializeDatabase(':memory:');
  agent = request(createApp(db));
});

afterAll(() => {
  try { db.close(); } catch (_e) { /* best effort */ }
});

// ─── 1. Hash stability ───────────────────────────────────────────────────────
describe('SHA-256 source hashing', () => {
  test('hash is stable for a fixed file and is 64-char lowercase hex', () => {
    const buf = makeTestXlsx(buildStandardRows());
    const p = path.join(os.tmpdir(), `prov-stable-${process.pid}.xlsx`);
    fs.writeFileSync(p, buf);
    try {
      const h1 = sha256File(p);
      const h2 = sha256File(p);
      expect(h1).toMatch(SHA_HEX);
      expect(h1).toBe(h2);
      // Matches a hash computed over the same bytes in-memory.
      expect(h1).toBe(sha256Buffer(buf));
    } finally {
      fs.unlinkSync(p);
    }
  });

  test('different bytes produce a different hash', () => {
    const a = sha256Buffer(makeTestXlsx(buildRowsWithAck('ACK-A', 'one')));
    const b = sha256Buffer(makeTestXlsx(buildRowsWithAck('ACK-A', 'two')));
    expect(a).not.toBe(b);
  });

  test('a known constant hashes to its documented digest', () => {
    // Anchors the algorithm itself (SHA-256 of "abc").
    expect(sha256Buffer('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

// ─── 2. Hash on the case record + in the audit log ───────────────────────────
describe('upload records provenance on the case + audit log', () => {
  let reportId;
  let responseHash;

  test('POST /upload returns the source hash and persists it on the report', async () => {
    const buf = makeTestXlsx(buildStandardRows());
    const res = await agent.post('/api/ncrp/upload').attach('ncrpFile', buf, 'gold_sample.xlsx');
    expect(res.status).toBe(202);
    expect(res.body.sourceSha256).toMatch(SHA_HEX);
    reportId = res.body.reportId;
    responseHash = res.body.sourceSha256;

    const row = db.prepare('SELECT source_sha256 FROM ncrp_reports WHERE id = ?').get(reportId);
    expect(row.source_sha256).toBe(responseHash);
  });

  test('audit_log carries case id, filename, sha256, timestamp, and app version', () => {
    const audit = db.prepare(
      "SELECT * FROM audit_log WHERE report_id = ? AND action = 'upload.ingested'").get(reportId);
    expect(audit).toBeDefined();
    const details = JSON.parse(audit.details);
    expect(audit.report_id).toBe(reportId);            // case id
    expect(details.filename).toBe('gold_sample.xlsx');  // filename
    expect(details.source_sha256).toBe(responseHash);   // sha256
    expect(details.uploaded_at).toEqual(expect.any(String)); // upload timestamp
    expect(details.app_version).toBe(appVersion());     // app version
    expect(audit.timestamp).toEqual(expect.any(String));
  });
});

// ─── 3. Hash stamped into the PDF dossier ────────────────────────────────────
describe('PDF dossier carries the source hash', () => {
  test('hash appears in the cover block, page footer, and PDF metadata', async () => {
    const buf = makeTestXlsx(buildStandardRows());
    const up = await agent.post('/api/ncrp/upload').attach('ncrpFile', buf, 'dossier_sample.xlsx');
    const reportId = up.body.reportId;
    const hash = up.body.sourceSha256;
    await waitForAnalysis(agent, reportId);

    const res = await agent.get(`/api/ncrp/${reportId}/pdf`).buffer().parse(binaryParser);
    expect(res.status).toBe(200);
    const pdf = res.body;
    expect(Buffer.isBuffer(pdf)).toBe(true);

    const flat = extractPdfText(pdf).replace(/\s+/g, ' ');
    expect(flat).toContain('Source & Provenance');
    expect(flat).toContain(hash);                       // cover + footers
    expect(flat).toContain('dossier_sample.xlsx');      // source filename on cover
    // Footer repeats the hash on every page (≥ 2 occurrences: cover body + footers).
    expect((flat.match(new RegExp(hash, 'g')) || []).length).toBeGreaterThan(1);

    // Item 3 — the hash is embedded in the PDF metadata (Keywords).
    expect(pdf.toString('latin1')).toContain(`source-sha256:${hash}`);
  }, 30000);
});

// ─── 4. Changed-source warning ───────────────────────────────────────────────
describe('changed-source detection on re-ingest', () => {
  const ACK = 'NCRP-CHANGED-SRC-001';

  test('first upload of a case raises no changed-source warning', async () => {
    const buf = makeTestXlsx(buildRowsWithAck(ACK, 'original'));
    const res = await agent.post('/api/ncrp/upload').attach('ncrpFile', buf, 'v1.xlsx');
    expect(res.status).toBe(202);
    const codes = (res.body.warnings || []).map((w) => w && w.code);
    expect(codes).not.toContain('SOURCE_FILE_CHANGED');
  });

  test('re-ingesting the same case from a different file warns SOURCE_FILE_CHANGED', async () => {
    const buf = makeTestXlsx(buildRowsWithAck(ACK, 'EDITED — different bytes'));
    const res = await agent.post('/api/ncrp/upload').attach('ncrpFile', buf, 'v2.xlsx');
    expect(res.status).toBe(202);
    const warn = (res.body.warnings || []).find((w) => w && w.code === 'SOURCE_FILE_CHANGED');
    expect(warn).toBeDefined();
    expect(warn.ackNo).toBe(ACK);
    expect(warn.currentSha256).toBe(res.body.sourceSha256);
    expect(warn.previousSha256).toMatch(SHA_HEX);
    expect(warn.previousSha256).not.toBe(warn.currentSha256);
    expect(warn.message).toMatch(/different SHA-256/i);
  });

  test('re-uploading the byte-identical file does NOT warn', async () => {
    const bytes = makeTestXlsx(buildRowsWithAck('NCRP-SAME-SRC-002', 'stable'));
    const first = await agent.post('/api/ncrp/upload').attach('ncrpFile', bytes, 'same.xlsx');
    expect(first.status).toBe(202);
    // Same exact buffer → same hash → no change.
    const second = await agent.post('/api/ncrp/upload').attach('ncrpFile', bytes, 'same.xlsx');
    expect(second.status).toBe(202);
    expect(second.body.sourceSha256).toBe(first.body.sourceSha256);
    const codes = (second.body.warnings || []).map((w) => w && w.code);
    expect(codes).not.toContain('SOURCE_FILE_CHANGED');
  });
});
