'use strict';

/**
 * Single-statement analysis engine — aggregation, counterparty grouping,
 * top-N. The correctness anchor: the summary's in/out totals must reconcile
 * EXACTLY with the ingestion-level sums verified in pnbExcel.test.js
 * (85 debits ₹50,196.00 / 11 credits ₹43,852.00 on the PNB fixture).
 */

const path = require('path');

const { analyzeStatement, _internals } = require('../analysis/bankStatementAnalyzer');
const { enrichTransactions } = require('../parsers/bankStatement/counterparty');
const { parsePnbExcel } = require('../parsers/bankStatement/pnbExcel');
const T = require('../config/bankStatementThresholds');

const FIXTURE = path.join(__dirname, 'fixtures', 'pnb_statement.xls');

/** Analysis of the real PNB fixture (parsed + extracted, like ingest does). */
function analyzePnbFixture() {
  const parsed = parsePnbExcel(FIXTURE);
  const txns = enrichTransactions(parsed.transactions);
  return analyzeStatement({
    statement_period_from: parsed.account.statement_period_from,
    statement_period_to: parsed.account.statement_period_to,
  }, txns);
}

/** Minimal enriched-row factory for synthetic cases. */
function row(over = {}) {
  return {
    id: over.id,
    txn_date: '2026-06-10T00:00:00.000Z',
    narration: 'X',
    debit_amount: null,
    credit_amount: null,
    balance: null,
    counterparty_name: null,
    counterparty_bank_code: null,
    counterparty_ifsc: null,
    counterparty_vpa: null,
    counterparty_phone: null,
    txn_channel: 'UPI',
    extraction_confidence: 'high',
    source_row: over.id,
    ...over,
  };
}

describe('in/out aggregation — reconciles exactly with ingestion totals', () => {
  const analysis = analyzePnbFixture();

  test('the PNB fixture headline numbers', () => {
    expect(analysis.summary).toEqual({
      total_credit: 43852,
      total_debit: 50196,
      net_flow: -6344,
      credit_count: 11,
      debit_count: 85,
      txn_count: 96,
      period_from: '2026-06-02T00:00:00.000Z',
      period_to: '2026-07-02T00:00:00.000Z',
      opening_balance: 8618.95,
      closing_balance: 2274.95,
      ledger_order: 'newest-first',
      low_confidence_count: 0,
      non_counterparty_count: 1, // the interest posting
    });
  });

  test('net flow is internally consistent with the balance movement', () => {
    const s = analysis.summary;
    expect(s.closing_balance - s.opening_balance).toBeCloseTo(s.net_flow, 2);
  });

  test('oldest-first ledgers orient correctly too', () => {
    const txns = [
      row({ id: 1, txn_date: '2026-06-01T00:00:00.000Z', credit_amount: 1000, balance: 2000 }),
      row({ id: 2, txn_date: '2026-06-05T00:00:00.000Z', debit_amount: 300, balance: 1700 }),
    ];
    const s = analyzeStatement({}, txns).summary;
    expect(s.ledger_order).toBe('oldest-first');
    expect(s.opening_balance).toBe(1000); // 2000 − (+1000)
    expect(s.closing_balance).toBe(1700);
  });

  test('ambiguous single-day ledgers admit unknown order (no guessed balances)', () => {
    const txns = [
      row({ id: 1, credit_amount: 10, balance: 110 }),
      row({ id: 2, debit_amount: 5, balance: 105 }),
    ];
    const s = analyzeStatement({}, txns).summary;
    expect(s.ledger_order).toBe('unknown');
    expect(s.opening_balance).toBeNull();
    expect(s.closing_balance).toBeNull();
  });
});

