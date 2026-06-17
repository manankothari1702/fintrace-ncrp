'use strict';

/**
 * Data-quality layer tests (FinTrace v0.2.0, severity model v2).
 *
 * Covers: per-flag detection end-to-end (real .xlsx → parser → analyzer), the
 * two-tier severity model (INFORMATIONAL vs ACTIONABLE), the freeze-target
 * dimension, the green/amber/red status logic, and the ADVISORY-ONLY
 * invariant (flags never alter a financial figure).
 *
 * Flag names are DB-persisted and unchanged; only their WEIGHT changed:
 *   INFORMATIONAL (never drives amber/red):
 *     IFSC_TEXT_MISMATCH — IFSC won; the inconsistency is auto-corrected.
 *     NO_IFSC on structurally IFSC-less rows — IFSC-confirmed elsewhere,
 *       cash-exit/hold channel rows, or wallet/PG/PA text.
 *   ACTIONABLE (drives severity):
 *     INVALID_IFSC, UNKNOWN_IFSC_PREFIX, and NO_IFSC on bank-account-type
 *     rows (or indeterminate — fail toward caution).
 *   Status: green = no actionable; red = actionable on a freeze-target
 *   (lien-table) account; amber = actionable elsewhere only.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');

const { parseNcrpFile } = require('../parsers/ncrpParser');
const { analyzeReport, dataQuality, dataQualitySummary, _internals } = require('../analyzers/analyzer');
const { bank_texts: GOLD_BANK_TEXTS } = require('./fixtures/gold_bank_texts.json');

// ─── Fixture builders ───────────────────────────────────────────────────

const tempFiles = [];
afterAll(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch (_e) { /* best effort */ }
  }
});

const TRANSFER_HEADERS = [
  'Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer',
  'Account No', 'Action Taken By bank', 'IFSC Code',
  'Transaction Date', 'Transaction Amount', 'Disputed Amount', 'UTR/Reference No',
];

/** One transfer row: `from` → `acct` with the given bank text + IFSC. */
function txnRow(acct, bankText, ifsc, { amount = 10000, utr, from = 'V0001', layer = 1 } = {}) {
  return ['ACK1', from, layer, acct, bankText, ifsc,
    '2024-01-15 10:00:00', amount, amount, utr || `UTR-${acct}`];
}

function writeWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of sheets) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name);
  }
  const filePath = path.join(
    os.tmpdir(),
    `ncrp-dq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`
  );
  XLSX.writeFile(wb, filePath);
  tempFiles.push(filePath);
  return filePath;
}

function writeTransferXlsx(rows) {
  return writeWorkbook([['Money Transfer to', [TRANSFER_HEADERS, ...rows]]]);
}

async function analyzeFile(filePath) {
  const parsed = parseNcrpFile(filePath);
  expect(parsed.errors).toEqual([]);
  return analyzeReport(1, parsed.rows.map((r, i) => ({ id: i + 1, ...r })), []);
}

// ─── Per-flag-type detection, end to end ────────────────────────────────

