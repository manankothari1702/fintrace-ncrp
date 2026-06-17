'use strict';

/**
 * FinTrace NCRP — security audit.
 *
 * Boots the real backend in-process (same pattern as benchmark.js: throwaway DB
 * + uploads/exports dirs on a test port) and fires 10 attack vectors at the live
 * HTTP surface, asserting each is contained. Read-only against production code —
 * it only mutates its own temp DB.
 *
 * Verdicts:
 *   🛡️  PASS  — attack contained as designed.
 *   💀 FAIL  — attack succeeded / control missing (exit code 1).
 *   ⚠️  WARN  — defended, but with a caveat worth surfacing.
 *
 * Run:  node --expose-gc backend/scripts/security_audit.js
 *
 * @module backend/scripts/security_audit
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(BACKEND_DIR, '..');

// ─── Throwaway working dirs (set BEFORE requiring the route module) ─────
const TMP = path.join(os.tmpdir(), `fintrace-sec-${process.pid}-${Date.now()}`);
const UPLOADS_DIR = path.join(TMP, 'uploads');
const EXPORTS_DIR = path.join(TMP, 'exports');
const DB_PATH = path.join(TMP, 'sec.db');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

process.env.NODE_ENV = 'test'; // main server: limiters off so the upload-heavy vectors aren't throttled
process.env.FINTRACE_UPLOADS_DIR = UPLOADS_DIR;
process.env.FINTRACE_EXPORTS_DIR = EXPORTS_DIR;

const { startServer } = require(path.join(BACKEND_DIR, 'src', 'server.js'));

const HOST = '127.0.0.1';
const PORT = Number(process.env.SEC_PORT || 4199);
const RL_PORT = PORT + 1;
const BASE = `http://${HOST}:${PORT}`;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const FILES = {
  small: path.join(ROOT_DIR, '32712250107145 (1).xlsx'),            // 151 rows (case 145)
  medium: path.join(ROOT_DIR, 'BankAction_CompleteTrail.xlsx'),     // 155 rows
  large: path.join(ROOT_DIR, '32712250107170 (1).xlsx'),            // 2411 rows (case 170)
};

// ─── Reporting ──────────────────────────────────────────────────────────
const ICON = { PASS: '🛡️ ', FAIL: '💀', WARN: '⚠️ ' };
const results = [];
function record(status, title, detail) {
  results.push({ status, title });
  console.log(`${ICON[status]} ${status.padEnd(4)} | ${title}${detail ? ` — ${detail}` : ''}`);
}

// ─── HTTP helpers (global fetch) ────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  const res = await fetch(url);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_e) { body = text; }
  return { status: res.status, body };
}

async function uploadBuf(base, buffer, filename, mime) {
  const form = new FormData();
  form.append('ncrpFile', new Blob([buffer], { type: mime || XLSX_MIME }), filename);
  const res = await fetch(`${base}/api/ncrp/upload`, { method: 'POST', body: form });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch (_e) { body = text; }
  return { status: res.status, body };
}

async function uploadFile(base, filePath, filename) {
  return uploadBuf(base, fs.readFileSync(filePath), filename || path.basename(filePath), XLSX_MIME);
}

async function pollComplete(id, maxMs = 30000) {
  const start = Date.now();
  for (;;) {
    const { body } = await getJson(`${BASE}/api/ncrp/${id}`);
    if (body && body.analysis_status === 'complete') return true;
    if (body && body.analysis_status === 'error') return false;
    if (Date.now() - start > maxMs) return false;
    await sleep(15);
  }
}

/** Safe export name: no path separators, no parent-dir hops. */
const isSafeName = (n) => typeof n === 'string' && !/[\\/]|\.\./.test(n);