describe('counterparty distribution — grouping rules', () => {
  const analysis = analyzePnbFixture();
  const byKey = new Map(analysis.counterparties.map((c) => [c.key, c]));

  test('70 distinct counterparties on the fixture; none unattributed', () => {
    expect(analysis.counterparties).toHaveLength(70);
    expect(analysis.unattributed_count).toBe(0);
    expect(analysis.low_confidence_counterparty_count).toBe(0);
  });

  test('VPA is the primary key: Mr Rajne merges 10 txns across case-variant names', () => {
    const rajne = byKey.get('vpa:8375839800@ptye');
    expect(rajne).toMatchObject({
      id_kind: 'vpa',
      confidence: 'high',
      display_name: 'MR RAJNE',
      txn_count: 10,
      sent_count: 9,
      received_count: 1,
      sent_total: 3850,
      received_total: 1,
      net: -3849,
    });
    expect(rajne.first_seen).toBe('2026-06-02T00:00:00.000Z');
    expect(rajne.last_seen).toBe('2026-06-26T00:00:00.000Z');
    expect(rajne.txn_ids).toHaveLength(10);
  });

  test('NEFT counterparties key on IFSC+name (both M INTERGRAPH credits merge)', () => {
    const intergraph = byKey.get('ifsc:HDFC0000240|name:M INTERGRAPH SYSTEMS PVT');
    expect(intergraph).toMatchObject({
      id_kind: 'ifsc+name',
      received_total: 23180,
      sent_total: 0,
      txn_count: 2,
      bank_code: 'HDFC',
    });
  });

  test('IMPS counterparties key on phone', () => {
    const dream = byKey.get('phone:919999999999');
    expect(dream).toMatchObject({ id_kind: 'phone', display_name: 'DREAMPLU', received_total: 16000 });
  });

  test('a shared merchant QR (same VPA, different payee labels) is ONE counterparty with alternates', () => {
    const qr = byKey.get('vpa:paytmqr28100505');
    expect(qr.txn_count).toBe(2);
    expect(qr.names.sort()).toEqual(['PAPPU KU', 'VIKAS JA']);
  });

  test('non-counterparty rows (interest) stay out of the distribution', () => {
    const total = analysis.counterparties.reduce((s, c) => s + c.txn_count, 0);
    expect(total).toBe(95); // 96 − 1 interest posting
  });

  test('LOW-confidence rows group separately — never merged into a high-confidence identity', () => {
    const txns = [
      row({ id: 1, counterparty_vpa: 'shop@upi', counterparty_name: 'SHOP', debit_amount: 100 }),
      row({ id: 2, counterparty_vpa: 'shop@upi', counterparty_name: 'SHOP', debit_amount: 50 }),
      row({
        id: 3, counterparty_vpa: 'shop@upi', counterparty_name: 'SHOP',
        debit_amount: 25, extraction_confidence: 'low',
      }),
    ];
    const a = analyzeStatement({}, txns);
    expect(a.counterparties).toHaveLength(2);
    const high = a.counterparties.find((c) => c.key === 'vpa:shop@upi');
    const low = a.counterparties.find((c) => c.key === 'low|vpa:shop@upi');
    expect(high).toMatchObject({ confidence: 'high', txn_count: 2, sent_total: 150 });
    expect(low).toMatchObject({ confidence: 'low', txn_count: 1, sent_total: 25 });
    expect(a.low_confidence_counterparty_count).toBe(1);
  });

  test('low-confidence rows with NO identifier are counted unattributed, not invented', () => {
    const txns = [
      row({ id: 1, debit_amount: 10, extraction_confidence: 'low' }),
      row({ id: 2, credit_amount: 20 , counterparty_name: 'REAL ONE'}),
    ];
    const a = analyzeStatement({}, txns);
    expect(a.unattributed_count).toBe(1);
    expect(a.counterparties).toHaveLength(1);
    expect(a.counterparties[0].display_name).toBe('REAL ONE');
  });

  test('identifier priority: vpa > phone > ifsc+name > name', () => {
    const { counterpartyKeyOf } = _internals;
    expect(counterpartyKeyOf(row({ counterparty_vpa: 'A@b', counterparty_phone: '9', counterparty_ifsc: 'HDFC0000240', counterparty_name: 'N' })).idKind).toBe('vpa');
    expect(counterpartyKeyOf(row({ counterparty_phone: '9111111111', counterparty_ifsc: 'HDFC0000240', counterparty_name: 'N' })).idKind).toBe('phone');
    expect(counterpartyKeyOf(row({ counterparty_ifsc: 'HDFC0000240', counterparty_name: 'N' })).idKind).toBe('ifsc+name');
    expect(counterpartyKeyOf(row({ counterparty_name: 'N' })).idKind).toBe('name');
    expect(counterpartyKeyOf(row({}))).toBeNull();
  });
});

