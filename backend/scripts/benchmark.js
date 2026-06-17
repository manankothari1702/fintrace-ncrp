'use strict';

/**
 * FinTrace NCRP — end-to-end performance benchmark.
 *
 * Boots the real backend (in-process, on a throwaway DB + uploads/exports dirs),
 * drives the full officer workflow over HTTP for three real NCRP files, and
 * reports per-stage min/avg/max timings against the CypherSOL-beating targets.
 *
 * ── Why in-process ───────────────────────────────────────────────────
 * The server is started inside this process via startServer() so we can read
 * `process.memoryUsage().heapUsed` around the analyzer directly. The HTTP calls
 * still round-trip through the 127.0.0.1 loopback (real Express + multer +
 * better-sqlite3 path), so timings reflect the production code path; only the
 * memory probe bypasses HTTP.
 *
 * ── Stage → endpoint/event mapping ───────────────────────────────────
 * The schema's analysis_status enum is only pending|processing|complete|error —
 * there is no distinct `parsing_complete`. Parsing + the batched row insert run
 * SYNCHRONOUSLY inside the upload request, and the 202 response is sent only
 * after they finish; analysis then runs in the background (setImmediate). So:
 *
 *   Stage 1  Upload + parse + bulk insert   POST /upload  → 202 received
 *   Stage 2  Analysis                       202 → GET /:id reports 'complete'
 *   Stage 3  PDF generation                 GET /:id/pdf?mode=file   (write, no stream)
 *   Stage 4  Excel generation               GET /:id/excel?mode=file
 *   Stage 5  Lien page query                GET /:id/lien
 *   Stage 6  Transactions page query        GET /:id/transactions?page=1&limit=25
 *   Stage 7  Dashboard query                GET /:id        (what Dashboard.jsx loads;
 *                                                            there is no /:id/dashboard route)
 *   Stage 8  Total E2E (data ready)         upload start → analysis complete +
 *                                           dashboard + lien + transactions ready
 *                                           (on-demand PDF/Excel exports excluded)
 *
 * Each file runs 1 cold + N warm runs (default N=3). Cold is reported separately;
 * min/avg/max are computed over the warm runs (steady state).
 *
 * Also captured per file (one deterministic in-process pass — "micro-bench"):
 *   • Peak heapUsed across the analyzer  (process.memoryUsage().heapUsed)
 *   • DB file size after import          (main .db + -wal + -shm)
 *   • Bulk-insert throughput             (rows/sec and SQLite write-txns/sec)
 *
 * Usage:
 *   node backend/scripts/benchmark.js [--port=4187] [--warm=3] [--keep]
 *   node --expose-gc backend/scripts/benchmark.js     # cleaner memory baseline
 *
 * @module backend/scripts/benchmark
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');

// ─── Paths ───────────────────────────────────────────────────────────
const BACKEND_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(BACKEND_DIR, '..');

// ─── CLI args ────────────────────────────────────────────────────────
function argVal(name, fallback) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  return hit.slice(name.length + 3);
}
const PORT = Number(argVal('port', process.env.BENCH_PORT || 4187));
const WARM_RUNS = Math.max(1, Number(argVal('warm', 3)));
const KEEP_TMP = process.argv.includes('--keep');
const HOST = '127.0.0.1';
const BASE = `http://${HOST}:${PORT}`;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** Mirrors INSERT_BATCH_SIZE in routes/ncrp.js — rows per SQLite write-transaction. */
const INSERT_BATCH_SIZE = 500;

// ─── Throwaway working dirs (must be set BEFORE requiring the server, since
//     routes/ncrp.js reads these env vars at module-load time) ──────────
const TMP = path.join(
  os.tmpdir(),
  `fintrace-bench-${process.pid}-${Date.now()}`
);
const UPLOADS_DIR = path.join(TMP, 'uploads');
const EXPORTS_DIR = path.join(TMP, 'exports');
const DB_PATH = path.join(TMP, 'fintrace-bench.db');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(EXPORTS_DIR, { recursive: true });

process.env.NODE_ENV = 'test'; // disables the per-route rate limiters (5 uploads/min cap)
process.env.FINTRACE_UPLOADS_DIR = UPLOADS_DIR;
process.env.FINTRACE_EXPORTS_DIR = EXPORTS_DIR;

// Require AFTER the env is set so the route module picks up the temp dirs.
const { startServer } = require(path.join(BACKEND_DIR, 'src', 'server.js'));
const { parseNcrpFile } = require(path.join(BACKEND_DIR, 'src', 'parsers', 'ncrpParser'));
const { analyzeReport } = require(path.join(BACKEND_DIR, 'src', 'analyzers', 'analyzer'));
const { initializeDatabase } = require(path.join(BACKEND_DIR, 'src', 'db', 'schema'));
const {
  insertReport,
  insertManyTransactions,
} = require(path.join(BACKEND_DIR, 'src', 'db', 'queries'));

