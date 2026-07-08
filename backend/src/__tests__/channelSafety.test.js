'use strict';

/**
 * Channel-safety regression tests — three robustness concerns the gold cases
 * (...145, ...170) do NOT exercise. Each test would FAIL if the dangerous
 * behaviour were present.
 *
 * CHECK 1 — disputed_amount on cashout channels is genuinely unused by the
 *   money math. cashed_out is Σ transaction_amount over EXIT rows capped
 *   per-account at disputed_received, and disputed_received is summed ONLY
 *   over HOP (transfer) rows. EXIT-row disputed_amount feeds only the
 *   write-only rollup field `disputed_cashed_out` and the all-legs reference
 *   sum `total_trail_disputed`. So an ATM/AEPS sheet without a Disputed
 *   Amount column must produce IDENTICAL cashed_out and lien — not an
 *   inflated lien.
 *
 * CHECK 2 — forwardFillMerges() is range-scoped: it copies a merged range's
 *   anchor value into the cells that range COVERS, and nothing else. A blank
 *   cell that is not inside any merge must never inherit the value above it.
 *
 * CHECK 3 — a renamed cashout sheet cannot leak into the transfer bucket.
 *   Channel category comes from the sheet name, but HOP classification
 *   requires beneficiary ≠ victim, and the parser's cross-sheet join sets
 *   beneficiary_account = victim_account on every sheet that lacks a
 *   beneficiary column — so cashout rows can never become transfer hops.
 *   CONSEQUENCE-SCOPED unknown-sheet policy: a fully-renamed cashout sheet
 *   (unknown name, transaction-shaped rows, and NO payment-mode / ATM-ID /
 *   beneficiary column to classify rows individually) is REFUSED via the
 *   fail-loud path (422 PARSE_BLOCKED) — excluding it would understate
 *   cashed_out and inflate the lien. Unknown sheets WITHOUT
 *   transaction-shaped rows (cover pages, notes) keep skip-and-warn (202).
 */

process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const os = require('os');
const request = require('supertest');
const XLSX = require('xlsx');

const { parseNcrpFile, _internals } = require('../parsers/ncrpParser');
const { analyzeReport } = require('../analyzers/analyzer');
const { initializeDatabase } = require('../db/schema');
const { createApp } = require('../server');
const { loginAs, authed } = require('./helpers/auth');

const { SHEET_CATEGORY, classifySheet } = _internals;

// ─── Fixture builders ───────────────────────────────────────────────────

const tempFiles = [];
afterAll(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch (_e) { /* best effort */ }
  }
});

function writeTempWorkbook(sheetDefs) {
  const wb = XLSX.utils.book_new();
  for (const def of sheetDefs) {
    const ws = XLSX.utils.aoa_to_sheet(def.rows);
    if (def.merges) ws['!merges'] = def.merges;
    XLSX.utils.book_append_sheet(wb, ws, def.name);
  }
  const filePath = path.join(
    os.tmpdir(),
    `ncrp-chansafe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`
  );
  XLSX.writeFile(wb, filePath);
  tempFiles.push(filePath);
  return filePath;
}

/**
 * One Money-Transfer sheet: victim V0001 → mule MULE1, ₹1,00,000 gross,
 * ₹1,00,000 disputed, layer 1. Real-export header spellings.
 */
function transferSheet() {
  return {
    name: 'Money Transfer to',
    rows: [
      ['Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Bank/FIs', 'Layer',
        'Account No', 'Action Taken By bank', 'IFSC Code', 'Transaction Date',
        'Transaction Amount', 'Disputed Amount', 'UTR/Reference No', 'Remarks'],
      ['ACK1', 'V0001', 'HDFC Bank', 1,
        'MULE1', 'ICICI Bank', 'ICIC0001234', '2024-01-15 10:00:00',
        100000, 100000, 'UTR1', 'IMPS'],
    ],
  };
}

/**
 * A cashout sheet for MULE1: two exits, ₹25,000 + ₹15,000 = ₹40,000.
 * `name` and `withDisputed` vary per test.
 */