describe('data-quality flags — each type detected end-to-end (xlsx → parser → analyzer)', () => {
  let result;
  beforeAll(async () => {
    result = await analyzeFile(writeTransferXlsx([
      txnRow('B-MISMATCH', 'ICICI Bank', 'HDFC0001234'),    // IFSC says HDFC, text says ICICI
      txnRow('B-NOIFSC', 'Paytm', null),                    // wallet, no IFSC
      txnRow('B-INVALID', 'SBI', 'BAD123'),                 // malformed IFSC
      txnRow('B-UNKNOWN', 'Some Coop Bank', 'ZZZZ0999999'), // valid shape, unmapped prefix
      txnRow('B-CLEAN', 'HDFC Bank', 'HDFC0005678'),        // clean: IFSC and text agree
    ]));
  });

  const rowOf = (acct) => result.data_quality.find((r) => r.account_no === acct);

  test('IFSC bank ≠ stated bank → IFSC_TEXT_MISMATCH, IFSC wins, INFORMATIONAL', () => {
    const row = rowOf('B-MISMATCH');
    expect(row.bank_flag).toBe('IFSC_TEXT_MISMATCH');
    expect(row.bank).toBe('HDFC Bank');       // IFSC-authoritative
    expect(row.raw_bank).toBe('ICICI Bank');  // source text preserved for audit
    expect(row.severity).toBe('informational');
  });

  test('missing IFSC on a wallet → NO_IFSC, INFORMATIONAL (expected)', () => {
    const row = rowOf('B-NOIFSC');
    expect(row.bank_flag).toBe('NO_IFSC');
    expect(row.bank).toBe('Paytm');
    expect(row.severity).toBe('informational');
  });

  test('malformed IFSC → INVALID_IFSC, ACTIONABLE', () => {
    const row = rowOf('B-INVALID');
    expect(row.bank_flag).toBe('INVALID_IFSC');
    expect(row.severity).toBe('actionable');
  });

  test('valid-shape but unmapped prefix → UNKNOWN_IFSC_PREFIX, ACTIONABLE (never guessed)', () => {
    const row = rowOf('B-UNKNOWN');
    expect(row.bank_flag).toBe('UNKNOWN_IFSC_PREFIX');
    expect(row.severity).toBe('actionable');
  });

  test('clean account is NOT flagged', () => {
    expect(rowOf('B-CLEAN')).toBeUndefined();
  });

  test('summary: raw counts kept, severity split correct, red (actionable on freeze targets)', () => {
    const dq = result.data_quality_summary;
    expect(dq.counts).toEqual({
      IFSC_TEXT_MISMATCH: 1, UNKNOWN_IFSC_PREFIX: 1, INVALID_IFSC: 1, NO_IFSC: 1,
    });
    expect(dq.informational).toEqual({ auto_corrected: 1, expected_no_ifsc: 1 });
    expect(dq.actionable_accounts).toBe(2);
    expect(dq.actionable_counts).toEqual({ INVALID_IFSC: 1, UNKNOWN_IFSC_PREFIX: 1, NO_IFSC: 0 });
    // Both actionable accounts kept their money → they sit in the lien table.
    expect(dq.freeze_target_flags).toBe(2);
    expect(dq.freeze_target_accounts.sort()).toEqual(['B-INVALID', 'B-UNKNOWN']);
    expect(dq.status).toBe('red');
    expect(result.summary.bank_flags_count).toBe(4);
  });
});

// ─── Severity tiers drive status (the user-visible contract) ────────────

