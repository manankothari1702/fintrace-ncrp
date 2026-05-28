'use strict';

/**
 * Unit tests for backend/src/analyzers/analyzer.js.
 *
 * Each test uses a tailored mini-fixture so the behaviour around layer
 * rollups, mule scoring, lien math, cashout detection, and timeline
 * aggregation is exercised in isolation. The analyzer reads canonical
 * transaction rows (the same shape ncrpParser emits), so the fixtures are
 * built directly — no parsing required.
 */

const {
  layerAnalysis,
  cashoutAnalysis,
  muleDetection,
  lienCalculation,
  timelineAnalysis,
  keyFindings,
  _internals,
} = require('../analyzers/analyzer');

const { enrichTransactions, buildAccountRollup } = _internals;

/**
 * Standard 3-layer fixture for layer + cashout + general tests.
 * - Layer 1: V → M1 (IMPS, 100k)
 * - Layer 2: M1 → M2 (NEFT, 90k)
 * - Layer 3: M2 → M3 (IMPS, 80k)
 * - Layer 3 cashout 1: M2 → M3 (ATM, 25k — same day as receipt)
 * - Layer 3 cashout 2: M2 → M3 (ATM, 20k — same day as receipt)
 */
function buildStandardTransactions() {
  return [
    {
      ack_no: 'ACK1', complaint_date: '2024-01-14T00:00:00.000Z',
      victim_account: 'V1', victim_bank: 'HDFC',
      beneficiary_account: 'M1', beneficiary_bank: 'ICICI',
      beneficiary_name: 'Mule One', ifsc_code: 'ICIC0001234',
      transaction_date: '2024-01-15T05:00:00.000Z',
      transaction_amount: 100000, disputed_amount: 100000,
      utr_no: 'U1', payment_mode: 'IMPS', layer_no: 1,
      atm_id: null, atm_location: null, city: 'Mumbai', state: 'Maharashtra',
      remarks: null,
    },
    {
      ack_no: 'ACK1', complaint_date: '2024-01-14T00:00:00.000Z',
      victim_account: 'M1', victim_bank: 'ICICI',
      beneficiary_account: 'M2', beneficiary_bank: 'SBI',
      beneficiary_name: 'Mule Two', ifsc_code: 'SBIN0009876',
      transaction_date: '2024-01-15T06:00:00.000Z',
      transaction_amount: 90000, disputed_amount: 100000,
      utr_no: 'U2', payment_mode: 'NEFT', layer_no: 2,
      atm_id: null, atm_location: null, city: 'Pune', state: 'Maharashtra',
      remarks: null,
    },
    {
      ack_no: 'ACK1', complaint_date: '2024-01-14T00:00:00.000Z',
      victim_account: 'M2', victim_bank: 'SBI',
      beneficiary_account: 'M3', beneficiary_bank: 'Axis',
      beneficiary_name: 'Mule Three', ifsc_code: 'UTIB0005555',
      transaction_date: '2024-01-16T07:00:00.000Z',
      transaction_amount: 80000, disputed_amount: 100000,
      utr_no: 'U3', payment_mode: 'IMPS', layer_no: 3,
      atm_id: null, atm_location: null, city: 'Delhi', state: 'Delhi',
      remarks: null,
    },
    // Cashout 1 — same day as the IMPS receipt above.
    {
      ack_no: 'ACK1', complaint_date: '2024-01-14T00:00:00.000Z',
      victim_account: 'M2', victim_bank: 'SBI',
      beneficiary_account: 'M3', beneficiary_bank: 'Axis',
      beneficiary_name: 'Mule Three', ifsc_code: 'UTIB0005555',
      transaction_date: '2024-01-16T09:00:00.000Z',
      transaction_amount: 25000, disputed_amount: 100000,
      utr_no: 'U4', payment_mode: 'ATM', layer_no: 3,
      atm_id: 'ATM1', atm_location: 'NSP', city: 'Delhi', state: 'Delhi',
      remarks: 'cashout 1',
    },
    {
      ack_no: 'ACK1', complaint_date: '2024-01-14T00:00:00.000Z',
      victim_account: 'M2', victim_bank: 'SBI',
      beneficiary_account: 'M3', beneficiary_bank: 'Axis',
      beneficiary_name: 'Mule Three', ifsc_code: 'UTIB0005555',
      transaction_date: '2024-01-16T11:00:00.000Z',
      transaction_amount: 20000, disputed_amount: 100000,
      utr_no: 'U5', payment_mode: 'ATM', layer_no: 3,
      atm_id: 'ATM1', atm_location: 'NSP', city: 'Delhi', state: 'Delhi',
      remarks: 'cashout 2',
    },
  ];
}