describe('top-N rankings', () => {
  const analysis = analyzePnbFixture();

  test('top by amount leads with the NEFT employer credits (₹23,180)', () => {
    expect(analysis.top_by_amount).toHaveLength(T.TOP_N);
    expect(analysis.top_by_amount[0]).toBe('ifsc:HDFC0000240|name:M INTERGRAPH SYSTEMS PVT');
    // The two ₹16,000 single-transaction parties are next.
    expect(analysis.top_by_amount.slice(1, 3).sort()).toEqual(
      ['phone:919999999999', 'vpa:upreti.vipin@yb'].sort(),
    );
  });

  test('top by frequency leads with Mr Rajne (10 txns) then Balaji (5)', () => {
    expect(analysis.top_by_frequency[0]).toBe('vpa:8375839800@ptye');
    expect(analysis.top_by_frequency[1]).toBe('vpa:vyapar.17569292');
  });

  test('counterparties arrive volume-sorted (ties by frequency)', () => {
    const vols = analysis.counterparties.map((c) => c.volume);
    for (let i = 1; i < vols.length; i++) expect(vols[i]).toBeLessThanOrEqual(vols[i - 1]);
  });
});

describe('behavioral flags — value + plain-language why, day granularity stated', () => {
  const analysis = analyzePnbFixture();
  const flagById = new Map(analysis.flags.map((f) => [f.id, f]));

  test('the PNB fixture fires exactly rapid days, pass-through, and repeat counterparties', () => {
    expect([...flagById.keys()].sort()).toEqual(
      ['pass_through_days', 'rapid_transaction_days', 'repeat_counterparties'],
    );
  });

  test('rapid_transaction_days: 5 days at ≥8 txns, day-granularity stated', () => {
    const f = flagById.get('rapid_transaction_days');
    expect(f.severity).toBe('signal');
    expect(f.value.days).toHaveLength(5);
    expect(f.value.days[0]).toEqual({ day: '2026-06-29', count: 9 });
    expect(f.why).toMatch(/day-granularity|no time-of-day/);
  });

  test('pass_through_days catches the ₹16,000-in / ₹17,860-out day', () => {
    const f = flagById.get('pass_through_days');
    expect(f.value.days).toEqual([
      { day: '2026-06-14', credited: 16000, debited: 17860, out_ratio: 1.12 },
    ]);
    expect(f.why).toMatch(/SAME day/);
  });

  test('repeat_counterparties: Mr Rajne (10) and Balaji (5)', () => {
    const f = flagById.get('repeat_counterparties');
    expect(f.value.counterparties.map((c) => c.display_name)).toEqual(['MR RAJNE', 'BALAJI T']);
    expect(f.why).toContain('MR RAJNE');
  });

  test('round-figure and high-value correctly do NOT fire on this account', () => {
    expect(flagById.has('round_figure_txns')).toBe(false);       // odd small UPI amounts
    expect(flagById.has('high_value_counterparties')).toBe(false); // max volume ₹23,180 < ₹50k
    expect(flagById.has('low_confidence_distribution')).toBe(false); // 0 low, 0 unattributed
  });

  test('round_figure_txns fires on a structuring-shaped ledger and respects both thresholds', () => {
    const mk = (n, amount) => row({
      id: n, txn_date: `2026-06-${String(10 + n).padStart(2, '0')}T00:00:00.000Z`,
      debit_amount: amount, counterparty_name: `P${n}`,
    });
    // 6 round of 8 (75% share, count 6) → fires.
    const firing = [1000, 5000, 2000, 10000, 3000, 1000, 777.5, 123].map((a, i) => mk(i + 1, a));
    const fired = analyzeStatement({}, firing).flags.find((f) => f.id === 'round_figure_txns');
    expect(fired).toBeDefined();
    expect(fired.value).toEqual({ count: 6, share: 0.75 });

    // Same 6 round txns diluted below the share threshold → silent.
    const diluted = [
      ...firing,
      ...Array.from({ length: 20 }, (_, i) => mk(100 + i, 333.33)),
    ];
    expect(analyzeStatement({}, diluted).flags.find((f) => f.id === 'round_figure_txns')).toBeUndefined();

    // ₹500 round-ish amounts below MIN_AMOUNT never count.
    const small = Array.from({ length: 10 }, (_, i) => mk(i + 1, 500));
    expect(analyzeStatement({}, small).flags.find((f) => f.id === 'round_figure_txns')).toBeUndefined();
  });

  test('pass_through_days honours the credit floor and out-ratio', () => {
    const day = '2026-06-20T00:00:00.000Z';
    const stamp = (i) => `2026-06-${String(i).padStart(2, '0')}T00:00:00.000Z`;
    // ₹4,999 in (below floor) fully out → silent.
    const belowFloor = [
      row({ id: 1, txn_date: day, credit_amount: 4999, counterparty_name: 'A' }),
      row({ id: 2, txn_date: day, debit_amount: 4999, counterparty_name: 'B' }),
      row({ id: 3, txn_date: stamp(21), debit_amount: 10, counterparty_name: 'C' }),
    ];
    expect(analyzeStatement({}, belowFloor).flags.find((f) => f.id === 'pass_through_days')).toBeUndefined();
    // ₹10,000 in, only ₹5,000 out (50% < 80%) → silent.
    const lowRatio = [
      row({ id: 1, txn_date: day, credit_amount: 10000, counterparty_name: 'A' }),
      row({ id: 2, txn_date: day, debit_amount: 5000, counterparty_name: 'B' }),
      row({ id: 3, txn_date: stamp(21), debit_amount: 10, counterparty_name: 'C' }),
    ];
    expect(analyzeStatement({}, lowRatio).flags.find((f) => f.id === 'pass_through_days')).toBeUndefined();
    // ₹10,000 in, ₹9,000 out (90%) → fires.
    const firing = [
      row({ id: 1, txn_date: day, credit_amount: 10000, counterparty_name: 'A' }),
      row({ id: 2, txn_date: day, debit_amount: 9000, counterparty_name: 'B' }),
      row({ id: 3, txn_date: stamp(21), debit_amount: 10, counterparty_name: 'C' }),
    ];
    const f = analyzeStatement({}, firing).flags.find((x) => x.id === 'pass_through_days');
    expect(f.value.days).toEqual([{ day: '2026-06-20', credited: 10000, debited: 9000, out_ratio: 0.9 }]);
  });

  test('high_value_counterparties fires at the volume threshold', () => {
    const txns = [
      row({ id: 1, counterparty_vpa: 'big@upi', counterparty_name: 'BIG', credit_amount: 30000 }),
      row({ id: 2, counterparty_vpa: 'big@upi', counterparty_name: 'BIG', debit_amount: 20000 }),
      row({ id: 3, counterparty_vpa: 'small@upi', counterparty_name: 'SMALL', debit_amount: 100 }),
    ];
    const f = analyzeStatement({}, txns).flags.find((x) => x.id === 'high_value_counterparties');
    expect(f.value.counterparties).toEqual([{ key: 'vpa:big@upi', display_name: 'BIG', volume: 50000 }]);
  });

  test('low_confidence_distribution info flag fires whenever low/unattributed rows exist', () => {
    const txns = [
      row({ id: 1, counterparty_vpa: 'a@b', counterparty_name: 'A', debit_amount: 10, extraction_confidence: 'low' }),
      row({ id: 2, debit_amount: 20, extraction_confidence: 'low' }), // no identifier
      row({ id: 3, counterparty_name: 'C', credit_amount: 30 }),
    ];
    const f = analyzeStatement({}, txns).flags.find((x) => x.id === 'low_confidence_distribution');
    expect(f.severity).toBe('info');
    expect(f.value).toEqual({ low_confidence_groups: 1, unattributed: 1 });
    expect(f.why).toMatch(/verify.*narration/i);
  });

  test('thresholds snapshot travels with the analysis (tunable constants pattern)', () => {
    expect(analysis.thresholds).toMatchObject({
      RAPID_DAY_MIN_TXNS: T.RAPID_DAY_MIN_TXNS,
      PASSTHROUGH_MIN_OUT_RATIO: T.PASSTHROUGH_MIN_OUT_RATIO,
      REPEAT_COUNTERPARTY_MIN_TXNS: T.REPEAT_COUNTERPARTY_MIN_TXNS,
    });
  });
});
