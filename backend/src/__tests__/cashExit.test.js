'use strict';

/**
 * Unit tests for Features 4 & 5 — cash/exit channel analytics and the behavioural
 * flags: Rapid Withdrawals + Multi-ATM (ATM) and Suspicious Merchants (POS).
 *
 * Thresholds (thresholds.js): rapid = ≥3 exits within 60 min by one account;
 * multi-ATM = ≥3 distinct ATMs in one IST day; suspicious merchant = ≥3 POS txns
 * within 60 min at one terminal. Fixtures are hand-built cash-exit legs so each
 * flag's firing/non-firing is obvious.
 */

const { analyzeReport, cashExitAnalysis, _internals } = require('../analyzers/analyzer');
const { enrichTransactions } = _internals;

let seq = 0;
function exit(account, dateIso, amount, { mode = 'ATM', atm_id = 'ATM1', location = 'Loc', city = 'Metro' } = {}) {
  seq += 1;
  return {
    id: seq,
    ack_no: 'ACK', complaint_date: '2024-01-01T00:00:00.000Z',
    victim_account: account, victim_bank: 'BankB',
    beneficiary_account: account, beneficiary_bank: 'BankB',
    beneficiary_name: account, ifsc_code: 'BANK0001234',
    transaction_date: dateIso, transaction_amount: amount, disputed_amount: amount,
    utr_no: `X${seq}`, payment_mode: mode, layer_no: 2,
    atm_id, atm_location: location, city, state: 'S', remarks: null,
  };
}
const flagOf = (channel, key) => (channel.flags || []).find((f) => f.key === key);

describe('cash-exit channel bucketing + summary', () => {
  test('buckets ATM / POS / AEPS and reports channels present', () => {
    const ce = cashExitAnalysis(enrichTransactions([
      exit('A', '2024-01-15T00:00:00.000Z', 1000, { mode: 'ATM' }),
      exit('B', '2024-01-15T00:00:00.000Z', 2000, { mode: 'POS', atm_id: 'MID1' }),
      exit('C', '2024-01-15T00:00:00.000Z', 3000, { mode: 'AEPS', atm_id: 'AE1' }),
    ]));
    expect(ce.channels.ATM.count).toBe(1);
    expect(ce.channels.POS.count).toBe(1);
    expect(ce.channels.AEPS.count).toBe(1);
    expect(ce.summary.total_withdrawals).toBe(3);
    expect(ce.summary.channels_present.sort()).toEqual(['AEPS', 'ATM', 'POS']);
    expect(ce.summary.total_withdrawn_gross).toBe(6000);
  });

  test('empty state — no cash-exit legs', () => {
    const ce = cashExitAnalysis(enrichTransactions([
      { // a pure HOP (not a cash exit)
        id: 1, ack_no: 'ACK', victim_account: 'V', beneficiary_account: 'M',
        beneficiary_bank: 'B', ifsc_code: 'BANK0001234',
        transaction_date: '2024-01-15T00:00:00.000Z', transaction_amount: 5000, disputed_amount: 5000,
        payment_mode: 'IMPS', layer_no: 1, atm_id: null, atm_location: null,
      },
    ]));
    expect(ce.summary.total_withdrawals).toBe(0);
    expect(ce.summary.channels_present).toEqual([]);
    expect(ce.summary.risk_flag_count).toBe(0);
    expect(ce.channels.ATM.count).toBe(0);
  });
});

