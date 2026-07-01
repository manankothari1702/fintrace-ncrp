'use strict';

/**
 * Unit tests for Feature 1 — Investigation Metrics (Dashboard KPI band):
 * response gap, recovery rate, and cash-out speed.
 *
 * The severity bands asserted here track backend/src/lib/thresholds.js
 * (RESPONSE_GAP_AMBER_DAYS=7 / RED=14; RECOVERY_RATE_AMBER_PCT=25 / RED=0). If a
 * threshold is retuned there, update the boundary expectations below to match.
 * Fixtures are hand-built canonical rows (the shape ncrpParser emits).
 */

const { analyzeReport, investigationMetrics, cashoutSpeed, _internals } = require('../analyzers/analyzer');
const { enrichTransactions, buildAccountRollup } = _internals;

function hop(victim, benef, dateIso, amount, layer) {
  return {
    ack_no: 'ACK', complaint_date: '2024-01-01T00:00:00.000Z',
    victim_account: victim, victim_bank: 'BankA',
    beneficiary_account: benef, beneficiary_bank: 'BankB',
    beneficiary_name: benef, ifsc_code: 'BANK0001234',
    transaction_date: dateIso, transaction_amount: amount, disputed_amount: amount,
    utr_no: `U-${victim}-${benef}-${dateIso}`, payment_mode: 'IMPS', layer_no: layer,
    atm_id: null, atm_location: null, city: 'X', state: 'S', remarks: null,
  };
}
function atm(account, dateIso, amount) {
  return {
    ack_no: 'ACK', complaint_date: '2024-01-01T00:00:00.000Z',
    victim_account: account, victim_bank: 'BankB',
    beneficiary_account: account, beneficiary_bank: 'BankB',
    beneficiary_name: account, ifsc_code: 'BANK0001234',
    transaction_date: dateIso, transaction_amount: amount, disputed_amount: amount,
    utr_no: `A-${account}-${dateIso}`, payment_mode: 'ATM', layer_no: 2,
    atm_id: `ATM-${account}`, atm_location: 'Loc', city: 'X', state: 'S', remarks: null,
  };
}

describe('cashoutSpeed', () => {
  test('median across ALL cashing accounts of receipt→first-cashout (hours)', () => {
    // M1: received 00:00, cashed out 02:00 → 2h
    // M2: received 00:00, cashed out 10:00 → 10h  → median([2,10]) = 6
    // M3: received but never cashed out → excluded
    const rows = enrichTransactions([
      hop('V', 'M1', '2024-01-15T00:00:00.000Z', 50000, 1),
      hop('V', 'M2', '2024-01-15T00:00:00.000Z', 50000, 1),
      hop('V', 'M3', '2024-01-15T00:00:00.000Z', 50000, 1),
      atm('M1', '2024-01-15T02:00:00.000Z', 50000),
      atm('M2', '2024-01-15T10:00:00.000Z', 50000),
    ]);
    const rollup = buildAccountRollup(rows);
    const speed = cashoutSpeed(rollup);
    expect(speed.account_count).toBe(2);   // M3 excluded (no cash-out)
    expect(speed.median_hours).toBeCloseTo(6, 5);
    expect(speed.mean_hours).toBeCloseTo(6, 5);
  });

  test('excludes accounts whose first exit precedes first receipt (relabel edge)', () => {
    // M4: received 10:00 but cashed out 08:00 (out-before-in) → excluded, not negative
    const rows = enrichTransactions([
      hop('V', 'M1', '2024-01-15T00:00:00.000Z', 50000, 1),
      atm('M1', '2024-01-15T04:00:00.000Z', 50000),      // 4h
      hop('V', 'M4', '2024-01-15T10:00:00.000Z', 50000, 1),
      atm('M4', '2024-01-15T08:00:00.000Z', 50000),      // out before in → excluded
    ]);
    const speed = cashoutSpeed(buildAccountRollup(rows));
    expect(speed.account_count).toBe(1);
    expect(speed.median_hours).toBeCloseTo(4, 5);
  });

  test('empty population → null median, zero count', () => {
    const rows = enrichTransactions([hop('V', 'M1', '2024-01-15T00:00:00.000Z', 50000, 1)]);
    const speed = cashoutSpeed(buildAccountRollup(rows));
    expect(speed.account_count).toBe(0);
    expect(speed.median_hours).toBeNull();
    expect(speed.mean_hours).toBeNull();
  });
});