function cashoutSheet(name, { withDisputed }) {
  const headers = ['Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer',
    'Transaction Amount', 'Transaction Date', 'Action Taken By bank', 'Remarks'];
  if (withDisputed) headers.push('Disputed Amount');
  const row = (amt) => {
    const r = ['ACK1', 'MULE1', 1, amt, '2024-01-15 14:00:00', 'ICICI Bank', null];
    if (withDisputed) r.push(amt);
    return r;
  };
  return { name, rows: [headers, row(25000), row(15000)] };
}

/** Parse + analyze a workbook; returns { parsed, result }. */
async function analyzeWorkbook(sheetDefs) {
  const parsed = parseNcrpFile(writeTempWorkbook(sheetDefs));
  expect(parsed.errors).toEqual([]);
  const rows = parsed.rows.map((r, i) => ({ id: i + 1, ...r }));
  const result = await analyzeReport(1, rows, []);
  return { parsed, result };
}

const lienFor = (result, acct) =>
  result.lien_calculation.find((l) => l.account_no === acct);

// ─── CHECK 1 — disputed_amount on cashout channels ──────────────────────

describe('CHECK 1: cashout sheet without Disputed Amount cannot inflate the lien', () => {
  test('ATM sheet with vs without Disputed Amount → IDENTICAL cashed_out, lien, victim_loss', async () => {
    const withDisputed = await analyzeWorkbook([
      transferSheet(),
      cashoutSheet('Withdrawal through ATM', { withDisputed: true }),
    ]);
    const withoutDisputed = await analyzeWorkbook([
      transferSheet(),
      cashoutSheet('Withdrawal through ATM', { withDisputed: false }),
    ]);

    // The figures that reach the officer must be byte-identical.
    expect(withoutDisputed.result.summary.cashed_out)
      .toBe(withDisputed.result.summary.cashed_out);
    expect(withoutDisputed.result.summary.victim_loss_amount)
      .toBe(withDisputed.result.summary.victim_loss_amount);
    expect(withoutDisputed.result.summary.lien_table_total)
      .toBe(withDisputed.result.summary.lien_table_total);

    // And they must be the CORRECT values, not merely equal-and-wrong:
    // cashed_out = Σ exit transaction_amount (40,000), capped at the 1,00,000
    // disputed received on the transfer side; lien = min(gross balance,
    // disputed_received) = min(100000 − 40000, 100000) = 60,000.
    expect(withDisputed.result.summary.victim_loss_amount).toBe(100000);
    expect(withDisputed.result.summary.cashed_out).toBe(40000);
    expect(lienFor(withDisputed.result, 'MULE1').lien_eligible_amount).toBe(60000);
    expect(lienFor(withoutDisputed.result, 'MULE1').lien_eligible_amount).toBe(60000);

    // The ONLY divergence is the all-legs reference sum (total_trail_disputed,
    // which double-counts by design and drives no recovery math): 1,40,000
    // when the ATM legs carry disputed, 1,00,000 when they don't.
    expect(withDisputed.result.summary.total_trail_disputed).toBe(140000);
    expect(withoutDisputed.result.summary.total_trail_disputed).toBe(100000);
  });

  test('AEPS sheet without Disputed Amount → same invariant', async () => {
    const { result } = await analyzeWorkbook([
      transferSheet(),
      cashoutSheet('AEPS', { withDisputed: false }),
    ]);
    expect(result.summary.cashed_out).toBe(40000);
    expect(result.summary.victim_loss_amount).toBe(100000);
    expect(lienFor(result, 'MULE1').lien_eligible_amount).toBe(60000);
  });
});

// ─── CHECK 2 — merge fill is range-scoped, never fill-down ──────────────