describe('Rapid Withdrawals (ATM)', () => {
  test('flags an account with ≥3 withdrawals inside 60 min; not one spread out', () => {
    const ce = cashExitAnalysis(enrichTransactions([
      // A: 3 in 20 min, same ATM (so multi-ATM does NOT also fire) → rapid
      exit('A', '2024-01-15T00:00:00.000Z', 10000, { atm_id: 'ATMx' }),
      exit('A', '2024-01-15T00:10:00.000Z', 8000, { atm_id: 'ATMx' }),
      exit('A', '2024-01-15T00:20:00.000Z', 9000, { atm_id: 'ATMx' }),
      // B: 3 spread across the day at one ATM → neither flag
      exit('B', '2024-01-15T00:00:00.000Z', 5000, { atm_id: 'ATMy' }),
      exit('B', '2024-01-15T02:00:00.000Z', 5000, { atm_id: 'ATMy' }),
      exit('B', '2024-01-15T05:00:00.000Z', 5000, { atm_id: 'ATMy' }),
    ]));
    const rapid = flagOf(ce.channels.ATM, 'rapid');
    expect(rapid.count).toBe(1);
    expect(rapid.instances[0].account).toBe('A');
    expect(rapid.instances[0].count).toBe(3);
    expect(rapid.instances[0].why).toMatch(/3 withdrawals in \d+ min/);
    expect(flagOf(ce.channels.ATM, 'multi_atm').count).toBe(0);
  });
});

describe('Multi-ATM Accounts', () => {
  test('flags an account using ≥3 distinct ATMs in one day; rapid stays clear when spread', () => {
    const ce = cashExitAnalysis(enrichTransactions([
      exit('C', '2024-01-15T00:00:00.000Z', 4000, { atm_id: 'ATM1' }),
      exit('C', '2024-01-15T02:00:00.000Z', 4000, { atm_id: 'ATM2' }),
      exit('C', '2024-01-15T04:00:00.000Z', 4000, { atm_id: 'ATM3' }),
    ]));
    const multi = flagOf(ce.channels.ATM, 'multi_atm');
    expect(multi.count).toBe(1);
    expect(multi.instances[0].distinct_atms).toBe(3);
    expect(multi.instances[0].why).toMatch(/3 different ATMs/);
    expect(flagOf(ce.channels.ATM, 'rapid').count).toBe(0); // 2h apart → no cluster
  });
});

describe('Suspicious Merchants (POS, Feature 5)', () => {
  test('flags a terminal with ≥3 POS txns inside 60 min', () => {
    const ce = cashExitAnalysis(enrichTransactions([
      exit('M', '2024-01-15T00:00:00.000Z', 10000, { mode: 'POS', atm_id: 'MID9', location: 'COCO IT PARK' }),
      exit('M', '2024-01-15T00:15:00.000Z', 10000, { mode: 'POS', atm_id: 'MID9', location: 'COCO IT PARK' }),
      exit('M', '2024-01-15T00:30:00.000Z', 10000, { mode: 'POS', atm_id: 'MID9', location: 'COCO IT PARK' }),
      // a different terminal with only 2 txns → not flagged
      exit('N', '2024-01-15T00:00:00.000Z', 5000, { mode: 'POS', atm_id: 'MID2', location: 'Other' }),
      exit('N', '2024-01-15T00:05:00.000Z', 5000, { mode: 'POS', atm_id: 'MID2', location: 'Other' }),
    ]));
    const susp = flagOf(ce.channels.POS, 'suspicious_merchant');
    expect(susp.count).toBe(1);
    expect(susp.instances[0].terminal).toBe('MID9');
    expect(susp.instances[0].count).toBe(3);
    expect(susp.instances[0].why).toMatch(/3 POS txns in \d+ min/);
  });
});

describe('end to end via analyzeReport', () => {
  test('attaches cash_exit_analysis and sets the capped headline', async () => {
    const rows = [
      { id: 1, ack_no: 'A', victim_account: 'V', beneficiary_account: 'M', beneficiary_bank: 'B', ifsc_code: 'BANK0001234', transaction_date: '2024-01-15T00:00:00.000Z', transaction_amount: 100000, disputed_amount: 100000, payment_mode: 'IMPS', layer_no: 1 },
      exit('M', '2024-01-15T05:00:00.000Z', 40000, { atm_id: 'ATMz' }),
    ];
    const a = await analyzeReport(1, rows, []);
    expect(a.cash_exit_analysis).toBeDefined();
    expect(a.cash_exit_analysis.channels.ATM.count).toBe(1);
    // total_cashed_out tracks the capped headline, not the gross leg sum.
    expect(a.cash_exit_analysis.summary.total_cashed_out).toBe(a.summary.cashed_out);
  });
});