// ─── Main ────────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(72));
  console.log('  FinTrace NCRP — Security Audit (10 attack vectors)');
  console.log('═'.repeat(72));
  console.log(`  Node ${process.version} | port ${PORT} | temp ${TMP}`);
  console.log('');

  for (const [k, f] of Object.entries(FILES)) {
    if (!fs.existsSync(f)) console.log(`  (note: ${k} file missing: ${f})`);
  }

  const { server, db } = await startServer({ dbPath: DB_PATH, port: PORT, host: HOST });
  // Silence the route's per-request console chatter.
  const realLog = console.log;
  const quietLog = (...a) => {
    if (typeof a[0] === 'string' && a[0].startsWith('[ncrp]')) return;
    realLog(...a);
  };

  try {
    // Seed a valid, analysed report so the export vectors have a real target.
    quietLog(''); console.log = realLog;
    const seed = await uploadFile(BASE, FILES.small, 'seed.xlsx');
    const baseId = seed.body && seed.body.reportId;
    if (baseId) await pollComplete(baseId);
    console.log = quietLog;

    // ── 1) Path traversal — Excel export ────────────────────────────────
    {
      const malicious = '../../etc/passwd.xlsx';
      const url = `${BASE}/api/ncrp/${baseId}/excel?mode=file&fileName=${encodeURIComponent(malicious)}`;
      const { status, body } = await getJson(url);
      const escaped = fs.existsSync(path.resolve(EXPORTS_DIR, '../../etc/passwd.xlsx'));
      const safe = status === 400 || (status === 200 && body && isSafeName(body.fileName));
      if (safe && !escaped) {
        record('PASS', 'Path traversal (excel) blocked',
          `fileName param ignored; output sanitized to "${body && body.fileName ? body.fileName : 'n/a'}" inside EXPORTS_DIR`);
      } else {
        record('FAIL', 'Path traversal (excel)', `status=${status}, escaped=${escaped}`);
      }
    }

    // ── 2) Path traversal — PDF export ──────────────────────────────────
    {
      const malicious = '../../../windows/system32/calc.exe';
      const url = `${BASE}/api/ncrp/${baseId}/pdf?mode=file&fileName=${encodeURIComponent(malicious)}`;
      const { status, body } = await getJson(url);
      const escaped = fs.existsSync(path.resolve(EXPORTS_DIR, '../../../windows/system32/calc.exe'));
      const safe = status === 400 || (status === 200 && body && isSafeName(body.fileName));
      if (safe && !escaped) {
        record('PASS', 'Path traversal (pdf) blocked',
          `fileName param ignored; output sanitized to "${body && body.fileName ? body.fileName : 'n/a'}" inside EXPORTS_DIR`);
      } else {
        record('FAIL', 'Path traversal (pdf)', `status=${status}, escaped=${escaped}`);
      }
    }

    // ── 3) SQL injection via report id ──────────────────────────────────
    {
      const url = `${BASE}/api/ncrp/1%3BDROP%20TABLE%20ncrp_reports/dashboard`;
      const { status } = await getJson(url);
      const tableExists = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='ncrp_reports'"
      ).get();
      if (status >= 400 && status < 500 && tableExists) {
        record('PASS', 'SQL injection (report id) blocked',
          `rejected with ${status}; ncrp_reports table intact (params bound + id validated /^\\d+$/)`);
      } else {
        record('FAIL', 'SQL injection (report id)',
          `status=${status}, ncrp_reports ${tableExists ? 'intact' : 'DROPPED!'}`);
      }
    }

    // ── 4) XSS via upload filename ──────────────────────────────────────
    {
      const xssName = '<script>alert(1)</script>.xlsx';
      const up = await uploadBuf(BASE, fs.readFileSync(FILES.small), xssName, XLSX_MIME);
      const id = up.body && up.body.reportId;
      const row = id ? db.prepare('SELECT original_filename FROM ncrp_reports WHERE id = ?').get(id) : null;
      const stored = row ? row.original_filename : '';
      const clean = typeof stored === 'string' && !/[<>]/.test(stored);
      if (up.status === 202 && clean) {
        record('PASS', 'XSS filename sanitized', `stored as "${stored}" (no angle brackets)`);
      } else {
        record('FAIL', 'XSS filename', `status=${up.status}, stored="${stored}"`);
      }
    }

    // ── 5) Oversized file (51 MB) ───────────────────────────────────────
    {
      const big = Buffer.alloc(51 * 1024 * 1024, 0x50); // 51 MB > 50 MB cap
      const up = await uploadBuf(BASE, big, 'huge.xlsx', XLSX_MIME);
      const code = up.body && up.body.error && up.body.error.code;
      if (up.status === 413 && code === 'FILE_TOO_LARGE') {
        record('PASS', 'Oversized upload (51 MB) rejected', `413 ${code} (multer size limit hit before processing)`);
      } else {
        record('FAIL', 'Oversized upload (51 MB)', `status=${up.status}, code=${code}`);
      }
    }

    // ── 6) Fake Excel magic bytes (PDF header, .xlsx ext) ───────────────
    {
      const fake = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0x20)]);
      const up = await uploadBuf(BASE, fake, 'evil.xlsx', XLSX_MIME);
      const code = up.body && up.body.error && up.body.error.code;
      if (up.status === 400 && code === 'INVALID_FILE_CONTENT') {
        record('PASS', 'Fake magic bytes rejected', `400 ${code} (PDF header fails PK/OLE2 magic-byte check)`);
      } else {
        record('FAIL', 'Fake magic bytes', `status=${up.status}, code=${code}`);
      }
    }

    // ── 7) Rate limiting ────────────────────────────────────────────────
    // The main server runs with limiters off (NODE_ENV=test) so the rest of the
    // suite isn't throttled. Spin up a SECOND server with NODE_ENV unset so its
    // router builds with limiters active, then hammer /upload (configured 5/min).
    {
      let rateLimitInstalled = true;
      try { require.resolve('express-rate-limit'); } catch (_e) { rateLimitInstalled = false; }

      const prevEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production'; // make the new router's limiters active
      let rlServer;
      let upload429 = 0;
      let get429 = 0;
      try {
        const started = await startServer({ dbPath: path.join(TMP, 'rl.db'), port: RL_PORT, host: HOST });
        rlServer = started.server;
        const rlBase = `http://${HOST}:${RL_PORT}`;
        // 15 rapid GETs (general limiter = 100/min → expected to all pass).
        const gets = await Promise.all(
          Array.from({ length: 15 }, () => fetch(`${rlBase}/api/ncrp/reports`).then((r) => r.status))
        );
        get429 = gets.filter((s) => s === 429).length;
        // 15 rapid empty POSTs to /upload (strict limiter = 5/min).
        const posts = await Promise.all(
          Array.from({ length: 15 }, () =>
            fetch(`${rlBase}/api/ncrp/upload`, { method: 'POST', body: new FormData() })
              .then((r) => r.status).catch(() => 0))
        );
        upload429 = posts.filter((s) => s === 429).length;
      } finally {
        process.env.NODE_ENV = prevEnv;
        if (rlServer) await new Promise((r) => rlServer.close(r));
      }

      if (!rateLimitInstalled) {
        record('WARN', 'Rate limiting NOT enforced',
          `express-rate-limit is not installed → the route falls back to a no-op limiter. ` +
          `Configured caps (5 uploads/min, 100 req/min) are inert (0/15 uploads got 429). ` +
          `Install express-rate-limit to activate.`);
      } else if (upload429 > 0) {
        record('PASS', 'Rate limiting active',
          `${upload429}/15 rapid uploads got 429 (5/min cap); 15 GETs under the 100/min cap (${get429} throttled)`);
      } else {
        record('WARN', 'Rate limiting configured but not triggering',
          `express-rate-limit present yet 0/15 uploads returned 429 — verify the limiter wiring`);
      }
    }

    // ── 8) Concurrent uploads (5 simultaneous) ──────────────────────────
    {
      const ups = await Promise.all(
        Array.from({ length: 5 }, (_, i) => uploadFile(BASE, FILES.small, `concurrent-${i}.xlsx`))
      );
      const ids = ups.map((u) => u.body && u.body.reportId).filter((x) => typeof x === 'number');
      const distinct = new Set(ids).size === 5 && ids.length === 5;
      // Each report must own exactly its own rows (no mixing).
      let countsOk = distinct;
      for (const id of ids) {
        const n = db.prepare('SELECT COUNT(*) AS n FROM ncrp_transactions WHERE report_id = ?').get(id).n;
        if (n !== 151) countsOk = false; // FILES.small = case 145, 151 ingested rows
      }
      if (distinct && countsOk) {
        record('PASS', 'Concurrent uploads isolated',
          `5 distinct reports [${ids.join(', ')}], each with exactly 151 rows, no DB errors`);
      } else {
        record('FAIL', 'Concurrent uploads', `ids=${JSON.stringify(ids)} distinct=${distinct} countsOk=${countsOk}`);
      }
    }

    // ── 9) Data isolation between reports ───────────────────────────────
    {
      const a = await uploadFile(BASE, FILES.small, 'isolation-A.xlsx');   // 151 rows
      const b = await uploadFile(BASE, FILES.medium, 'isolation-B.xlsx');  // 155 rows
      const idA = a.body && a.body.reportId;
      const idB = b.body && b.body.reportId;
      const txA = await getJson(`${BASE}/api/ncrp/${idA}/transactions?page=1&limit=500`);
      const txB = await getJson(`${BASE}/api/ncrp/${idB}/transactions?page=1&limit=500`);
      const aOnlyA = Array.isArray(txA.body.data) && txA.body.data.every((r) => r.report_id === idA);
      const bOnlyB = Array.isArray(txB.body.data) && txB.body.data.every((r) => r.report_id === idB);
      // case 145 ingests 151 rows; BankAction ingests 154 (its 1 Old Transaction
      // row, >6mo, is excluded by the parser per the old-transaction policy).
      const totalsOk = txA.body.total === 151 && txB.body.total === 154;
      if (aOnlyA && bOnlyB && totalsOk) {
        record('PASS', 'Cross-report data isolation holds',
          `report ${idA} → ${txA.body.total} rows (all its own), report ${idB} → ${txB.body.total} rows (all its own); zero bleed`);
      } else {
        record('FAIL', 'Data isolation',
          `aOnlyA=${aOnlyA} bOnlyB=${bOnlyB} totals A=${txA.body.total}/B=${txB.body.total}`);
      }
    }

    // ── 10) Delete race condition (delete during analysis) ──────────────
    {
      const up = await uploadFile(BASE, FILES.large, 'race.xlsx'); // 2411 rows
      const id = up.body && up.body.reportId;
      // DELETE immediately (analysis runs in background via setImmediate).
      const delRes = await fetch(`${BASE}/api/ncrp/${id}`, { method: 'DELETE' });
      await sleep(200); // let any queued analysis settle
      const after = await getJson(`${BASE}/api/ncrp/${id}`);
      const orphanTxns = db.prepare('SELECT COUNT(*) AS n FROM ncrp_transactions WHERE report_id = ?').get(id).n;
      const orphanLiens = db.prepare('SELECT COUNT(*) AS n FROM lien_records WHERE report_id = ?').get(id).n;
      const health = await getJson(`${BASE}/api/health`);
      const clean = delRes.status === 200 && after.status === 404 &&
        orphanTxns === 0 && orphanLiens === 0 && health.status === 200;
      if (clean) {
        record('PASS', 'Delete-during-analysis is clean',
          `DELETE 200 → report 404, 0 orphan rows (cascade), server healthy. ` +
          `(upload file retained in UPLOADS_DIR by design for audit, not an orphan temp)`);
      } else {
        record('FAIL', 'Delete race condition',
          `del=${delRes.status} after=${after.status} orphanTxns=${orphanTxns} orphanLiens=${orphanLiens} health=${health.status}`);
      }
    }
  } finally {
    console.log = realLog;
    await new Promise((resolve) => server.close(resolve));
    try { db.close(); } catch (_e) { /* server close may have closed it */ }
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  }

  // ─── Score ──────────────────────────────────────────────────────────
  const pass = results.filter((r) => r.status === 'PASS').length;
  const warn = results.filter((r) => r.status === 'WARN').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;

  console.log('');
  console.log('═'.repeat(72));
  console.log(`  Final security score: ${pass}/10` +
    `${warn ? `  (${warn} warning${warn > 1 ? 's' : ''})` : ''}` +
    `${fail ? `  (${fail} FAIL)` : ''}`);
  if (fail === 0 && warn === 0) console.log('  Verdict: all attack vectors contained. ✅');
  else if (fail === 0) console.log('  Verdict: no breaches; warnings are hardening opportunities (see above).');
  else console.log('  Verdict: BREACH(es) found — see 💀 lines above.');
  console.log('═'.repeat(72));
  console.log('');

  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nSecurity audit crashed:', err && err.stack ? err.stack : err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  process.exit(1);
});
