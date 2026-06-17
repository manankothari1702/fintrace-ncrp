'use strict';

/**
 * FinTrace NCRP — manual pre-release end-to-end validator.
 *
 * Boots the real server (with an isolated SQLite DB in os.tmpdir), drives a
 * complete officer workflow through HTTP, and reports PASS/FAIL per step plus
 * total runtime. This is intentionally *not* a Jest test: it exercises the
 * real persistence + filesystem and produces a human-readable scoreboard for
 * pre-release sign-off.
 *
 * Usage:
 *   node scripts/e2e_validate.js                   # uses real case 145 (32712250107145)
 *   node scripts/e2e_validate.js path/to/file.xlsx # uses the supplied file
 *
 * Exit code: 0 if every step passes, 1 otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { startServer } = require('../src/server');

// ─── Pretty-printing helpers ─────────────────────────────────────────

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';

const supportsColor = process.stdout.isTTY;
function c(color, s) {
  return supportsColor ? `${color}${s}${RESET}` : s;
}

const steps = [];

/**
 * Run one step, mark PASS/FAIL, record elapsed time.
 *
 * @param {string} name
 * @param {() => Promise<unknown>} fn
 */
async function step(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    const ms = Date.now() - start;
    steps.push({ name, status: 'PASS', ms, note: null });
    console.log(`  ${c(GREEN, 'PASS')}  ${name}  ${c(DIM, `(${ms}ms)`)}`);
    return result;
  } catch (err) {
    const ms = Date.now() - start;
    const msg = err && err.message ? err.message : String(err);
    steps.push({ name, status: 'FAIL', ms, note: msg });
    console.log(`  ${c(RED, 'FAIL')}  ${name}  ${c(DIM, `(${ms}ms)`)}`);
    console.log(`         ${c(RED, msg)}`);
    throw err;
  }
}

// ─── Minimal HTTP client (multipart + JSON) ──────────────────────────

/**
 * @param {string} host
 * @param {number} port
 * @param {string} method
 * @param {string} pathName
 * @param {object|null} body
 * @returns {Promise<{ status: number, body: any, raw: Buffer }>}
 */