/**
 * High-score mule fixture: HMULE is a terminal account that receives entirely
 * via ATM (pass-through ratio 1.0) AND appears in two acknowledgement numbers
 * (cross-case bonus). Designed to land above the HIGH threshold.
 */
function buildHighMuleTransactions() {
  return [
    {
      ack_no: 'ACKA',
      beneficiary_account: 'HMULE', beneficiary_bank: 'BoB',
      beneficiary_name: 'High Mule', ifsc_code: 'BARB0009999',
      transaction_date: '2024-02-01T10:00:00.000Z',
      transaction_amount: 50000, disputed_amount: 50000,
      utr_no: 'HA-1', payment_mode: 'ATM', layer_no: 3,
      atm_id: 'ATM-HM', atm_location: 'HM Branch',
      city: 'Delhi', state: 'Delhi',
    },
    {
      ack_no: 'ACKA',
      beneficiary_account: 'HMULE', beneficiary_bank: 'BoB',
      beneficiary_name: 'High Mule', ifsc_code: 'BARB0009999',
      transaction_date: '2024-02-01T11:00:00.000Z',
      transaction_amount: 30000, disputed_amount: 50000,
      utr_no: 'HA-2', payment_mode: 'ATM', layer_no: 3,
      atm_id: 'ATM-HM', atm_location: 'HM Branch',
      city: 'Delhi', state: 'Delhi',
    },
    // Different case → cross-case bonus.
    {
      ack_no: 'ACKB',
      beneficiary_account: 'HMULE', beneficiary_bank: 'BoB',
      beneficiary_name: 'High Mule', ifsc_code: 'BARB0009999',
      transaction_date: '2024-02-02T10:00:00.000Z',
      transaction_amount: 20000, disputed_amount: 30000,
      utr_no: 'HB-1', payment_mode: 'ATM', layer_no: 3,
      atm_id: 'ATM-HM', atm_location: 'HM Branch',
      city: 'Delhi', state: 'Delhi',
    },
  ];
}

// ─── layerAnalysis ───────────────────────────────────────────────────

describe('layerAnalysis', () => {
  test('3-layer dataset yields the right account_count per layer', () => {
    const enriched = enrichTransactions(buildStandardTransactions());
    const layers = layerAnalysis(enriched);
    const byLayer = Object.fromEntries(layers.map((l) => [l.layer_no, l]));
    expect(byLayer[1].account_count).toBe(1); // M1 receives
    expect(byLayer[2].account_count).toBe(1); // M2 receives
    expect(byLayer[3].account_count).toBe(1); // M3 receives (across IMPS + ATM rows)
  });

  test('ATM rows bump cashout_count for the layer where they occur', () => {
    const enriched = enrichTransactions(buildStandardTransactions());
    const layers = layerAnalysis(enriched);
    const layer3 = layers.find((l) => l.layer_no === 3);
    // Two ATM rows live in layer 3.
    expect(layer3.cashout_count).toBe(2);
    // Layers 1 + 2 have no cashouts.
    expect(layers.find((l) => l.layer_no === 1).cashout_count).toBe(0);
    expect(layers.find((l) => l.layer_no === 2).cashout_count).toBe(0);
  });
});

// ─── muleDetection ───────────────────────────────────────────────────

describe('muleDetection', () => {
  test('account with pass-through > 0.8 scores > 60', () => {
    // HMULE: 100% cash exit, fast (within 1h), cross-case → expected ≈ 75.
    const enriched = enrichTransactions(buildHighMuleTransactions());
    const rollup = buildAccountRollup(enriched);
    const mules = muleDetection(enriched, rollup);
    const top = mules.find((m) => m.account_no === 'HMULE');
    expect(top).toBeDefined();
    expect(top.pass_through_ratio).toBeGreaterThan(0.8);
    expect(top.mule_score).toBeGreaterThan(60);
  });

  test('an account receiving but not forwarding scores < 40', () => {
    // Single inbound row, no cashout — pass-through is the only signal.
    const txns = [{
      ack_no: 'ACK-LOW',
      beneficiary_account: 'SAFE1', beneficiary_bank: 'HDFC',
      transaction_date: '2024-02-01T00:00:00.000Z',
      transaction_amount: 1000, disputed_amount: 1000,
      payment_mode: 'IMPS', layer_no: 1, state: 'Maharashtra',
    }];
    const enriched = enrichTransactions(txns);
    const rollup = buildAccountRollup(enriched);
    const mules = muleDetection(enriched, rollup);
    const safe = mules.find((m) => m.account_no === 'SAFE1');
    expect(safe).toBeDefined();
    expect(safe.mule_score).toBeLessThan(40);
  });
});