// ─── Files under test → target tiers ──────────────────────────────────
// Real NCRP case files, mapped to tiers by row count (smallest → Small).
// Note: the two ~150-row cases are the same size class — there is no genuine
// "tiny" sample any more, so Small/Medium ceilings are equal and Large is the
// only distinct performance tier.
const FILES = [
  { tier: 'Small',  rows: 151,  targetMs: 3000,  file: path.join(ROOT_DIR, '32712250107145 (1).xlsx') },
  { tier: 'Medium', rows: 155,  targetMs: 3000,  file: path.join(ROOT_DIR, 'BankAction_CompleteTrail.xlsx') },
  { tier: 'Large',  rows: 2411, targetMs: 15000, file: path.join(ROOT_DIR, '32712250107170 (1).xlsx') },
];

const STAGES = [
  { key: 'stage1', label: '1. Upload + parse' },
  { key: 'stage2', label: '2. Analysis' },
  { key: 'stage3', label: '3. PDF generation' },
  { key: 'stage4', label: '4. Excel generation' },
  { key: 'stage5', label: '5. Lien query' },
  { key: 'stage6', label: '6. Transactions query' },
  { key: 'stage7', label: '7. Dashboard query' },
  { key: 'stage8', label: '8. Total E2E (data ready)' },
];

// ─── Small helpers ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : '—');
const kb = (bytes) => (bytes / 1024).toFixed(1);
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(2);

function stats(arr) {
  const min = Math.min(...arr);
  const max = Math.max(...arr);
  const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
  return { min, avg, max };
}

/** Total on-disk DB footprint: main file + WAL + shared-memory index. */
function dbFootprint(dbPath) {
  let total = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try { total += fs.statSync(dbPath + suffix).size; } catch (_e) { /* not present */ }
  }
  return total;
}

/** Time a GET, fully draining the body so transfer + server work are included. */
async function timeGet(url) {
  const t0 = performance.now();
  const res = await fetch(url);
  await res.arrayBuffer();
  const dt = performance.now() - t0;
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  return dt;
}

/** Poll GET /:id until analysis settles; returns the completion timestamp. */
async function pollUntilComplete(id, maxMs = 60000) {
  const start = performance.now();
  for (;;) {
    const res = await fetch(`${BASE}/api/ncrp/${id}`);
    const body = await res.json();
    if (body.analysis_status === 'complete') return performance.now();
    if (body.analysis_status === 'error') {
      throw new Error(`Analysis failed for report ${id}`);
    }
    if (performance.now() - start > maxMs) {
      throw new Error(`Analysis timed out (${maxMs}ms) for report ${id}`);
    }
    await sleep(4); // tight poll: analysis blocks the loop, so this adds ≤4ms slack
  }
}

/** One full workflow pass for a file; returns per-stage timings (ms) + ids. */
async function runOnce(file) {
  const buf = fs.readFileSync(file.file);
  const t = {};

  // ── Stage 1: upload → 202 (parse + batched insert happen before the reply) ──
  const tStart = performance.now();
  const form = new FormData();
  form.append('ncrpFile', new Blob([buf], { type: XLSX_MIME }), path.basename(file.file));
  const upRes = await fetch(`${BASE}/api/ncrp/upload`, { method: 'POST', body: form });
  if (upRes.status !== 202) {
    throw new Error(`upload → ${upRes.status}: ${await upRes.text()}`);
  }
  const up = await upRes.json();
  const tUploaded = performance.now();
  t.stage1 = tUploaded - tStart;
  const id = up.reportId;
  t.reportId = id;
  t.rowCount = up.rowCount;

  // ── Stage 2: background analysis ──
  const tAnalysed = await pollUntilComplete(id);
  t.stage2 = tAnalysed - tUploaded;

  // ── View data (the dashboard + main pages a user lands on) ──
  t.stage7 = await timeGet(`${BASE}/api/ncrp/${id}`);                              // dashboard
  t.stage5 = await timeGet(`${BASE}/api/ncrp/${id}/lien`);                         // lien page
  t.stage6 = await timeGet(`${BASE}/api/ncrp/${id}/transactions?page=1&limit=25`); // txn page
  t.stage8 = performance.now() - tStart; // E2E: upload → all view data ready

  // ── On-demand exports (measured, but NOT part of E2E "data ready") ──
  t.stage3 = await timeGet(`${BASE}/api/ncrp/${id}/pdf?mode=file`);
  t.stage4 = await timeGet(`${BASE}/api/ncrp/${id}/excel?mode=file`);

  return t;
}

/**
 * Deterministic in-process pass: precise insert throughput + analyzer heap.
 * Uses its own throwaway DB so it never perturbs the HTTP-run DB.
 */