describe('investigationMetrics — response gap severity', () => {
  const gap = (days) => investigationMetrics({
    summary: {}, timeline_summary: { fraud_to_bank_action_days: days },
  }).response_gap;

  test('bands: ok ≤7, warn >7..≤14, danger >14', () => {
    expect(gap(5).severity).toBe('ok');
    expect(gap(7).severity).toBe('ok');       // boundary: not > 7
    expect(gap(7.6).severity).toBe('warn');   // matches gold case 145
    expect(gap(14).severity).toBe('warn');    // boundary: not > 14
    expect(gap(20).severity).toBe('danger');
    expect(gap(200.7).severity).toBe('danger'); // matches gold case 170
  });

  test('missing bank action → null days, neutral severity', () => {
    const r = investigationMetrics({ summary: {}, timeline_summary: {} }).response_gap;
    expect(r.days).toBeNull();
    expect(r.severity).toBe('none');
  });

  test('carries the from/to milestone dates through', () => {
    const r = investigationMetrics({
      summary: {},
      timeline_summary: {
        fraud_to_bank_action_days: 7.6,
        first_fraud_date: '2025-12-02', first_bank_action_date: '2025-12-09',
      },
    }).response_gap;
    expect(r.from_date).toBe('2025-12-02');
    expect(r.to_date).toBe('2025-12-09');
  });
});

describe('investigationMetrics — recovery rate (secured/returned ÷ loss)', () => {
  const rec = (loss, onHold, refunded = 0) => investigationMetrics({
    summary: { victim_loss_amount: loss, on_hold: onHold, refunded },
  }).recovery_rate;

  test('secured = on_hold + refunded; pct against victim loss', () => {
    const r = rec(1000000, 130000, 20000);
    expect(r.secured_amount).toBe(150000);
    expect(r.base_amount).toBe(1000000);
    expect(r.pct).toBeCloseTo(15, 5);
  });

  test('bands: danger at 0%, warn <25%, ok ≥25%', () => {
    expect(rec(1000000, 0).severity).toBe('danger');       // nothing secured
    expect(rec(1000000, 130000).severity).toBe('warn');    // 13% (gold 145 ≈ 13.1%)
    expect(rec(1000000, 240000).severity).toBe('warn');    // 24%
    expect(rec(1000000, 250000).severity).toBe('ok');      // 25% boundary
    expect(rec(1000000, 438000).severity).toBe('ok');      // gold 170 ≈ 43.8%
  });

  test('zero victim loss → null pct, neutral severity (no divide-by-zero)', () => {
    const r = rec(0, 0);
    expect(r.pct).toBeNull();
    expect(r.severity).toBe('none');
  });
});

describe('investigationMetrics — end to end via analyzeReport', () => {
  test('attaches investigation_metrics with all three sub-metrics', async () => {
    const rows = [
      hop('V', 'M1', '2024-01-15T00:00:00.000Z', 100000, 1),
      atm('M1', '2024-01-15T05:00:00.000Z', 40000),
    ].map((r, i) => ({ id: i + 1, ...r }));
    const a = await analyzeReport(1, rows, []);
    expect(a.investigation_metrics).toBeDefined();
    expect(a.investigation_metrics.response_gap).toHaveProperty('severity');
    expect(a.investigation_metrics.recovery_rate).toHaveProperty('pct');
    expect(a.investigation_metrics.cashout_speed).toHaveProperty('median_hours');
    // M1 received at 00:00 and cashed out at 05:00 → 5h speed, one account.
    expect(a.investigation_metrics.cashout_speed.account_count).toBe(1);
    expect(a.investigation_metrics.cashout_speed.median_hours).toBeCloseTo(5, 5);
    expect(a.investigation_metrics.cashout_speed.severity).toBe('none');
  });
});