describe('CHECK 2: forward-fill touches ONLY merged ranges', () => {
  test('a genuinely empty amount cell below a populated one stays 0 — never backfilled', () => {
    const filePath = writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [
        ['Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer', 'Account No',
          'Transaction Amount', 'Disputed Amount', 'Transaction Date', 'UTR/Reference No'],
        ['ACK1', 'V0001', 1, 'M1', 1000, 1000, '2024-01-15', 'U1'],
        ['ACK1', 'V0001', 1, 'M2', null, null, '2024-01-15', 'U2'],   // blank, NOT merged
        ['ACK1', 'V0001', 1, 'M3', 2000, 2000, '2024-01-15', 'U3'],
      ],
      // No merges at all.
    }]);

    const { rows, errors, warnings } = parseNcrpFile(filePath);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.transaction_amount)).toEqual([1000, 0, 2000]);
    const total = rows.reduce((s, r) => s + r.transaction_amount, 0);
    expect(total).toBe(3000); // fill-down corruption would read 4000
    expect(warnings.some((w) => /merged/i.test(w))).toBe(false);
  });

  test('positive control: a real merged range IS filled, while a blank outside it is not', () => {
    const filePath = writeTempWorkbook([{
      name: 'Money Transfer to',
      rows: [
        ['Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer', 'Account No',
          'Transaction Amount', 'Disputed Amount', 'Transaction Date', 'UTR/Reference No'],
        ['ACK1', 'V0001', 1, 'M1', 1000, 1000, '2024-01-15', 'U1'],
        [null,   'V0001', 1, 'M2', null, null, '2024-01-15', 'U2'],  // ack covered by merge; amount NOT
        [null,   'V0001', 1, 'M3', 2000, 2000, '2024-01-15', 'U3'],  // ack covered by merge
      ],
      // A2:A4 — the Ack No block only (column 0, data rows 1-3).
      merges: [{ s: { r: 1, c: 0 }, e: { r: 3, c: 0 } }],
    }]);

    const { rows, errors } = parseNcrpFile(filePath);
    expect(errors).toEqual([]);
    expect(rows.map((r) => r.ack_no)).toEqual(['ACK1', 'ACK1', 'ACK1']);   // merge filled
    expect(rows.map((r) => r.transaction_amount)).toEqual([1000, 0, 2000]); // blank untouched
  });
});

// ─── CHECK 3 — renamed cashout sheet cannot become a transfer ────────────

describe('CHECK 3: renamed cashout sheets never leak into the transfer bucket', () => {
  test('properly-named AEPS sheet: exits counted as cashout (baseline)', async () => {
    const { result } = await analyzeWorkbook([
      transferSheet(),
      cashoutSheet('AEPS', { withDisputed: false }),
    ]);
    expect(result.summary.unique_transactions).toBe(1);   // exactly the one real hop
    expect(result.summary.victim_loss_amount).toBe(100000);
    expect(result.summary.cashed_out).toBe(40000);
    expect(lienFor(result, 'MULE1').lien_eligible_amount).toBe(60000);
  });

  test('fully-renamed AEPS sheet with data: REFUSED via structured ParseError (consequence-scoped)', () => {
    // No 'aeps'/'atm'/'pos'/'hold' hint in the name, and AEPS-shaped columns
    // carry no payment-mode / ATM-ID / beneficiary column — the channel is
    // genuinely undeterminable. Excluding these rows would understate
    // cashed_out and inflate MULE1's lien (₹1,00,000 instead of ₹60,000), so
    // the parser must refuse instead of warn-and-degrade.
    const parsed = parseNcrpFile(writeTempWorkbook([
      transferSheet(),
      cashoutSheet('BC Cash Disbursal', { withDisputed: false }),
    ]));

    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]).toMatchObject({
      code: 'UNKNOWN_CHANNEL_WITH_TRANSACTIONS',
      sheet: 'BC Cash Disbursal',
      dataRows: 2,
    });
    expect(parsed.errors[0].foundHeaders).toEqual(
      expect.arrayContaining(['Transaction Amount', 'Account No./ (Wallet /PG/PA) Id']));
    expect(parsed.errors[0].message).toMatch(/channel could not be determined/i);
    expect(parsed.errors[0].message).toMatch(/understate cashed-out|overstate the lien/i);

    // The unclassifiable sheet contributes ZERO rows; only the transfer row
    // survives — and the route will refuse the whole upload (422) anyway.
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].beneficiary_account).toBe('MULE1');
    const refused = parsed.sheets.find((s) => s.name === 'BC Cash Disbursal');
    expect(refused).toMatchObject({ accepted: false, reason: 'unknown-channel' });
  });

  test('renamed ATM sheet is rescued by its ATM ID column (row-level classification)', async () => {
    // Same renamed-sheet situation, but ATM sheets carry an ATM ID column —
    // classifyCashoutMode keys on atm_id per ROW, so the channel survives the
    // rename and cashed_out stays correct.
    const headers = ['Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Layer',
      'Withdrawal Amount', 'Withdrawal Date', 'ATM ID', 'Place of ATM'];
    const { parsed, result } = await analyzeWorkbook([
      transferSheet(),
      {
        name: 'Cash Machine Log',  // no channel hint in the name
        rows: [
          headers,
          ['ACK1', 'MULE1', 1, 25000, '2024-01-15 14:00:00', 'ATM77', 'LUCKNOW'],
          ['ACK1', 'MULE1', 1, 15000, '2024-01-15 15:00:00', 'ATM77', 'LUCKNOW'],
        ],
      },
    ]);

    expect(parsed.warnings.some((w) => /Cash Machine Log/.test(w))).toBe(true);
    expect(result.summary.cashed_out).toBe(40000);
    expect(result.summary.unique_transactions).toBe(1);
    expect(lienFor(result, 'MULE1').lien_eligible_amount).toBe(60000);
  });

  test('a cashout name containing "transfer" still resolves to the cashout channel (regex order)', () => {
    expect(classifySheet('Funds Transfer via AEPS').category).toBe(SHEET_CATEGORY.AEPS);
    expect(classifySheet('Transfer to ATM withdrawal').category).toBe(SHEET_CATEGORY.ATM);
  });
});

