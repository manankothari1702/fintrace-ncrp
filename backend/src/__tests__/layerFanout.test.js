'use strict';

/**
 * Unit tests for Feature 2 — layer fan-out HIGH flag + top-banks ranking.
 *
 * fan_out_ratio = accounts(next layer) / accounts(this layer). The HIGH flag
 * fires at ratio ≥ FANOUT_HIGH_RATIO (thresholds.js, currently 2.0). banks_ranked
 * is the full [{bank,count}] list by hop count; top_banks stays the top-3
 * "Bank (n)" strings for the Excel/PDF consumers. Fixtures are hand-built so the
 * per-layer account and bank counts are obvious.
 */

const { layerAnalysis, _internals } = require('../analyzers/analyzer');
const { enrichTransactions } = _internals;

let seq = 0;
function hop(victim, benef, layer, bank) {
  seq += 1;
  return {
    ack_no: 'ACK', complaint_date: '2024-01-01T00:00:00.000Z',
    victim_account: victim, victim_bank: 'BankV',
    beneficiary_account: benef, beneficiary_bank: bank || 'BankB',
    beneficiary_name: benef, ifsc_code: 'BANK0001234',
    transaction_date: `2024-01-15T${String(layer).padStart(2, '0')}:00:00.000Z`,
    transaction_amount: 10000, disputed_amount: 10000,
    utr_no: `U${seq}`, payment_mode: 'IMPS', layer_no: layer,
    atm_id: null, atm_location: null, city: 'X', state: 'S', remarks: null,
  };
}
const byLayer = (layers) => Object.fromEntries(layers.map((l) => [l.layer_no, l]));

describe('fan-out HIGH flag', () => {
  test('flags a layer whose money spreads into ≥ 2× accounts, not one below', () => {
    // L1: {M1} (1 acct) → L2: {A,B,C} (3 accts)  ⇒ L1 fan-out = 3/1 = 3.0 (HIGH)
    // L2: 3 accts → L3: {Z} (1 acct)              ⇒ L2 fan-out = 1/3 = 0.33 (not high)
    const layers = layerAnalysis(enrichTransactions([
      hop('V', 'M1', 1),
      hop('M1', 'A', 2), hop('M1', 'B', 2), hop('M1', 'C', 2),
      hop('A', 'Z', 3),
    ]));
    const L = byLayer(layers);
    expect(L[1].fan_out_ratio).toBeCloseTo(3, 5);
    expect(L[1].fan_out_high).toBe(true);
    expect(L[2].fan_out_ratio).toBeCloseTo(0.33, 2);
    expect(L[2].fan_out_high).toBe(false);
    // Terminal layer has no next layer → null ratio, never flagged.
    expect(L[3].fan_out_ratio).toBeNull();
    expect(L[3].fan_out_high).toBe(false);
  });

  test('boundary: exactly 2.0× is HIGH (≥, not >)', () => {
    // L1: {M1} (1) → L2: {A,B} (2)  ⇒ 2.0 exactly
    const layers = layerAnalysis(enrichTransactions([
      hop('V', 'M1', 1),
      hop('M1', 'A', 2), hop('M1', 'B', 2),
    ]));
    expect(byLayer(layers)[1].fan_out_ratio).toBeCloseTo(2, 5);
    expect(byLayer(layers)[1].fan_out_high).toBe(true);
  });
});

describe('banks_ranked / top_banks', () => {
  test('full ranked list by hop count; top_banks keeps top-3 "Bank (n)" strings', () => {
    // L1 beneficiary banks: X×3, Y×2, Z×1, W×1
    const layers = layerAnalysis(enrichTransactions([
      hop('V', 'M1', 1, 'Bank X'), hop('V', 'M2', 1, 'Bank X'), hop('V', 'M3', 1, 'Bank X'),
      hop('V', 'M4', 1, 'Bank Y'), hop('V', 'M5', 1, 'Bank Y'),
      hop('V', 'M6', 1, 'Bank Z'),
      hop('V', 'M7', 1, 'Bank W'),
    ]));
    const L1 = byLayer(layers)[1];
    expect(L1.unique_banks).toBe(4);
    expect(L1.banks_ranked).toEqual([
      { bank: 'Bank X', count: 3 },
      { bank: 'Bank Y', count: 2 },
      { bank: 'Bank W', count: 1 }, // ties (W,Z at count 1) broken alphabetically
      { bank: 'Bank Z', count: 1 },
    ]);
    // top_banks unchanged: top-3 formatted strings (Excel/PDF contract).
    expect(L1.top_banks).toEqual(['Bank X (3)', 'Bank Y (2)', 'Bank W (1)']);
  });
});