describe('status logic — green/amber/red is freeze-target scoped', () => {
  test('auto-corrected mismatch alone → GREEN (resolved, not open)', async () => {
    const result = await analyzeFile(writeTransferXlsx([
      txnRow('A1', 'Totally Wrong Bank', 'HDFC0001234'),  // mismatch, IFSC wins
      txnRow('A2', 'State Bank of India', 'SBIN0009876'), // clean
    ]));
    const dq = result.data_quality_summary;
    expect(dq.informational.auto_corrected).toBe(1);
    expect(dq.actionable_accounts).toBe(0);
    expect(dq.status).toBe('green');
  });

  test('wallet NO_IFSC alone → GREEN (structurally IFSC-less, expected)', async () => {
    const result = await analyzeFile(writeTransferXlsx([
      txnRow('W1', 'PhonePe', null),
      txnRow('A2', 'HDFC Bank', 'HDFC0001234'),
    ]));
    const dq = result.data_quality_summary;
    expect(dq.informational.expected_no_ifsc).toBe(1);
    expect(dq.actionable_accounts).toBe(0);
    expect(dq.status).toBe('green');
  });

  test('NO_IFSC from cash-exit rows when the bank is IFSC-confirmed elsewhere → GREEN', async () => {
    // MULE1's transfer row resolves cleanly from IFSC; its ATM exits carry
    // bank text but (structurally) no IFSC column → NO_IFSC artifact rows.
    const filePath = writeWorkbook([
      ['Money Transfer to', [TRANSFER_HEADERS,
        txnRow('MULE1', 'HDFC Bank', 'HDFC0001234', { amount: 100000, utr: 'U1' })]],
      ['Withdrawal through ATM', [
        ['Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer',
          'Withdrawal Amount', 'Withdrawal Date', 'ATM ID', 'Action Taken By bank'],
        ['ACK1', 'MULE1', 1, 40000, '2024-01-15 14:00:00', 'ATM1', 'HDFC Bank'],
      ]],
    ]);
    const result = await analyzeFile(filePath);
    const dq = result.data_quality_summary;
    expect(dq.counts.NO_IFSC).toBe(1);                  // the artifact is recorded…
    expect(dq.informational.expected_no_ifsc).toBe(1);  // …but informational
    expect(dq.status).toBe('green');
  });

  test('INVALID_IFSC on a non-freeze account (forwarded everything) → AMBER', async () => {
    const result = await analyzeFile(writeTransferXlsx([
      // M-PASS receives ₹10,000 with a malformed IFSC, forwards all of it on →
      // lien 0 → NOT a freeze target. M-END keeps the money (clean).
      txnRow('M-PASS', 'SBI', 'NOT-AN-IFSC', { utr: 'U1' }),
      txnRow('M-END', 'HDFC Bank', 'HDFC0001234', { from: 'M-PASS', layer: 2, utr: 'U2' }),
    ]));
    const dq = result.data_quality_summary;
    expect(dq.actionable_accounts).toBe(1);
    expect(dq.actionable_counts.INVALID_IFSC).toBe(1);
    expect(dq.freeze_target_flags).toBe(0);
    expect(result.lien_calculation.some((l) => l.account_no === 'M-PASS')).toBe(false);
    expect(dq.status).toBe('amber');
  });

  test('UNKNOWN_IFSC_PREFIX on a freeze-target account → RED, account listed', async () => {
    const result = await analyzeFile(writeTransferXlsx([
      txnRow('F1', 'Some Coop Bank', 'ZZZZ0999999'), // keeps the money → lien target
      txnRow('A2', 'HDFC Bank', 'HDFC0001234'),
    ]));
    const dq = result.data_quality_summary;
    expect(result.lien_calculation.some((l) => l.account_no === 'F1')).toBe(true);
    expect(dq.actionable_counts.UNKNOWN_IFSC_PREFIX).toBe(1);
    expect(dq.freeze_target_flags).toBe(1);
    expect(dq.freeze_target_accounts).toEqual(['F1']);
    expect(dq.status).toBe('red');
    const row = result.data_quality.find((r) => r.account_no === 'F1');
    expect(row.severity).toBe('actionable');
    expect(row.freeze_target).toBe(true);
  });

  test('NO_IFSC on a bank-account-type row (indeterminate) → ACTIONABLE, fail toward caution', async () => {
    const result = await analyzeFile(writeTransferXlsx([
      // Bank-name text, transfer row, no IFSC anywhere, money retained:
      // exactly the ...145 Kotak case — must be actionable and red.
      txnRow('K1', 'Kotak Mahindra Bank', null),
      txnRow('A2', 'HDFC Bank', 'HDFC0001234'),
    ]));
    const dq = result.data_quality_summary;
    expect(dq.actionable_counts.NO_IFSC).toBe(1);
    expect(dq.informational.expected_no_ifsc).toBe(0);
    expect(dq.status).toBe('red'); // K1 retains funds → freeze target
  });

  test('all-clean file → GREEN with zero everything', async () => {
    const result = await analyzeFile(writeTransferXlsx([
      txnRow('C1', 'HDFC Bank', 'HDFC0001234'),
      txnRow('C2', 'State Bank of India', 'SBIN0009876'),
    ]));
    const dq = result.data_quality_summary;
    expect(dq.status).toBe('green');
    expect(dq.flagged_accounts).toBe(0);
    expect(dq.actionable_accounts).toBe(0);
    expect(dq.freeze_target_flags).toBe(0);
    expect(dq.freeze_target_total).toBe(2); // both lien-table accounts confirmed
  });
});

// ─── Unit-level aggregation ─────────────────────────────────────────────