// ─── Route-level consequence-scoped policy (422 vs 202) ─────────────────

describe('upload route: unknown-sheet policy is consequence-scoped', () => {
  let db;
  let app;
  let agent;

  beforeAll(async () => {
    db = initializeDatabase(':memory:');
    app = createApp(db);
    agent = authed(app, await loginAs(app));
  });

  afterAll(() => {
    try { db.close(); } catch (_e) { /* best effort */ }
  });

  /** Build an in-memory workbook buffer from sheet defs. */
  function workbookBuffer(sheetDefs) {
    const wb = XLSX.utils.book_new();
    for (const def of sheetDefs) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(def.rows), def.name);
    }
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  test('unknown sheet WITH transaction rows → 422 PARSE_BLOCKED, nothing ingested', async () => {
    const buf = workbookBuffer([
      transferSheet(),
      cashoutSheet('BC Cash Disbursal', { withDisputed: false }),
    ]);

    const res = await agent
      .post('/api/ncrp/upload')
      .attach('ncrpFile', buf, 'renamed_aeps.xlsx');

    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('PARSE_BLOCKED');
    expect(res.body.error.message).toMatch(/BC Cash Disbursal/);
    expect(res.body.error.message).toMatch(/channel could not be determined/i);
    expect(res.body.error.message).toMatch(/No figures were computed/i);
    expect(res.body.error.details.parseErrors[0]).toMatchObject({
      code: 'UNKNOWN_CHANNEL_WITH_TRANSACTIONS',
      sheet: 'BC Cash Disbursal',
      dataRows: 2,
    });

    const list = await agent.get('/api/ncrp/reports');
    expect(list.body).toEqual([]);
  });

  test('control: unknown sheets WITHOUT transaction rows (cover page / notes) → 202 + warning', async () => {
    const buf = workbookBuffer([
      transferSheet(),
      // Cover page: free text, no detectable header at all.
      { name: 'Cover Page', rows: [['NCRP BankAction Report'], ['Generated 05-01-2026'], ['For official use only']] },
      // Notes tab: junk content.
      { name: 'Notes', rows: [['lorem', 'ipsum'], ['dolor', 'sit amet']] },
    ]);

    const res = await agent
      .post('/api/ncrp/upload')
      .attach('ncrpFile', buf, 'with_notes.xlsx');

    expect(res.status).toBe(202);
    expect(res.body.reportId).toEqual(expect.any(Number));
    expect(res.body.rowCount).toBe(1); // the transfer row only
    expect(res.body.warnings.some((w) =>
      /Skipped 2 sheet/i.test(w) && /Cover Page/.test(w) && /Notes/.test(w))).toBe(true);
  });
});