function httpRequest(host, port, method, pathName, body = null) {
  return new Promise((resolve, reject) => {
    const headers = {};
    let payload = null;
    if (body !== null && body !== undefined) {
      payload = Buffer.from(JSON.stringify(body));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(payload.length);
    }
    const req = http.request({ host, port, method, path: pathName, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch (_e) { /* leave null */ }
        resolve({ status: res.statusCode || 0, body: parsed, raw });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * Multipart upload of `filePath` to `/api/ncrp/upload`.
 *
 * @param {string} host
 * @param {number} port
 * @param {string} filePath
 */
function uploadFile(host, port, filePath) {
  return new Promise((resolve, reject) => {
    const boundary = `----fintrace-${Date.now().toString(16)}`;
    const fileBuf = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const head = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="ncrpFile"; filename="${fileName}"\r\n` +
      `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\n`
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([head, fileBuf, tail]);

    const req = http.request({
      host, port, method: 'POST', path: '/api/ncrp/upload',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': String(body.length),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(raw.toString('utf8')); } catch (_e) { /* leave null */ }
        resolve({ status: res.statusCode || 0, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Download a binary response (PDF) to `outPath`.
 */
function downloadFile(host, port, pathName, outPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, method: 'GET', path: pathName }, (res) => {
      if (res.statusCode !== 200) {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => reject(
          new Error(`PDF download failed: status ${res.statusCode} body ${Buffer.concat(chunks).toString('utf8').slice(0, 200)}`)
        ));
        return;
      }
      const ws = fs.createWriteStream(outPath);
      res.pipe(ws);
      ws.on('finish', () => ws.close(resolve));
      ws.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Main ────────────────────────────────────────────────────────────

async function main() {
  const wholeStart = Date.now();
  const inputFile =
    process.argv[2] ||
    path.resolve(__dirname, '..', '..', '32712250107145 (1).xlsx');

  if (!fs.existsSync(inputFile)) {
    console.error(c(RED, `Input file not found: ${inputFile}`));
    process.exit(2);
  }

  console.log(c(BOLD, '\nFinTrace NCRP — End-to-End Validation'));
  console.log(c(DIM, `  input  : ${inputFile}`));

  // Isolated DB + port so the validator doesn't collide with a running dev server.
  const dbPath = path.join(os.tmpdir(), `fintrace-e2e-${Date.now()}.sqlite`);
  const port = 4000 + Math.floor(Math.random() * 1000);
  const host = '127.0.0.1';
  console.log(c(DIM, `  db     : ${dbPath}`));
  console.log(c(DIM, `  port   : ${port}\n`));

  let server;
  let db;
  let reportId;
  let pdfPath;
  let bankCount;

  try {
    await step('1. Start server', async () => {
      const started = await startServer({ dbPath, port, host });
      server = started.server;
      db = started.db;
    });

    await step('2. Upload test Excel file', async () => {
      const res = await uploadFile(host, port, inputFile);
      if (res.status !== 202) {
        throw new Error(`expected 202, got ${res.status}: ${JSON.stringify(res.body)}`);
      }
      if (!res.body || typeof res.body.reportId !== 'number') {
        throw new Error('response missing reportId');
      }
      reportId = res.body.reportId;
    });

    await step('3. Poll until analysis complete', async () => {
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const res = await httpRequest(host, port, 'GET', `/api/ncrp/${reportId}`);
        if (res.status === 200 && res.body && res.body.analysis_status === 'complete') {
          return;
        }
        if (res.status === 200 && res.body && res.body.analysis_status === 'error') {
          throw new Error('analysis_status flipped to "error"');
        }
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error('analysis did not complete within 15s');
    });

    await step('4. Verify analysis endpoints return expected structure', async () => {
      const checks = [
        ['/transactions', (b) => Array.isArray(b.data) && typeof b.total === 'number'],
        ['/layers',       (b) => Array.isArray(b)],
        ['/mules',        (b) => Array.isArray(b)],
        ['/lien',         (b) => Array.isArray(b)],
        ['/timeline',     (b) => Array.isArray(b)],
        ['/geography',    (b) => b && Array.isArray(b.by_state) && Array.isArray(b.by_city)],
      ];
      for (const [suffix, predicate] of checks) {
        const res = await httpRequest(host, port, 'GET', `/api/ncrp/${reportId}${suffix}`);
        if (res.status !== 200) {
          throw new Error(`${suffix}: status ${res.status}`);
        }
        if (!predicate(res.body)) {
          throw new Error(`${suffix}: unexpected payload shape`);
        }
      }
    });

    await step('5. Generate PDF', async () => {
      pdfPath = path.join(os.tmpdir(), `fintrace-e2e-${reportId}.pdf`);
      await downloadFile(host, port, `/api/ncrp/${reportId}/pdf`, pdfPath);
    });

    await step('6. PDF file exists and is > 10 KB', async () => {
      const stat = fs.statSync(pdfPath);
      if (!stat.isFile()) throw new Error('not a file');
      if (stat.size <= 10 * 1024) {
        throw new Error(`PDF is only ${stat.size} bytes (expected > 10240)`);
      }
    });

    await step('7. Generate emails (via GET /emails)', async () => {
      const res = await httpRequest(host, port, 'GET', `/api/ncrp/${reportId}/emails`);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      if (!Array.isArray(res.body)) throw new Error('expected array body');
      bankCount = new Set(res.body.map((e) => e.bank_name)).size;
      if (bankCount === 0) {
        throw new Error('no draft emails generated');
      }
    });

    await step('8. Email count matches bank count', async () => {
      // The lien worksheet groups by bank — one email per bank.
      const res = await httpRequest(host, port, 'GET', `/api/ncrp/${reportId}/lien`);
      const liens = Array.isArray(res.body) ? res.body : [];
      const expectedBanks = new Set(
        liens.map((l) => (l.bank_name || 'Unknown Bank'))
      ).size;
      if (expectedBanks > 0 && expectedBanks !== bankCount) {
        throw new Error(
          `expected ${expectedBanks} email(s) (one per bank), got ${bankCount}`
        );
      }
    });

    await step('9. Delete report', async () => {
      const res = await httpRequest(host, port, 'DELETE', `/api/ncrp/${reportId}`);
      if (res.status !== 200) throw new Error(`status ${res.status}`);
      if (!res.body || res.body.deleted !== true) {
        throw new Error('response did not confirm deletion');
      }
    });

    await step('10. Cascade delete removed transactions + liens', async () => {
      const after = await httpRequest(host, port, 'GET', `/api/ncrp/${reportId}`);
      if (after.status !== 404) {
        throw new Error(`expected 404 after delete, got ${after.status}`);
      }
      // Cross-check the DB directly: no orphaned child rows.
      const txnCount = db
        .prepare('SELECT COUNT(*) AS n FROM ncrp_transactions WHERE report_id = ?')
        .get(reportId).n;
      const lienCount = db
        .prepare('SELECT COUNT(*) AS n FROM lien_records WHERE report_id = ?')
        .get(reportId).n;
      const emailCount = db
        .prepare('SELECT COUNT(*) AS n FROM draft_emails WHERE report_id = ?')
        .get(reportId).n;
      if (txnCount !== 0 || lienCount !== 0 || emailCount !== 0) {
        throw new Error(
          `orphan rows after cascade: txns=${txnCount} liens=${lienCount} emails=${emailCount}`
        );
      }
    });
  } catch (_err) {
    // step() already logged the failure; let the summary run below.
  } finally {
    if (server) {
      await new Promise((res) => server.close(() => res()));
    }
    if (pdfPath && fs.existsSync(pdfPath)) {
      try { fs.unlinkSync(pdfPath); } catch (_e) { /* ignore */ }
    }
    if (fs.existsSync(dbPath)) {
      try { fs.unlinkSync(dbPath); } catch (_e) { /* ignore */ }
      for (const suffix of ['-wal', '-shm']) {
        const aux = dbPath + suffix;
        if (fs.existsSync(aux)) {
          try { fs.unlinkSync(aux); } catch (_e) { /* ignore */ }
        }
      }
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────
  const totalMs = Date.now() - wholeStart;
  const failed = steps.filter((s) => s.status !== 'PASS').length;
  const passed = steps.filter((s) => s.status === 'PASS').length;

  console.log('');
  console.log(c(BOLD, '────────────────────────────────────────────────'));
  console.log(`  ${passed}/${steps.length} steps passed`);
  console.log(`  total runtime: ${totalMs} ms`);
  console.log(c(BOLD, '────────────────────────────────────────────────'));
  console.log('');

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(c(RED, 'fatal:'), err);
  process.exit(1);
});
