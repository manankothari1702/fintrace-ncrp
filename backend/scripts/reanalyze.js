'use strict';

/**
 * FinTrace NCRP — re-analyze existing reports in place.
 *
 * One-off backfill: re-runs the analyzer over every already-ingested report so
 * stored, date-derived figures pick up an analyzer change WITHOUT requiring the
 * officer to re-upload each file. Written for the date-timezone fix (Transactions
 * audit #1): the analyzer's calendar-day logic (istDayKey / dayOfWeek /
 * fraud_start_date) was double-shifting IST, which affects same-day-cashout
 * counts, the Timeline buckets, the day-of-week breakdown, and milestone dates.
 * It also stamps the new per-row `is_duplicate` flag (audit #4).
 *
 * What it touches:
 *   • ncrp_transactions.{same_day_cashout, cashout_mode, is_duplicate} — via the
 *     analyzer's own write-back (analyzeReport with { db }).
 *   • ncrp_reports.{analysis_json, total_transactions, total_disputed_amount,
 *     total_layers, fraud_start_date} — the refreshed analysis snapshot.
 *
 * What it deliberately leaves alone (all date-independent):
 *   • layer_analysis / lien_records / draft_emails — amounts & counts, unchanged
 *     by the date fix; the layers endpoint reads layer_analysis from the snapshot
 *     anyway. (A full re-upload would rewrite these to identical values.)
 *
 * repeat_accounts IS refreshed: the registry is now a per-report contribution
 * ledger (queries.replaceReportRepeatContributions), so re-recording a report's
 * contribution REPLACES it instead of inflating appearance_count — this script
 * historically had to skip the registry precisely because the old upsert
 * double-counted on every rerun.
 *
 * Usage:  node scripts/reanalyze.js [path/to/fintrace.db]
 *   (defaults to the dev DB: backend/data/fintrace.db)
 */

const path = require('path');
const { initializeDatabase } = require('../src/db/schema');
const { analyzeReport } = require('../src/analyzers/analyzer');
const {
  getReportById,
  updateReportAnalysis,
  replaceReportRepeatContributions,
} = require('../src/db/queries');

async function main() {
  const dbPath = process.argv[2]
    ? path.resolve(process.argv[2])
    : path.resolve(__dirname, '..', 'data', 'fintrace.db');

  // initializeDatabase applies COLUMN_MIGRATIONS (adds is_duplicate if missing).
  const db = initializeDatabase(dbPath);
  console.log(`[reanalyze] DB: ${dbPath}`);

  const reports = db.prepare(
    "SELECT id, original_filename FROM ncrp_reports WHERE analysis_status = 'complete' ORDER BY id ASC"
  ).all();
  console.log(`[reanalyze] ${reports.length} complete report(s) to refresh\n`);

  for (const r of reports) {
    // id ASC so the FIRST occurrence of each exact-duplicate key (the one the
    // dedup keeps) is the lowest-id row — matching a fresh ingest's row order.
    const rows = db.prepare(
      'SELECT * FROM ncrp_transactions WHERE report_id = ? ORDER BY id ASC'
    ).all(r.id);
    const repeats = db.prepare('SELECT * FROM repeat_accounts').all();

    // { db } → analyzer writes same_day_cashout / cashout_mode / is_duplicate back.
    // eslint-disable-next-line no-await-in-loop
    const result = await analyzeReport(r.id, rows, repeats, { db });

    // Carry the parsed Old-Transaction + parse-warning side-channels into the
    // refreshed snapshot, exactly as the upload route does.
    const rep = getReportById(db, r.id);
    if (rep && rep.old_transactions) {
      try {
        const o = JSON.parse(rep.old_transactions);
        if (Array.isArray(o) && o.length) result.old_transactions = o;
      } catch (_e) { /* malformed → omit */ }
    }
    if (rep && rep.parse_warnings) {
      try {
        const p = JSON.parse(rep.parse_warnings);
        if (Array.isArray(p) && p.length) result.parse_warnings = p;
      } catch (_e) { /* malformed → omit */ }
    }

    updateReportAnalysis(db, r.id, {
      analysis_status: 'complete',
      analysis_json: JSON.stringify(result),
      total_transactions: result.summary.total_transactions,
      total_disputed_amount: result.summary.total_disputed_amount,
      total_layers: result.summary.total_layers,
      fraud_start_date: result.summary.fraud_start_date,
    });

    // Refresh this report's cross-case registry contribution (idempotent
    // replace — safe to rerun, unlike the legacy increment-on-upsert).
    replaceReportRepeatContributions(db, r.id,
      result.mule_detection.map((m) => ({
        account_no: m.account_no,
        bank_name: m.bank_name,
        amount_passed: m.total_received,
        mule_score: m.mule_score,
      })));

    const dupCount = result.summary.duplicate_count;
    const sdc = result.cashout_analysis.same_day_cashouts;
    console.log(
      `  ✓ report ${r.id} (${r.original_filename}) — ` +
      `txns_updated=${result.transactions_updated} duplicates=${dupCount} ` +
      `same_day_cashouts=${sdc} fraud_start=${result.summary.fraud_start_date}`
    );
  }

  db.close();
  console.log('\n[reanalyze] done.');
}

main().catch((err) => {
  console.error('[reanalyze] FAILED:', err);
  process.exit(1);
});