describe('dataQualitySummary — unit behaviour', () => {
  test('an account flagged on several rows counts once (first flag wins)', () => {
    const rows = [
      { beneficiary_account: 'X1', bank_flag: 'INVALID_IFSC', beneficiary_bank: 'SBI' },
      { beneficiary_account: 'X1', bank_flag: 'NO_IFSC', beneficiary_bank: 'SBI' },
      { beneficiary_account: 'X2', bank_flag: null },
    ];
    const dqRows = dataQuality(rows);
    expect(dqRows).toHaveLength(1);
    const dq = dataQualitySummary(rows, dqRows, []);
    expect(dq.flagged_accounts).toBe(1);
    expect(dq.total_accounts).toBe(2);
    expect(dq.actionable_counts.INVALID_IFSC).toBe(1);
    expect(dq.status).toBe('amber'); // actionable, but no lien rows supplied
  });

  test('freeze-target intersection uses the lien account list', () => {
    const rows = [
      { beneficiary_account: 'X1', bank_flag: 'UNKNOWN_IFSC_PREFIX', beneficiary_bank: 'Bank A' },
    ];
    const dqRows = dataQuality(rows);
    const amber = dataQualitySummary(rows, dqRows, [{ account_no: 'OTHER' }]);
    expect(amber.status).toBe('amber');
    const red = dataQualitySummary(rows, dqRows, [{ account_no: 'X1' }]);
    expect(red.status).toBe('red');
    expect(red.freeze_target_accounts).toEqual(['X1']);
  });

  test('empty trail → green with 0/0, no NaN', () => {
    const dq = dataQualitySummary([], [], []);
    expect(dq.status).toBe('green');
    expect(dq.total_accounts).toBe(0);
    expect(dq.pct_affected).toBe(0);
    expect(dq.actionable_accounts).toBe(0);
    expect(dq.freeze_target_flags).toBe(0);
  });
});

// ─── WALLET_PG_PA_RE — no false positive on real bank names ─────────────

describe('WALLET_PG_PA_RE matches no real bank-account name from the gold cases', () => {
  // A false-positive wallet match silently downgrades a bank account's
  // NO_IFSC flag to informational — hiding a freeze-target uncertainty.
  // The fixture is every distinct bank-account name text observed in cases
  // ...145 and ...170 (genuine wallet/PG/PA entities excluded). This caught
  // a real bug: the former 'slice' pattern matched "Slice Small Finance
  // Bank", an RBI-licensed bank present in ...170.
  const RE = _internals.WALLET_PG_PA_RE;

  test(`none of the ${GOLD_BANK_TEXTS.length} real bank texts match`, () => {
    const falsePositives = GOLD_BANK_TEXTS.filter((t) => RE.test(t));
    expect(falsePositives).toEqual([]);
  });

  test('the regression case: "Slice Small Finance Bank" is in the fixture and does not match', () => {
    expect(GOLD_BANK_TEXTS).toContain('Slice Small Finance Bank');
    expect(RE.test('Slice Small Finance Bank')).toBe(false);
  });

  test('genuine wallet/PG/PA entities still match (the regex is not gutted)', () => {
    for (const wallet of ['Paytm', 'PhonePe', 'Mobikwik', 'Razorpay', 'Ease Buzz', 'Amazon Pay', 'PINE LABS', 'Payu']) {
      expect(RE.test(wallet)).toBe(true);
    }
  });
});

// ─── Advisory-only invariant ────────────────────────────────────────────

describe('flags are advisory metadata only — financial totals are unaffected', () => {
  test('identical amounts with clean vs fully-flagged attribution → identical money figures', async () => {
    const amounts = { amount: 50000 };
    const clean = await analyzeFile(writeTransferXlsx([
      txnRow('M1', 'HDFC Bank', 'HDFC0001234', { ...amounts, utr: 'U1' }),
      txnRow('M2', 'State Bank of India', 'SBIN0009876', { ...amounts, utr: 'U2' }),
    ]));
    const flagged = await analyzeFile(writeTransferXlsx([
      txnRow('M1', 'Totally Wrong Bank', 'HDFC0001234', { ...amounts, utr: 'U1' }), // mismatch
      txnRow('M2', 'SBI', 'BAD-IFSC', { ...amounts, utr: 'U2' }),                   // invalid → red
    ]));

    expect(flagged.data_quality_summary.flagged_accounts).toBe(2);
    expect(flagged.data_quality_summary.status).toBe('red');
    expect(clean.data_quality_summary.status).toBe('green');

    // Every officer-facing money figure must be byte-identical.
    for (const key of [
      'victim_loss_amount', 'total_trail_disputed', 'cashed_out', 'on_hold',
      'recoverable_residual', 'lien_table_total', 'total_layers', 'unique_transactions',
    ]) {
      expect(flagged.summary[key]).toEqual(clean.summary[key]);
    }
    expect(flagged.summary.victim_loss_amount).toBe(100000);
    expect(flagged.summary.lien_table_total).toBe(100000);

    // Per-account lien rows match amount-for-amount.
    const lienAmounts = (r) => r.lien_calculation
      .map((l) => [l.account_no, l.lien_eligible_amount])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(lienAmounts(flagged)).toEqual(lienAmounts(clean));
  });
});
