'use strict';

/**
 * Suspected-duplicate flagging (court-facing, NON-DESTRUCTIVE). Locks the
 * Phase-C contract on the real CypherSOL gold case …145:
 *
 *   • every row is RETAINED — the analyzer's deduped `rows` and the capped
 *     recovery / lien / victim-loss figures are byte-identical to before;
 *   • the additive raw/deduped metrics reconcile exactly:
 *       transaction_count_raw      151
 *       transaction_count_deduped  144   (151 − 5 exact − 2 probable)
 *       uncapped_trail_raw         679429.96   (every cash-exit leg)
 *       uncapped_trail_deduped     619429.96   (raw − ₹60,000 exact impact)
 *       probable_duplicate_impact   30000       (separate, pending)
 *       619429.96 − 30000 ==        589429.96
 *   • the anchor pair {acct 50100851063711, UTR 270324046951, 20000/20000}
 *     classifies as exact_duplicate.
 *
 * Driven through the actual parser + analyzer, plus the classifier unit.
 */

const fs = require('fs');
const path = require('path');

const { parseNcrpFile } = require('../parsers/ncrpParser');
const { analyzeReport, _internals } = require('../analyzers/analyzer');

const GOLD_PATH = path.join(__dirname, '..', '..', '..', '32712250107145 (1).xlsx');

let analysis;
let classified;

beforeAll(async () => {
  expect(fs.existsSync(GOLD_PATH)).toBe(true);
  const parsed = parseNcrpFile(GOLD_PATH);
  expect(parsed.errors).toEqual([]);
  const txnRows = parsed.rows.map((r, i) => ({ id: i + 1, ...r }));
  analysis = await analyzeReport(1, txnRows, []);
  const enriched = _internals.enrichTransactions(txnRows);
  classified = _internals.classifyDuplicates(enriched);
}, 60000);

describe('classifier counts', () => {
  test('5 exact + 2 probable duplicate rows', () => {
    expect(classified.exact_rows).toBe(5);
    expect(classified.probable_rows).toBe(2);
  });

  test('every input row is retained (nothing removed)', () => {
    const total = classified.rows.length;
    expect(total).toBe(151);
  });

  test('anchor pair {50100851063711 / 270324046951 / 20000 / disp 20000} is exact_duplicate', () => {
    const stripped = (s) => String(s).replace(/^0+/, '');
    const anchorDup = classified.rows.find((r) =>
      stripped(r.beneficiary_account) === '50100851063711' &&
      String(r.utr_no) === '270324046951' &&
      Number(r.transaction_amount) === 20000 &&
      Number(r.disputed_amount) === 20000 &&
      r.dup_status === 'exact_duplicate');
    expect(anchorDup).toBeTruthy();
    expect(anchorDup.dup_of).toBeTruthy();
  });

  test('the same account/UTR leg with disputed 9963.48 is probable_duplicate', () => {
    const stripped = (s) => String(s).replace(/^0+/, '');
    const prob = classified.rows.find((r) =>
      stripped(r.beneficiary_account) === '50100851063711' &&
      String(r.utr_no) === '270324046951' &&
      Number(r.disputed_amount) === 9963.48);
    expect(prob).toBeTruthy();
    expect(prob.dup_status).toBe('probable_duplicate');
  });
});

describe('additive metrics (suspected_duplicates.metrics)', () => {
  let m;
  beforeAll(() => { m = analysis.suspected_duplicates.metrics; });

  test('counts', () => {
    expect(m.transaction_count_raw).toBe(151);
    expect(m.transaction_count_deduped).toBe(144);
    expect(m.exact_duplicate_rows).toBe(5);
    expect(m.probable_duplicate_rows).toBe(2);
  });

  test('uncapped trail anchors (exact rupee values)', () => {
    expect(m.uncapped_trail_raw).toBe(679429.96);
    expect(m.exact_duplicate_impact).toBe(60000);
    expect(m.uncapped_trail_deduped).toBe(619429.96);
    expect(m.probable_duplicate_impact).toBe(30000);
    expect(m.uncapped_trail_if_probable_confirmed).toBe(589429.96);
    // The pending chain foots exactly.
    expect(Math.round((m.uncapped_trail_deduped - m.probable_duplicate_impact) * 100) / 100)
      .toBe(589429.96);
  });
});

describe('capped / GOLD figures are unchanged (non-destructive)', () => {
  test('victim loss, capped cash-out, lien total, layer count intact', () => {
    expect(analysis.summary.victim_loss_amount).toBe(1065298);
    expect(analysis.summary.cashed_out).toBe(544282.95);
    expect(analysis.summary.lien_table_total).toBe(424394.61);
    expect(analysis.summary.total_layers).toBe(7);
    // Legacy uncapped cash-out field is untouched (current shipping figure).
    expect(analysis.cashout_analysis.total_cashout_amount_uncapped).toBe(609429.96);
  });

  test('summary surfaces the new metrics alongside the legacy ones', () => {
    expect(analysis.summary.total_transactions).toBe(151);
    expect(analysis.summary.transaction_count_raw).toBe(151);
    expect(analysis.summary.transaction_count_deduped).toBe(144);
    expect(analysis.summary.uncapped_trail_raw).toBe(679429.96);
    expect(analysis.summary.uncapped_trail_deduped).toBe(619429.96);
    expect(analysis.summary.probable_duplicate_impact).toBe(30000);
  });
});
