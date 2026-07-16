'use strict';

/**
 * FinTrace Bank Statement — cross-format reconciliation report.
 *
 * Parses the SAME account's PNB statement from Excel and from PDF and
 * verifies both parsers produce the same transactions (count, dates,
 * directions, amounts, balances) plus whitespace-insensitive narrations.
 * This is the accuracy anchor for bank-statement ingestion, analogous to
 * scripts/accuracy_test.js for the NCRP engine.
 *
 * Usage:
 *   node scripts/bank_statement_reconcile.js [statement.xls] [statement.pdf]
 *   (defaults to the checked-in PNB fixtures)
 *
 * Exit code 0 when everything matches, 1 on any mismatch.
 */

const path = require('path');

const { parsePnbExcel } = require('../src/parsers/bankStatement/pnbExcel');
const { parsePnbPdf } = require('../src/parsers/bankStatement/pnbPdf');
const { reconcileStatements } = require('../src/parsers/bankStatement/reconcile');

const FIXTURES = path.join(__dirname, '..', 'src', '__tests__', 'fixtures');
const excelPath = process.argv[2] || path.join(FIXTURES, 'pnb_statement.xls');
const pdfPath = process.argv[3] || path.join(FIXTURES, 'pnb_statement.pdf');

const line = '─'.repeat(56);

async function main() {
  console.log(line);
  console.log('  Bank-statement cross-format reconciliation (PNB)');
  console.log(line);
  console.log(`  Excel: ${excelPath}`);
  console.log(`  PDF:   ${pdfPath}`);

  const excel = parsePnbExcel(excelPath);
  const pdf = await parsePnbPdf(pdfPath);
  const r = reconcileStatements(excel, pdf);

  console.log(line);
  console.log(`  Account: ${excel.account.account_number} (${excel.account.account_holder || 'unknown holder'})`);
  console.log(`  Period:  ${excel.account.statement_period_from} → ${excel.account.statement_period_to}`);
  console.log(line);
  console.log(`  Excel transactions: ${r.excelCount}`);
  console.log(`  PDF transactions:   ${r.pdfCount}`);
  console.log(`  Hard-field matched: ${r.matched}/${r.compared} (date, direction, amount, balance)`);
  console.log(`  Hard mismatches:    ${r.mismatches.length}`);
  console.log(`  Narrations equal:   ${r.narrationMatched}/${r.compared} (whitespace-insensitive)`);
  console.log(`  Account metadata:   ${r.accountMismatches.length === 0 ? 'match' : 'MISMATCH'}`);

  for (const m of r.mismatches.slice(0, 20)) {
    console.log(`    ✗ row ${m.index} ${m.field}: excel=${JSON.stringify(m.excel)} pdf=${JSON.stringify(m.pdf)}`);
  }
  for (const m of r.narrationMismatches.slice(0, 10)) {
    console.log(`    ~ row ${m.index} narration: excel=${JSON.stringify(m.excel)} pdf=${JSON.stringify(m.pdf)}`);
  }
  for (const m of r.accountMismatches) {
    console.log(`    ✗ account ${m.field}: excel=${JSON.stringify(m.excel)} pdf=${JSON.stringify(m.pdf)}`);
  }

  const warnings = [...excel.warnings, ...pdf.warnings];
  if (warnings.length > 0) {
    console.log(line);
    for (const w of warnings) console.log(`  ⚠ ${w}`);
  }

  console.log(line);
  const narrOk = r.narrationMismatches.length === 0;
  if (r.ok && narrOk) {
    console.log('  ✅ PASS — Excel and PDF parsers agree on every transaction');
  } else {
    console.log('  ❌ FAIL — parsers disagree (see mismatches above)');
  }
  console.log(line);
  process.exit(r.ok && narrOk ? 0 : 1);
}

main().catch((err) => {
  console.error('Reconciliation failed to run:', err && err.message ? err.message : err);
  process.exit(1);
});