// ─── lienCalculation ─────────────────────────────────────────────────

describe('lienCalculation', () => {
  test('received 100, forwarded 70 → lien_eligible = 30', () => {
    // Use a synthetic rollup so we exercise the lien output shape directly.
    const fakeRollup = new Map([
      ['ACCT-A', {
        account_no: 'ACCT-A', bank_name: 'HDFC', ifsc_code: 'HDFC0001',
        minLayer: 2,
        total_received: 100, total_forwarded: 70, total_cashed_out: 70,
        lien_eligible_amount: 30,
      }],
    ]);
    const liens = lienCalculation(fakeRollup);
    expect(liens).toHaveLength(1);
    expect(liens[0].lien_eligible_amount).toBe(30);
    expect(liens[0].account_no).toBe('ACCT-A');
  });

  test('received 100, forwarded 110 → lien_eligible omitted', () => {
    // Over-withdrawn / negative residue: no lien-eligible row emitted.
    const fakeRollup = new Map([
      ['ACCT-B', {
        account_no: 'ACCT-B', bank_name: 'ICICI', ifsc_code: 'ICIC0002',
        minLayer: 2,
        total_received: 100, total_forwarded: 110, total_cashed_out: 110,
        lien_eligible_amount: 0,
      }],
    ]);
    const liens = lienCalculation(fakeRollup);
    expect(liens).toHaveLength(0);
  });
});

// ─── cashoutAnalysis ─────────────────────────────────────────────────

describe('cashoutAnalysis', () => {
  test('2 ATM rows on the same day as receipt → 2 same-day cashouts', () => {
    const enriched = enrichTransactions(buildStandardTransactions());
    const cashout = cashoutAnalysis(enriched);
    expect(cashout.same_day_cashouts).toBe(2);
    expect(cashout.total_cashout_transactions).toBe(2);
  });
});

// ─── timelineAnalysis ────────────────────────────────────────────────

describe('timelineAnalysis', () => {
  test('3 different transaction dates → 3 timeline entries', () => {
    const txns = [
      { beneficiary_account: 'A', transaction_date: '2024-01-15T05:00:00.000Z', transaction_amount: 100, layer_no: 1, payment_mode: 'IMPS' },
      { beneficiary_account: 'A', transaction_date: '2024-01-16T05:00:00.000Z', transaction_amount: 200, layer_no: 1, payment_mode: 'IMPS' },
      { beneficiary_account: 'A', transaction_date: '2024-01-17T05:00:00.000Z', transaction_amount: 300, layer_no: 1, payment_mode: 'IMPS' },
    ];
    const enriched = enrichTransactions(txns);
    const timeline = timelineAnalysis(enriched);
    expect(timeline).toHaveLength(3);
    expect(timeline.map((d) => d.date)).toEqual([
      '2024-01-15', '2024-01-16', '2024-01-17',
    ]);
  });
});

// ─── keyFindings ─────────────────────────────────────────────────────

describe('keyFindings', () => {
  test('returns an array of at least 3 strings for a realistic input', () => {
    const findings = keyFindings({
      layers: [{ layer_no: 1, account_count: 1 }],
      cashout: {
        total_cashout_amount: 50000, total_cashout_transactions: 2,
        same_day_cashouts: 2, fastest_cashout_hours: 4,
        atm_cashouts: [{ atm_id: 'ATM1', atm_location: 'NSP', count: 2, amount: 50000 }],
        cashout_by_state: [{ state: 'Delhi', amount: 50000, count: 2 }],
      },
      mules: [
        { account_no: 'M3', bank_name: 'Axis', mule_score: 80, layer_no: 3, risk_label: 'HIGH', total_received: 80000 },
      ],
      liens: [{ account_no: 'M3', lien_eligible_amount: 35000 }],
      repeats: [],
      geography: { by_state: [{ state: 'Delhi', amount: 50000, count: 2 }], by_city: [] },
    });

    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThanOrEqual(3);
    for (const f of findings) {
      expect(typeof f).toBe('string');
    }
  });
});
