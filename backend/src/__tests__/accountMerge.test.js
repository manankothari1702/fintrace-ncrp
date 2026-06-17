'use strict';

/**
 * Canonical account merge (FIX 4). The same bank account can appear zero-padded
 * on one row and bare on another (e.g. SBI "00000044021519366" vs "44021519366").
 * Previously these split into two rollup / data-quality entries, so Annexure H
 * showed the account twice (once IFSC_TEXT_MISMATCH "IDBI Bank", once NO_IFSC
 * "State Bank of India") and the lien worksheet double-tracked it.
 *
 * These lock:
 *   • canonicalAccountKey strips leading zeros ONLY for all-digit accounts, and
 *     leaves non-numeric placeholders verbatim & case-sensitive (so "NA" and
 *     "Na" — distinct wallet/PG placeholders — are never wrongly merged);
 *   • zero-padded variants collapse to one account across the lien worksheet and
 *     the data-quality (Annexure H) view, with the VALID-IFSC row's attribution
 *     winning;
 *   • the …9366 account is correctly a pass-through (no freeze-able balance →
 *     not liened), the money being recoverable downstream.
 */

const fs = require('fs');
const path = require('path');

const { parseNcrpFile } = require('../parsers/ncrpParser');
const { analyzeReport, _internals } = require('../analyzers/analyzer');
const { canonicalAccountKey } = _internals;

const GOLD_PATH = path.join(__dirname, '..', '..', '..', '32712250107145 (1).xlsx');
const canon = canonicalAccountKey;

describe('canonicalAccountKey (unit)', () => {
  test('zero-padded numeric variants collapse to one key', () => {
    expect(canon('00000044021519366')).toBe('44021519366');
    expect(canon('44021519366')).toBe('44021519366');
    expect(canon('0838020537493')).toBe('838020537493');
  });

  test('non-numeric placeholders are preserved verbatim and case-sensitively', () => {
    // "NA" and "Na" are distinct PG/wallet placeholders — must NOT merge.
    expect(canon('NA')).toBe('NA');
    expect(canon('Na')).toBe('Na');
    expect(canon('NA')).not.toBe(canon('Na'));
    expect(canon('Paytm')).toBe('Paytm');
  });

  test('edge cases do not throw or collapse distinct accounts', () => {
    expect(canon(null)).toBe('');
    expect(canon('   ')).toBe('');
    expect(canon('0')).toBe('0');
    expect(canon('000')).toBe('0');
    expect(canon('123')).not.toBe(canon('1230'));
  });
});

describe('canonical merge on the gold case …145', () => {
  let analysis;
  beforeAll(async () => {
    expect(fs.existsSync(GOLD_PATH)).toBe(true);
    const parsed = parseNcrpFile(GOLD_PATH);
    const txnRows = parsed.rows.map((r, i) => ({ id: i + 1, ...r }));
    analysis = await analyzeReport(1, txnRows, []);
  }, 60000);

  test('no zero-padded account variants split across the lien worksheet', () => {
    const seen = new Map();
    for (const l of analysis.lien_calculation) {
      const k = canon(l.account_no);
      expect(seen.has(k)).toBe(false);
      seen.set(k, l.account_no);
    }
  });

  test('no zero-padded account variants split across data quality (Annexure H)', () => {
    const seen = new Map();
    for (const d of analysis.data_quality) {
      const k = canon(d.account_no);
      expect(seen.has(k)).toBe(false);
      seen.set(k, d.account_no);
    }
  });

  test('SBI …9366 appears once, keeps the valid-IFSC attribution, and is a non-liened pass-through', () => {
    const dq9366 = analysis.data_quality.filter((d) => canon(d.account_no) === '44021519366');
    expect(dq9366).toHaveLength(1);
    expect(dq9366[0].ifsc_code).toBe('SBIN0064933');
    expect(dq9366[0].bank_flag).toBe('IFSC_TEXT_MISMATCH');
    expect(/state bank/i.test(dq9366[0].bank)).toBe(true);

    // Pass-through: received then forwarded → no balance to freeze → not liened.
    const lien9366 = analysis.lien_calculation.filter((l) => canon(l.account_no) === '44021519366');
    expect(lien9366).toHaveLength(0);
  });
});
