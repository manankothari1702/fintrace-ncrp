'use strict';

/**
 * FinTrace NCRP — cross-consumer consistency check.
 *
 * The "confirmed cashed out" figure (capped per the CAP_AT_RECEIVED policy) is a
 * single source of truth: `summary.cashed_out`. This script proves that EVERY
 * consumer reports the SAME number, and that the recovery split reconciles to
 * 100% of the victim loss — on both verified case files.
 *
 * Asserts, per file:
 *   (a) cashed_out is identical across
 *         • the summary object           (summary.cashed_out)
 *         • the cash-out view            (cashout_analysis.total_cashout_amount)
 *         • the recovery status          (recovery_status.cashed_out)
 *         • the PDF model                (pdf _internals.cashedOutForDisplay)
 *         • the Excel model              (parsed from the generated workbook)
 *   (b) cashed_out + on_hold + refunded + recoverable_residual === victim_loss.
 *
 * Run:  node backend/scripts/consistency_test.js
 * Exit: 0 if all checks pass, 1 otherwise.
 *
 * @module backend/scripts/consistency_test
 */

const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(BACKEND_DIR, '..');

const XLSX = require(path.join(BACKEND_DIR, 'node_modules', 'xlsx'));
const { parseNcrpFile } = require(path.join(BACKEND_DIR, 'src', 'parsers', 'ncrpParser'));
const { analyzeReport } = require(path.join(BACKEND_DIR, 'src', 'analyzers', 'analyzer'));
const { initializeDatabase } = require(path.join(BACKEND_DIR, 'src', 'db', 'schema'));
const { insertReport, insertManyTransactions } =
  require(path.join(BACKEND_DIR, 'src', 'db', 'queries'));
const { generateReportExcel } = require(path.join(BACKEND_DIR, 'src', 'utils', 'excelGenerator'));
const { _internals: PDF } = require(path.join(BACKEND_DIR, 'src', 'utils', 'pdfGenerator'));

const CASE_FILES = ['32712250107145 (1).xlsx', '32712250107170 (1).xlsx'];
// Amounts agree to the paise (the policy + all reads use the same rounded value).
const EPS = 0.01;

const results = [];
function record(ok, line) {
  results.push(ok);
  console.log(`${ok ? '✅ PASS' : '❌ FAIL'} | ${line}`);
}
const eq = (a, b) => Math.abs(Number(a) - Number(b)) <= EPS;

function locate(name) {
  return [path.join(BACKEND_DIR, name), path.join(ROOT_DIR, name)].find((p) => fs.existsSync(p)) || null;
}

async function analyzeFile(filePath) {
  const db = initializeDatabase(':memory:');
  const parsed = parseNcrpFile(filePath);
  const id = insertReport(db, {
    filename: 'consistency.xlsx', original_filename: 'consistency.xlsx',
    upload_date: new Date().toISOString(), analysis_status: 'pending',
  });
  const rows = parsed.rows.map((r) => ({ ...r, report_id: id }));
  for (let i = 0; i < rows.length; i += 500) insertManyTransactions(db, rows.slice(i, i + 500));
  const txns = db.prepare('SELECT * FROM ncrp_transactions WHERE report_id = ?').all(id);
  const result = await analyzeReport(id, txns, [], { db });
  db.close();
  return { result, txns, id };
}

/** Pull the "Cashed out (ATM/POS)" amount out of the generated workbook's Summary sheet. */
function excelCashedOut(buffer) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const ws = wb.Sheets.Summary;
  if (!ws) return null;
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const row = aoa.find((r) => Array.isArray(r) && String(r[0]).startsWith('Cashed out'));
  return row ? Number(row[1]) : null;
}

async function run() {
  console.log('FinTrace NCRP — Cross-consumer consistency check\n');

  for (const name of CASE_FILES) {
    const file = locate(name);
    if (!file) { record(false, `${name}: file not found`); continue; }
    console.log(`── ${name} ──`);

    const { result, txns, id } = await analyzeFile(file);
    const s = result.summary;
    const cashoutView = result.cashout_analysis.total_cashout_amount;
    const recoveryView = result.recovery_status.cashed_out;

    // PDF model — the exact value the dossier's executive summary prints.
    const pdfView = PDF.cashedOutForDisplay(s, result.cashout_analysis);

    // Excel model — parsed from the actual generated workbook.
    const buffer = generateReportExcel({
      report: { id }, analysis: result, liens: result.lien_calculation,
      transactions: txns, ack_no: name,
    });
    const excelView = excelCashedOut(buffer);

    // (a) cashed_out identical across every consumer.
    const canonical = s.cashed_out;
    const sameAll = [cashoutView, recoveryView, pdfView, excelView].every((v) => eq(v, canonical));
    record(sameAll,
      `${name}: cashed_out identical — summary=${canonical} cashout=${cashoutView} ` +
      `recovery=${recoveryView} pdf=${pdfView} excel=${excelView}`);

    // (b) recovery split reconciles to exactly the victim loss.
    const sum = Number(s.cashed_out) + Number(s.on_hold) + Number(s.refunded) +
      Number(s.recoverable_residual);
    record(eq(sum, s.victim_loss_amount),
      `${name}: cashed_out + on_hold + refunded + recoverable_residual = ${Math.round(sum * 100) / 100} ` +
      `(victim_loss ${s.victim_loss_amount})`);
  }

  const pass = results.filter(Boolean).length;
  console.log(`\n────────────────`);
  console.log(`  ${pass}/${results.length} consistency checks passed`);
  process.exit(results.every(Boolean) ? 0 : 1);
}

run().catch((err) => {
  console.error('consistency_test crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
