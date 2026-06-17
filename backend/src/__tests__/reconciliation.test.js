'use strict';

/**
 * Headline ⟷ Annexure reconciliation (FIX 1+2). The cover/exec headline counts
 * every parsed leg, but Annexure A (per-layer) sums disputed_amount on HOP legs
 * only and Annexure G (timeline) drops undated rows. Previously the residual
 * (~₹6.6L disputed on cash-out/other legs; 6 exact duplicates + 7 undated txns)
 * vanished from the annexures while staying in the headline.
 *
 * These lock the contract that the annexures FOOT to the headline explicitly:
 *   • analyzer exposes a `reconciliation` object whose parts provably sum to the
 *     headline (no leg silently dropped);
 *   • Annexure A renders the EXIT/OTHER split that foots its Disputed column to
 *     Total Trail Disputed;
 *   • Annexure G renders an "Undated" row footing to the unique-txn total, with
 *     the removed duplicates explained.
 * Driven by the real CypherSOL gold case through the actual parser + analyzer.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseNcrpFile } = require('../parsers/ncrpParser');
const { analyzeReport } = require('../analyzers/analyzer');
const { generateReportPdf } = require('../utils/pdfGenerator');
const { extractPdfText } = require('./helpers/pdfText');

const GOLD_PATH = path.join(__dirname, '..', '..', '..', '32712250107145 (1).xlsx');

// Gold figures for case …145 (confirmed against the dossier review).
const GOLD = {
  total_transactions: 151,
  total_disputed_amount: 2207182.22,
  disputed: { hop: 1524475.23, exit: 553865.23, hold: 0, other: 128841.76, total: 2207182.22 },
  transactions: { dated: 138, undated: 7, unique: 145, duplicates: 6, raw_legs: 151 },
};
const EPS = 0.01;

let analysis;
let pdfFlat;

beforeAll(async () => {
  expect(fs.existsSync(GOLD_PATH)).toBe(true);
  const parsed = parseNcrpFile(GOLD_PATH);
  expect(parsed.errors).toEqual([]);
  const txnRows = parsed.rows.map((r, i) => ({ id: i + 1, ...r }));
  analysis = await analyzeReport(1, txnRows, []);

  const pdfPath = path.join(os.tmpdir(), `ncrp-recon-test-${process.pid}.pdf`);
  await generateReportPdf({
    report: { id: 0, ack_no: '32712250107145' },
    analysis, liens: analysis.lien_calculation, emails: [],
    layers: analysis.layer_analysis, transactions: txnRows, ack_no: '32712250107145',
  }, pdfPath);
  pdfFlat = extractPdfText(fs.readFileSync(pdfPath)).replace(/\s+/g, ' ');
  fs.unlinkSync(pdfPath);
}, 60000);

describe('analyzer reconciliation object', () => {
  test('disputed parts sum to the headline Total Trail Disputed', () => {
    const d = analysis.reconciliation.disputed;
    expect(Math.abs((d.hop + d.exit + d.hold + d.other) - d.total)).toBeLessThan(EPS);
    expect(Math.abs(d.total - analysis.summary.total_disputed_amount)).toBeLessThan(EPS);
  });

  test('disputed.hop equals the sum of the per-layer Disputed column (Annexure A)', () => {
    const layerDisputed = analysis.layer_analysis.reduce((a, l) => a + Number(l.disputed_amount || 0), 0);
    expect(Math.abs(layerDisputed - analysis.reconciliation.disputed.hop)).toBeLessThan(EPS);
  });

  test('transaction buckets foot: dated+undated=unique, unique+duplicates=raw_legs=headline', () => {
    const tx = analysis.reconciliation.transactions;
    expect(tx.dated + tx.undated).toBe(tx.unique);
    expect(tx.unique + tx.duplicates).toBe(tx.raw_legs);
    expect(tx.raw_legs).toBe(analysis.summary.total_transactions);
  });

  test('matches the confirmed gold figures for case …145', () => {
    const d = analysis.reconciliation.disputed;
    expect(d.hop).toBeCloseTo(GOLD.disputed.hop, 2);
    expect(d.exit).toBeCloseTo(GOLD.disputed.exit, 2);
    expect(d.other).toBeCloseTo(GOLD.disputed.other, 2);
    expect(d.hold).toBeCloseTo(GOLD.disputed.hold, 2);
    expect(d.total).toBeCloseTo(GOLD.disputed.total, 2);
    expect(analysis.reconciliation.transactions).toMatchObject(GOLD.transactions);
  });
});

describe('dossier annexures foot to the headline', () => {
  test('Annexure A renders the EXIT/OTHER disputed reconciliation', () => {
    expect(pdfFlat).toMatch(/Reconciliation to headline Total Trail Disputed/i);
    expect(pdfFlat).toMatch(/Cash-out legs \(EXIT\)/i);
    expect(pdfFlat).toMatch(/Other legs \(OTHER\)/i);
  });

  test('Annexure G renders the Undated row + duplicate footnote', () => {
    expect(pdfFlat).toMatch(/\bUndated\b/);
    // Footnote bridges unique (145) -> raw legs (151) via the removed duplicates.
    expect(pdfFlat).toMatch(/unique transactions/i);
    expect(pdfFlat).toMatch(/exact-duplicate ledger row/i);
  });

  test('headline figures are unchanged (no financial drift)', () => {
    expect(analysis.summary.total_transactions).toBe(GOLD.total_transactions);
    expect(analysis.summary.total_disputed_amount).toBeCloseTo(GOLD.total_disputed_amount, 2);
  });
});