async function microBench(file) {
  const dbPath = path.join(TMP, `micro-${file.tier}.db`);
  const db = initializeDatabase(dbPath);
  try {
    const p0 = performance.now();
    const parsed = parseNcrpFile(file.file);
    const parseMs = performance.now() - p0;
    const rows = (parsed.rows || []).map((r) => ({ ...r }));
    const rowCount = rows.length;

    const reportId = insertReport(db, {
      filename: 'micro.xlsx',
      original_filename: 'micro.xlsx',
      upload_date: new Date().toISOString(),
      analysis_status: 'pending',
    });
    const withId = rows.map((r) => ({ ...r, report_id: reportId }));

    // Mirror the route exactly: INSERT_BATCH_SIZE rows per SQLite write-txn.
    let numBatches = 0;
    const i0 = performance.now();
    for (let i = 0; i < withId.length; i += INSERT_BATCH_SIZE) {
      insertManyTransactions(db, withId.slice(i, i + INSERT_BATCH_SIZE));
      numBatches += 1;
    }
    const insertMs = performance.now() - i0;

    // Re-read so each row carries its primary key (analyzer writes cashout cols back).
    const txnRows = db.prepare(
      'SELECT * FROM ncrp_transactions WHERE report_id = ?'
    ).all(reportId);

    if (typeof global.gc === 'function') global.gc();
    const heapBefore = process.memoryUsage().heapUsed;
    const a0 = performance.now();
    await analyzeReport(reportId, txnRows, [], { db });
    const analyzeMs = performance.now() - a0;
    let heapPeak = process.memoryUsage().heapUsed;
    // A few extra reads in case allocation settled after the return.
    for (let k = 0; k < 3; k += 1) {
      const h = process.memoryUsage().heapUsed;
      if (h > heapPeak) heapPeak = h;
    }

    const insertSec = insertMs / 1000;
    return {
      rowCount,
      parseMs,
      insertMs,
      analyzeMs,
      numBatches,
      rowsPerSec: insertSec > 0 ? rowCount / insertSec : Infinity,
      txnsPerSec: insertSec > 0 ? numBatches / insertSec : Infinity,
      heapBefore,
      heapPeak,
      heapDelta: heapPeak - heapBefore,
      dbBytes: dbFootprint(dbPath),
    };
  } finally {
    try { db.close(); } catch (_e) { /* ignore */ }
  }
}

