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
  analyzeReport,
  layerAnalysis,
  cashoutAnalysis,
  muleDetection,
  lienCalculation,
  timelineAnalysis,
  timelineSummary,
  geographyAnalysis,
  moneyFlowNetwork,
  recoveryStatus,
  victimAccounts,
  keyFindings,
  dataQuality,
  _internals,
} = require('../analyzers/analyzer');

const {
  enrichTransactions, buildAccountRollup, dedupeRows, classifyRowKind, ROW_KIND,
} = _internals;

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
 * High-score mule fixture (new money model): HMULE RECEIVES via transfers from
 * two different victims (two acknowledgement numbers → fan-in + cross-case) and
 * then withdraws the lot as cash via ATM the same day (pass-through ≈ 1.0,
 * fast forward, appears in both transfer & cash-out sheets). Designed to land
 * comfortably above the HIGH threshold.
 */
function buildHighMuleTransactions() {
  return [
    // Inbound transfer #1 (a real hop: V1 → HMULE).
    {
      ack_no: 'ACKA', victim_account: 'V1', victim_bank: 'HDFC',
      beneficiary_account: 'HMULE', beneficiary_bank: 'BoB',
      beneficiary_name: 'High Mule', ifsc_code: 'BARB0009999',
      transaction_date: '2024-02-01T10:00:00.000Z',
      transaction_amount: 50000, disputed_amount: 50000,
      utr_no: 'HA-1', payment_mode: 'IMPS', layer_no: 2,
      atm_id: null, atm_location: null, city: 'Delhi', state: 'Delhi',
    },
    // Inbound transfer #2 from a second victim/case (V2 → HMULE).
    {
      ack_no: 'ACKB', victim_account: 'V2', victim_bank: 'SBI',
      beneficiary_account: 'HMULE', beneficiary_bank: 'BoB',
      beneficiary_name: 'High Mule', ifsc_code: 'BARB0009999',
      transaction_date: '2024-02-01T10:30:00.000Z',
      transaction_amount: 30000, disputed_amount: 30000,
      utr_no: 'HB-1', payment_mode: 'IMPS', layer_no: 2,
      atm_id: null, atm_location: null, city: 'Delhi', state: 'Delhi',
    },
    // Cash exits via ATM the same day (cross-sheet join → benef === victim).
    {
      ack_no: 'ACKA', victim_account: 'HMULE',
      beneficiary_account: 'HMULE', beneficiary_bank: 'BoB',
      beneficiary_name: 'High Mule', ifsc_code: 'BARB0009999',
      transaction_date: '2024-02-01T12:00:00.000Z',
      transaction_amount: 50000, disputed_amount: 50000,
      utr_no: 'HA-2', payment_mode: 'ATM', layer_no: 2,
      atm_id: 'ATM-HM', atm_location: 'HM Branch', city: 'Delhi', state: 'Delhi',
    },
    {
      ack_no: 'ACKB', victim_account: 'HMULE',
      beneficiary_account: 'HMULE', beneficiary_bank: 'BoB',
      beneficiary_name: 'High Mule', ifsc_code: 'BARB0009999',
      transaction_date: '2024-02-01T13:00:00.000Z',
      transaction_amount: 30000, disputed_amount: 30000,
      utr_no: 'HB-2', payment_mode: 'ATM', layer_no: 2,
      atm_id: 'ATM-HM', atm_location: 'HM Branch', city: 'Delhi', state: 'Delhi',
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

// ─── New money model: classification, dedup, gross lien, modules ──────

/**
 * A small but complete trail exercising the new model:
 *   • Two victims (VIC1, VIC2) fund M1 at layer 1 (fan-in).
 *   • M1 forwards most of it to M2 at layer 2 (a hop).
 *   • M2 withdraws some as cash (ATM exit) and has some frozen (hold).
 *   • One exact duplicate of the first hop (re-listed on another sheet).
 */
function buildTrail() {
  return [
    { ack_no: 'C1', victim_account: 'VIC1', beneficiary_account: 'M1', beneficiary_bank: 'BoB',
      transaction_date: '2024-03-01T10:00:00.000Z', transaction_amount: 100000, disputed_amount: 100000,
      utr_no: 'U-1', payment_mode: 'IMPS', layer_no: 1, state: 'Delhi' },
    // Exact duplicate of the row above (same benef/date/amount/utr) — must collapse.
    { ack_no: 'C1', victim_account: 'VIC1', beneficiary_account: 'M1', beneficiary_bank: 'BoB',
      transaction_date: '2024-03-01T10:00:00.000Z', transaction_amount: 100000, disputed_amount: 100000,
      utr_no: 'U-1', payment_mode: 'ATM', layer_no: 1, state: 'Delhi' },
    { ack_no: 'C1', victim_account: 'VIC2', beneficiary_account: 'M1', beneficiary_bank: 'BoB',
      transaction_date: '2024-03-01T11:00:00.000Z', transaction_amount: 50000, disputed_amount: 50000,
      utr_no: 'U-2', payment_mode: 'IMPS', layer_no: 1, state: 'Delhi' },
    { ack_no: 'C1', victim_account: 'M1', beneficiary_account: 'M2', beneficiary_bank: 'Axis',
      transaction_date: '2024-03-01T14:00:00.000Z', transaction_amount: 80000, disputed_amount: 60000,
      utr_no: 'U-3', payment_mode: 'UPI', layer_no: 2, state: 'Delhi' },
    // M2 cash exit (cross-sheet join → benef === victim).
    { ack_no: 'C1', victim_account: 'M2', beneficiary_account: 'M2', beneficiary_bank: 'Axis',
      transaction_date: '2024-03-01T16:00:00.000Z', transaction_amount: 40000, disputed_amount: 30000,
      utr_no: 'U-4', payment_mode: 'ATM', layer_no: 2, atm_id: 'ATMX', state: 'Punjab' },
    // M2 funds frozen by the bank.
    { ack_no: 'C1', victim_account: 'M2', beneficiary_account: 'M2', beneficiary_bank: 'Axis',
      transaction_date: '2024-03-02T09:00:00.000Z', transaction_amount: 20000, disputed_amount: 0,
      utr_no: 'U-5', payment_mode: 'HOLD', layer_no: 2 },
  ];
}

describe('classifyRowKind', () => {
  test('hop / exit / hold are distinguished correctly', () => {
    const e = enrichTransactions(buildTrail());
    expect(classifyRowKind(e[0])).toBe(ROW_KIND.HOP);   // VIC1 -> M1
    expect(classifyRowKind(e[4])).toBe(ROW_KIND.EXIT);  // M2 ATM withdrawal
    expect(classifyRowKind(e[5])).toBe(ROW_KIND.HOLD);  // M2 hold
  });
});

describe('dedupeRows', () => {
  test('collapses an exact (benef+date+amount+utr) duplicate', () => {
    const e = enrichTransactions(buildTrail());
    const { rows, removed } = dedupeRows(e);
    expect(removed).toBe(1);
    expect(rows).toHaveLength(e.length - 1);
  });
});

describe('buildAccountRollup (gross-balance lien)', () => {
  test('lien = received − forwarded − hold − exit, capped at disputed', () => {
    const e = dedupeRows(enrichTransactions(buildTrail())).rows;
    const rollup = buildAccountRollup(e);
    const m1 = rollup.get('M1');
    const m2 = rollup.get('M2');
    // M1: received 150k, forwarded 80k onward → balance 70k (≤ disputed 150k).
    expect(m1.total_received).toBe(150000);
    expect(m1.onward_forwarded).toBe(80000);
    expect(m1.lien_eligible_amount).toBe(70000);
    expect(m1.senders.size).toBe(2); // fan-in from VIC1, VIC2
    // M2: received 80k (disputed 60k), exit 40k, hold 20k → balance 20k, ≤ disputed.
    expect(m2.total_cashed_out).toBe(40000);
    expect(m2.total_on_hold).toBe(20000);
    expect(m2.lien_eligible_amount).toBe(20000);
  });

  test('lien is capped at the disputed inflow (no gross over-statement)', () => {
    // Received 1,000,000 gross but only 5,000 disputed; nothing left.
    const txns = [{
      ack_no: 'C2', victim_account: 'PAYER', beneficiary_account: 'AGG', beneficiary_bank: 'X',
      transaction_date: '2024-04-01T00:00:00.000Z', transaction_amount: 1000000, disputed_amount: 5000,
      utr_no: 'B-1', payment_mode: 'UPI', layer_no: 1,
    }];
    const rollup = buildAccountRollup(enrichTransactions(txns));
    expect(rollup.get('AGG').lien_eligible_amount).toBe(5000);
  });
});

describe('victimAccounts', () => {
  test('returns the distinct layer-1 senders with amounts', () => {
    const e = dedupeRows(enrichTransactions(buildTrail())).rows;
    const victims = victimAccounts(e);
    expect(victims).toHaveLength(2);
    const byAcct = Object.fromEntries(victims.map((v) => [v.account_no, v]));
    expect(byAcct.VIC1.amount_sent).toBe(100000);
    expect(byAcct.VIC2.amount_sent).toBe(50000);
  });
});

describe('moneyFlowNetwork', () => {
  test('builds source→destination edges and ranks collectors by fan-in', () => {
    const e = dedupeRows(enrichTransactions(buildTrail())).rows;
    const rollup = buildAccountRollup(e);
    const net = moneyFlowNetwork(e, rollup);
    expect(net.top_edges.length).toBeGreaterThanOrEqual(3);
    const top = net.aggregators[0];
    expect(top.account_no).toBe('M1'); // highest fan-in
    expect(top.in_degree).toBe(2);
  });
});

describe('recoveryStatus', () => {
  test('percentages are taken against the victim-loss base and sum to ~100', () => {
    const r = recoveryStatus(150000, 40000, 20000, 0);
    expect(r.base_amount).toBe(150000);
    expect(r.cashed_out_pct).toBeCloseTo(26.7, 0);
    expect(r.recoverable).toBe(90000);
    const total = r.cashed_out_pct + r.on_hold_pct + r.refunded_pct + r.recoverable_pct;
    expect(total).toBeCloseTo(100, 0);
  });
});

describe('analyzeReport (end-to-end shape)', () => {
  test('summary separates victim loss from trail disputed; modules are present', async () => {
    const result = await analyzeReport(99, buildTrail(), []);
    const s = result.summary;
    expect(s.duplicate_count).toBe(1);
    expect(s.unique_transactions).toBe(3);          // 3 hops after dedup
    expect(s.victim_loss_amount).toBe(150000);       // layer-1 disputed
    expect(s.total_layers).toBe(2);
    // The full module set is wired into the result.
    expect(Array.isArray(result.money_flow_network.top_edges)).toBe(true);
    expect(result.recovery_status.base_amount).toBe(150000);
    expect(Array.isArray(result.investigation_roadmap)).toBe(true);
    expect(result.victim_accounts).toHaveLength(2);
    expect(result.timeline_summary.first_fraud_date).toBe('2024-03-01');
    // Layer 1 hop count + amount (the headline reconciliation).
    const layer1 = result.layer_analysis.find((l) => l.layer_no === 1);
    expect(layer1.txn_count).toBe(2);
    expect(layer1.total_amount).toBe(150000);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── v0.2.0 — bank attribution + cash-out policy ────────────────────────

/**
 * Fixture exercising the v0.2.0 fields the parser now emits: a resolved
 * `beneficiary_bank`, the original text in `raw_beneficiary_bank`, and a
 * `bank_flag`. M1 also withdraws MORE than its disputed inflow so the
 * CAP_AT_RECEIVED policy must bite.
 */
function buildAttributionTrail() {
  return [
    // V → M1: IFSC resolved to HDFC, but the source text wrongly said IndusInd.
    { ack_no: 'C1', victim_account: 'V1', beneficiary_account: 'M1',
      beneficiary_bank: 'HDFC Bank', raw_beneficiary_bank: 'IndusInd Bank',
      bank_source: 'IFSC', bank_flag: 'IFSC_TEXT_MISMATCH', ifsc_code: 'HDFC0001475',
      transaction_date: '2024-03-01T10:00:00.000Z', transaction_amount: 100000,
      disputed_amount: 100000, utr_no: 'U-1', payment_mode: 'IMPS', layer_no: 1, state: 'Delhi' },
    // M1 cashes out 120k — exceeds the 100k disputed it received.
    { ack_no: 'C1', victim_account: 'M1', beneficiary_account: 'M1',
      beneficiary_bank: 'HDFC Bank', raw_beneficiary_bank: 'IndusInd Bank',
      bank_source: 'IFSC', bank_flag: 'IFSC_TEXT_MISMATCH', ifsc_code: 'HDFC0001475',
      transaction_date: '2024-03-01T16:00:00.000Z', transaction_amount: 120000,
      disputed_amount: 120000, utr_no: 'U-2', payment_mode: 'ATM', layer_no: 1,
      atm_id: 'ATMX', state: 'Delhi' },
    // V → W1: a wallet with no IFSC (name taken from text).
    { ack_no: 'C1', victim_account: 'V1', beneficiary_account: 'W1',
      beneficiary_bank: 'Mobikwik', raw_beneficiary_bank: 'Mobikwik',
      bank_source: 'TEXT', bank_flag: 'NO_IFSC', ifsc_code: null,
      transaction_date: '2024-03-01T11:00:00.000Z', transaction_amount: 30000,
      disputed_amount: 30000, utr_no: 'U-3', payment_mode: 'UPI', layer_no: 1, state: 'Delhi' },
  ];
}

describe('dataQuality (v0.2.0 bank attribution)', () => {
  test('lists each flagged account once, mismatches first, with a message', () => {
    const dq = dataQuality(buildAttributionTrail());
    expect(dq.map((d) => d.account_no)).toEqual(['M1', 'W1']); // mismatch before no-ifsc
    const m1 = dq.find((d) => d.account_no === 'M1');
    expect(m1.bank).toBe('HDFC Bank');
    expect(m1.raw_bank).toBe('IndusInd Bank');
    expect(m1.bank_flag).toBe('IFSC_TEXT_MISMATCH');
    expect(m1.message).toMatch(/HDFC Bank/);
    const w1 = dq.find((d) => d.account_no === 'W1');
    expect(w1.bank_flag).toBe('NO_IFSC');
  });

  test('clean rows (no flag) produce no data-quality entries', () => {
    const dq = dataQuality(buildStandardTransactions());
    expect(dq).toEqual([]);
  });
});

describe('analyzeReport cash-out policy + data_quality wiring', () => {
  test('CAP_AT_RECEIVED caps the headline cash-out and keeps the uncapped audit figure', async () => {
    const result = await analyzeReport(7, buildAttributionTrail(), []);
    const c = result.cashout_analysis;
    expect(c.cashout_policy).toBe('CAP_AT_RECEIVED');
    expect(c.total_cashout_amount_uncapped).toBe(120000); // raw ATM withdrawal
    expect(c.total_cashout_amount).toBe(100000);          // capped at M1's 100k disputed inflow
    // data_quality surfaces in the result + the summary badge count.
    expect(result.data_quality.map((d) => d.account_no).sort()).toEqual(['M1', 'W1']);
    expect(result.summary.bank_flags_count).toBe(2);
  });

  test('cashed_out is one value across summary, cashout view, and recovery status', async () => {
    const result = await analyzeReport(7, buildAttributionTrail(), []);
    const s = result.summary;
    expect(s.cashed_out).toBe(100000);                              // single source of truth
    expect(result.cashout_analysis.total_cashout_amount).toBe(s.cashed_out);
    expect(result.recovery_status.cashed_out).toBe(s.cashed_out);
  });

  test('recoverable_residual derives and the split reconciles to the victim loss', async () => {
    const result = await analyzeReport(7, buildAttributionTrail(), []);
    const s = result.summary;
    // victim loss 130k (100k + 30k at layer 1); capped cash-out 100k; nothing held/refunded.
    expect(s.victim_loss_amount).toBe(130000);
    expect(s.recoverable_residual).toBe(30000);                    // 130k - 100k - 0 - 0
    const sum = s.cashed_out + s.on_hold + s.refunded + s.recoverable_residual;
    expect(sum).toBe(s.victim_loss_amount);
  });
});
