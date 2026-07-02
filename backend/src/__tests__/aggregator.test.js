'use strict';

/**
 * Unit tests for Feature 3 — aggregator (common-account) detection.
 *
 * An aggregator is an account with many distinct upstream senders (in_degree).
 * Severity bands (thresholds.js): amber at in_degree 3–4, red at ≥5; below 3 is
 * not an aggregator. The floor is 3 (not the doc's 5) because 5+ flags zero
 * accounts on gold case 145. Fixtures are hand-built so fan-in is obvious.
 */

const { analyzeReport, aggregatorAnalysis, aggregatorSeverity, _internals } = require('../analyzers/analyzer');
const { enrichTransactions, buildAccountRollup } = _internals;
const { analyzeConnectivity } = require('../analysis/connectivity');

let seq = 0;
function hop(victim, benef, amount = 10000) {
  seq += 1;
  return {
    ack_no: 'ACK', complaint_date: '2024-01-01T00:00:00.000Z',
    victim_account: victim, victim_bank: 'BankV',
    beneficiary_account: benef, beneficiary_bank: 'BankB',
    beneficiary_name: benef, ifsc_code: 'BANK0001234',
    transaction_date: `2024-01-15T05:00:0${seq % 10}.000Z`,
    transaction_amount: amount, disputed_amount: amount,
    utr_no: `U${seq}`, payment_mode: 'IMPS', layer_no: 1,
    atm_id: null, atm_location: null, city: 'X', state: 'S', remarks: null,
  };
}

describe('aggregatorSeverity bands', () => {
  test('null below 3, amber at 3–4, red at ≥5', () => {
    expect(aggregatorSeverity(0)).toBeNull();
    expect(aggregatorSeverity(2)).toBeNull();   // collector, but not an aggregator
    expect(aggregatorSeverity(3)).toBe('warn'); // floor (gold 145's max)
    expect(aggregatorSeverity(4)).toBe('warn');
    expect(aggregatorSeverity(5)).toBe('danger'); // doc's "5+" = the red tier
    expect(aggregatorSeverity(28)).toBe('danger');
  });
});

describe('aggregatorAnalysis', () => {
  test('flags accounts by distinct-sender count, sorted desc, with a summary strip', () => {
    // C ← 5 distinct senders (red), D ← 3 (amber), E ← 2 (not an aggregator).
    const rows = enrichTransactions([
      hop('S1', 'C'), hop('S2', 'C'), hop('S3', 'C'), hop('S4', 'C'), hop('S5', 'C'),
      hop('T1', 'D'), hop('T2', 'D'), hop('T3', 'D'),
      hop('U1', 'E'), hop('U2', 'E'),
    ]);
    const connectivity = analyzeConnectivity(rows);
    const rollup = buildAccountRollup(rows);
    const agg = aggregatorAnalysis(connectivity, rollup);

    expect(agg.accounts.map((a) => a.account_no)).toEqual(['C', 'D']); // E excluded (in_degree 2)
    expect(agg.accounts[0]).toMatchObject({ account_no: 'C', distinct_senders: 5, severity: 'danger' });
    expect(agg.accounts[1]).toMatchObject({ account_no: 'D', distinct_senders: 3, severity: 'warn' });
    expect(agg.summary.count).toBe(2);
    expect(agg.summary.max_fan_in).toBe(5);
    expect(agg.summary.median_fan_in).toBeCloseTo(4, 5); // median([5,3]) = 4
    // C received 5×10k and forwarded nothing → its residual counts toward held.
    expect(agg.summary.total_held).toBeGreaterThan(0);
  });

  test('empty when no account clears the floor', () => {
    const rows = enrichTransactions([hop('S1', 'C'), hop('S2', 'C')]); // in_degree 2 only
    const agg = aggregatorAnalysis(analyzeConnectivity(rows), buildAccountRollup(rows));
    expect(agg.accounts).toEqual([]);
    expect(agg.summary.count).toBe(0);
    expect(agg.summary.median_fan_in).toBeNull();
  });
});

describe('mule rows are tagged with aggregator severity (end to end)', () => {
  test('analyzeReport attaches distinct_senders + aggregator_severity and aggregator_analysis', async () => {
    // C collects from 5 senders and forwards onward (so it is also a mule).
    const rows = [
      hop('S1', 'C'), hop('S2', 'C'), hop('S3', 'C'), hop('S4', 'C'), hop('S5', 'C'),
      { ...hop('C', 'D'), layer_no: 2 },
    ].map((r, i) => ({ id: i + 1, ...r }));
    const a = await analyzeReport(1, rows, []);
    expect(a.aggregator_analysis.summary.count).toBeGreaterThanOrEqual(1);
    const cMule = a.mule_detection.find((m) => m.account_no === 'C');
    expect(cMule).toBeDefined();
    expect(cMule.distinct_senders).toBe(5);
    expect(cMule.aggregator_severity).toBe('danger');
  });
});