// ─── Box-drawing table renderer ─────────────────────────────────────────
function renderTable(headers, rows, aligns) {
  const widths = headers.map((h, i) => {
    const cells = [h, ...rows.map((r) => String(r[i]))];
    return Math.max(...cells.map((c) => c.length)) + 2; // 1 space padding each side
  });
  const cell = (text, i) => {
    const inner = widths[i] - 2;
    const s = String(text);
    return ` ${aligns[i] === 'r' ? s.padStart(inner) : s.padEnd(inner)} `;
  };
  const line = (l, m, r) => l + widths.map((w) => '═'.repeat(w)).join(m) + r;
  const out = [];
  out.push(line('╔', '╦', '╗'));
  out.push('║' + headers.map((h, i) => cell(h, i)).join('║') + '║');
  out.push(line('╠', '╬', '╣'));
  for (const row of rows) {
    out.push('║' + row.map((c, i) => cell(c, i)).join('║') + '║');
  }
  out.push(line('╚', '╩', '╝'));
  return out.join('\n');
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(72));
  console.log('  FinTrace NCRP — Performance Benchmark');
  console.log('═'.repeat(72));
  console.log(`  Node ${process.version}  |  port ${PORT}  |  runs: 1 cold + ${WARM_RUNS} warm`);
  console.log(`  Temp workdir: ${TMP}`);
  if (typeof global.gc !== 'function') {
    console.log('  NOTE: run with `node --expose-gc` for a cleaner heap baseline.');
  }
  console.log('');

  // Silence the server's per-request route chatter ([ncrp] GET .../pdf …) so the
  // benchmark tables stay readable. Our own lines never carry that prefix.
  const realLog = console.log;
  console.log = (...args) => {
    if (typeof args[0] === 'string' && args[0].startsWith('[ncrp]')) return;
    realLog(...args);
  };

  // Verify the files exist up front.
  const missing = FILES.filter((f) => !fs.existsSync(f.file));
  if (missing.length) {
    console.error('Missing benchmark files:');
    for (const m of missing) console.error(`  • ${m.tier}: ${m.file}`);
    throw new Error('Cannot run: one or more NCRP files are missing.');
  }

  const { server, db } = await startServer({ dbPath: DB_PATH, port: PORT, host: HOST });
  // Confirm liveness before timing anything.
  await timeGet(`${BASE}/api/health`);

  const summary = [];

  try {
    for (const file of FILES) {
      console.log(`\n${'─'.repeat(72)}`);
      console.log(`  ${file.tier} file — ${path.basename(file.file)}  (~${file.rows} rows, target < ${file.targetMs} ms)`);
      console.log('─'.repeat(72));

      // Deterministic micro-bench: insert throughput + analyzer heap.
      const micro = await microBench(file);

      // Cold run + warm runs over HTTP.
      const runs = [];
      for (let i = 0; i <= WARM_RUNS; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        runs.push(await runOnce(file));
      }
      const cold = runs[0];
      const warm = runs.slice(1);
      const dbAfter = dbFootprint(DB_PATH);

      // Build the stage table (min/avg/max over warm runs).
      const tableRows = STAGES.map((st) => {
        const s = stats(warm.map((r) => r[st.key]));
        let target = '—';
        if (st.key === 'stage8') {
          const pass = s.avg < file.targetMs;
          target = `< ${file.targetMs}  ${pass ? '✓ PASS' : '✗ FAIL'}`;
        }
        return [st.label, fmt(s.min), fmt(s.avg), fmt(s.max), target];
      });

      console.log('');
      console.log(renderTable(
        ['Stage', 'Min (ms)', 'Avg (ms)', 'Max (ms)', 'Target'],
        tableRows,
        ['l', 'r', 'r', 'r', 'l'],
      ));

      const e2e = stats(warm.map((r) => r.stage8));
      const verdict = e2e.avg < file.targetMs ? 'PASS ✓' : 'FAIL ✗';
      console.log('');
      console.log(`  Cold start (run 1) total E2E : ${fmt(cold.stage8)} ms`);
      console.log(`  Warm E2E vs target           : ${fmt(e2e.avg)} ms avg / ${fmt(e2e.max)} ms max  vs  ${file.targetMs} ms  →  ${verdict}`);
      console.log(`  Rows parsed (reported)       : ${cold.rowCount}`);
      console.log('');
      console.log('  Bulk insert (isolated, in-process):');
      console.log(`    • rows inserted            : ${micro.rowCount} in ${fmt(micro.insertMs)} ms  (parse ${fmt(micro.parseMs)} ms)`);
      console.log(`    • throughput               : ${Math.round(micro.rowsPerSec).toLocaleString()} rows/sec`);
      console.log(`    • SQLite write-txns        : ${micro.numBatches} (${INSERT_BATCH_SIZE}/txn) → ${Math.round(micro.txnsPerSec).toLocaleString()} txns/sec`);
      console.log('  Analysis (isolated, in-process):');
      console.log(`    • analyzer time            : ${fmt(micro.analyzeMs)} ms`);
      console.log(`    • heap baseline            : ${mb(micro.heapBefore)} MB`);
      console.log(`    • peak heapUsed            : ${mb(micro.heapPeak)} MB  (Δ ${mb(micro.heapDelta)} MB over baseline)`);
      console.log(`  DB footprint after import    : ${kb(dbAfter)} KB  (db + wal + shm, cumulative across runs)`);

      summary.push({
        tier: file.tier,
        targetMs: file.targetMs,
        coldMs: cold.stage8,
        avgMs: e2e.avg,
        maxMs: e2e.max,
        pass: e2e.avg < file.targetMs,
        rowsPerSec: micro.rowsPerSec,
        heapPeak: micro.heapPeak,
      });
    }

    // ── Final summary ──
    console.log(`\n${'═'.repeat(72)}`);
    console.log('  SUMMARY — Total E2E (warm) vs CypherSOL-beating targets');
    console.log('═'.repeat(72));
    console.log('');
    console.log(renderTable(
      ['Tier', 'Cold (ms)', 'Warm avg', 'Warm max', 'Target', 'Verdict'],
      summary.map((s) => [
        s.tier,
        fmt(s.coldMs),
        fmt(s.avgMs),
        fmt(s.maxMs),
        `< ${s.targetMs}`,
        s.pass ? 'PASS ✓' : 'FAIL ✗',
      ]),
      ['l', 'r', 'r', 'r', 'r', 'l'],
    ));
    const allPass = summary.every((s) => s.pass);
    console.log('');
    console.log(`  Overall: ${allPass ? 'ALL TARGETS MET ✓' : 'SOME TARGETS MISSED ✗'}`);
    console.log('');

    // Non-zero exit if any tier missed its target (useful for CI gating).
    process.exitCode = allPass ? 0 : 1;
  } finally {
    console.log = realLog;
    await new Promise((resolve) => server.close(resolve));
    try { db.close(); } catch (_e) { /* server 'close' may already have closed it */ }
    if (!KEEP_TMP) {
      try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
    } else {
      console.log(`  (kept temp workdir: ${TMP})`);
    }
  }
}

main().catch((err) => {
  console.error('\nBenchmark failed:', err && err.stack ? err.stack : err);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_e) { /* best effort */ }
  process.exit(1);
});
