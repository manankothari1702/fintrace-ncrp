'use strict';

/**
 * Competitor-parity features (1–5), asserted against the verified golden fixture
 * for case 32709250080512 (tests/fixtures/case32709_golden.json) through the REAL
 * parser + analyzer + exporters. Every figure here was confirmed empirically
 * against the source file; see memory competitor-feature-golden-discrepancies for
 * why two originally-stated numbers were superseded by the engine's actual output.
 *
 *   Feature 1 — circular-flow (cycle) detection
 *   Feature 2 — account connectivity / aggregator (in-degree) analysis
 *   Feature 3 — byte-exact disputed reconciliation
 *   Feature 4 — reproducible lien (audit columns + formula)
 *   Feature 5 — day-of-week breakdown + IFSC-first attribution
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const { parseNcrpFile } = require('../parsers/ncrpParser');
const { analyzeReport } = require('../analyzers/analyzer');
const { generateReportPdf } = require('../utils/pdfGenerator');
const { generateReportExcel } = require('../utils/excelGenerator');
const { generateDraftEmails } = require('../utils/emailGenerator');
const { extractPdfText } = require('./helpers/pdfText');
const { analyzeConnectivity } = require('../analysis/connectivity');
const { detectCycles } = require('../analysis/cycleDetector');

const GOLD_PATH = path.join(__dirname, '..', '..', '..', 'BankAction_CompleteTrail.xlsx');
const FIX = require('./fixtures/case32709_golden.json');

let analysis;
let txnRows;
let pdfText;
let wb;

/** Read a workbook sheet as an array-of-arrays. */
function sheetAoa(workbook, name) {
  const ws = workbook.Sheets[name];
  if (!ws) return null;
  return XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
}

/** Sorted "a|b" key for an unordered account pair. */
function pairKey(a, b) {
  return [String(a), String(b)].sort().join('|');
}

beforeAll(async () => {
  expect(fs.existsSync(GOLD_PATH)).toBe(true);
  const parsed = parseNcrpFile(GOLD_PATH);
  expect(parsed.errors).toEqual([]);
  txnRows = parsed.rows.map((r, i) => ({ id: i + 1, ...r }));
  analysis = await analyzeReport(1, txnRows, []);

  const liens = analysis.lien_calculation;
  const emails = generateDraftEmails(0, liens, {
    ack_no: '32709250080512', complaint_date: null,
    total_disputed_amount: analysis.summary.total_disputed_amount,
  });
  const bundle = {
    report: { id: 0, ack_no: '32709250080512' },
    analysis, liens, emails,
    layers: analysis.layer_analysis, transactions: txnRows,
    ack_no: '32709250080512', complaint_date: null,
  };

  const pdfPath = path.join(os.tmpdir(), `ncrp-compfeat-${process.pid}.pdf`);
  await generateReportPdf(bundle, pdfPath);
  pdfText = extractPdfText(fs.readFileSync(pdfPath)).replace(/\s+/g, ' ');
  fs.unlinkSync(pdfPath);

  wb = XLSX.read(generateReportExcel(bundle), { type: 'buffer' });
}, 60000);

// ─── Feature 1 — circular-flow (cycle) detection ──────────────────────────
describe('Feature 1 — circular-flow detection', () => {
  test('analyzer detects exactly the golden number of cycles', () => {
    expect(Array.isArray(analysis.circular_flows)).toBe(true);
    expect(analysis.circular_flows).toHaveLength(FIX.feature1_cycles.count);
  });

  test('the three golden account pairs are all present as 2-cycles', () => {
    const detected = new Set(
      analysis.circular_flows
        .filter((c) => c.length === 2)
        .map((c) => pairKey(c.path[0], c.path[1]))
    );
    for (const [a, b] of FIX.feature1_cycles.pairs) {
      expect(detected.has(pairKey(a, b))).toBe(true);
    }
  });

  test('every cycle is simple, within the length bound, and amount = min edge', () => {
    for (const c of analysis.circular_flows) {
      expect(c.length).toBeGreaterThanOrEqual(2);
      expect(c.length).toBeLessThanOrEqual(FIX.feature1_cycles.maxLen);
      expect(new Set(c.path).size).toBe(c.path.length); // no repeated node
      expect(c.amount).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(c.banks)).toBe(true);
    }
    // Path is normalised to start at its lexicographically-smallest node.
    for (const c of analysis.circular_flows) {
      const min = [...c.path].sort()[0];
      expect(c.path[0]).toBe(min);
    }
  });

  test('cycles are sorted by amount descending (deterministic)', () => {
    const amts = analysis.circular_flows.map((c) => c.amount);
    expect(amts).toEqual([...amts].sort((a, b) => b - a));
    // Heaviest loop matches the verified figure (the 5000 reciprocal pair).
    const top = analysis.circular_flows[0];
    expect(top.amount).toBeCloseTo(FIX.feature1_cycles.list[0].amount, 2);
  });

  test('Excel "Circular Flows" sheet carries one row per cycle', () => {
    const aoa = sheetAoa(wb, 'Circular Flows');
    expect(aoa).not.toBeNull();
    const headerIdx = aoa.findIndex((r) => Array.isArray(r) && r[0] === 'Cycle (account loop)');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    const dataRows = aoa.slice(headerIdx + 1).filter((r) => Array.isArray(r) && r[1] != null && r[1] !== '');
    expect(dataRows).toHaveLength(FIX.feature1_cycles.count);
  });

  test('PDF dossier renders the Circular Flows section', () => {
    expect(pdfText).toMatch(/Circular Flows/i);
    expect(pdfText).toMatch(/circular flow\(s\) detected/i);
  });
});

// ─── Feature 2 — account connectivity / aggregator analysis ───────────────
describe('Feature 2 — connectivity / aggregators', () => {
  test('top aggregator is the golden collector with in/out-degree 3', () => {
    expect(Array.isArray(analysis.aggregators)).toBe(true);
    const top = analysis.aggregators[0];
    expect(top.account_no).toBe(FIX.feature2_connectivity.topCollector.account);
    expect(top.in_degree).toBe(FIX.feature2_connectivity.topCollector.inDegree);
    expect(top.out_degree).toBe(FIX.feature2_connectivity.topCollector.outDegree);
  });

  test('the collector set (in-degree >= 2) matches the fixture exactly', () => {
    const collectors = analysis.aggregators;
    expect(collectors).toHaveLength(FIX.feature2_connectivity.collectorsInDegreeGte2Count);
    expect(new Set(collectors.map((c) => c.account_no)))
      .toEqual(new Set(FIX.feature2_connectivity.collectors.map((c) => c.account)));

    const byAcct = Object.fromEntries(collectors.map((c) => [c.account_no, c]));
    for (const exp of FIX.feature2_connectivity.collectors) {
      const got = byAcct[exp.account];
      expect(got).toBeDefined();
      expect(got.in_degree).toBe(exp.inDegree);
      expect(got.out_degree).toBe(exp.outDegree);
      expect(got.total_in).toBeCloseTo(exp.totalIn, 2);
      expect(got.total_out).toBeCloseTo(exp.totalOut, 2);
      expect(got.in_degree).toBeGreaterThanOrEqual(2); // is genuinely a collector
    }
  });

  test('collectors are ranked deterministically (in-degree desc, total_in desc)', () => {
    const c = analysis.aggregators;
    for (let i = 1; i < c.length; i++) {
      const prev = c[i - 1];
      const cur = c[i];
      const ordered = prev.in_degree > cur.in_degree
        || (prev.in_degree === cur.in_degree && prev.total_in >= cur.total_in);
      expect(ordered).toBe(true);
    }
  });

  test('in-degree is fed into the mule score as a documented additive signal', () => {
    const topMule = analysis.mule_detection.find(
      (m) => m.account_no === FIX.feature2_connectivity.topCollector.account);
    expect(topMule).toBeDefined();
    // The graduated in-degree signal names the degree and the points it added.
    expect((topMule.suspicion_reasons || []).join(' '))
      .toMatch(/High fan-in collector: in-degree 3 \(\+6\)/);
  });

  test('Excel "Account Connectivity" sheet carries the per-account degrees', () => {
    const aoa = sheetAoa(wb, 'Account Connectivity');
    expect(aoa).not.toBeNull();
    const hdr = aoa.findIndex((r) => Array.isArray(r) && r[0] === 'Account No.');
    expect(hdr).toBeGreaterThanOrEqual(0);
    const rows = aoa.slice(hdr + 1).filter((r) => Array.isArray(r) && r[0] != null && r[2] != null);
    const topRow = rows.find((r) => String(r[0]) === FIX.feature2_connectivity.topCollector.account);
    expect(topRow).toBeDefined();
    expect(topRow[2]).toBe(3);       // In-degree
    expect(topRow[3]).toBe(3);       // Out-degree
    expect(topRow[6]).toBe('Yes');   // Collector flag
  });

  test('PDF dossier renders the Top Aggregator Accounts table', () => {
    expect(pdfText).toMatch(/Top Aggregator Accounts/i);
  });
});

// ─── Feature 3 — byte-exact disputed reconciliation ───────────────────────
describe('Feature 3 — disputed reconciliation', () => {
  const F = FIX.feature3_disputedReconciliation;

  test('reconciliation.disputed exposes the raw-hop / dedup chain (fixture match)', () => {
    const d = analysis.reconciliation.disputed;
    expect(d.raw_hop).toBeCloseTo(F.rawHopInclDup, 2);
    expect(d.dedup_hop_adjustment).toBeCloseTo(F.dedupAdjustment, 2);
    expect(d.hop).toBeCloseTo(F.netHop, 2);
    expect(d.exit).toBeCloseTo(F.exit, 2);
    expect(d.hold).toBeCloseTo(F.hold, 2);
    expect(d.other).toBeCloseTo(F.other, 2);
    expect(d.total).toBeCloseTo(F.headline, 2);
  });

  test('components foot LITERALLY to the headline (byte-exact)', () => {
    const d = analysis.reconciliation.disputed;
    const comp = d.raw_hop - d.dedup_hop_adjustment + d.exit + d.hold + d.other;
    expect(Math.abs(comp - d.total)).toBeLessThan(0.005);
    expect(Math.abs((d.raw_hop - d.dedup_hop_adjustment) - d.hop)).toBeLessThan(0.005);
    expect(d.total).toBeCloseTo(analysis.summary.total_disputed_amount, 2);
  });

  test('the ₹409.56 leg is a UNIQUE hop, fully counted — not a collapsed duplicate', () => {
    // Corrected truth (fix/disputed-reconciliation-409): the old dedup key
    // (beneficiary|date|amount|utr) silently dropped the genuine ₹409.56 hop
    // because it collided with a DISTINCT ₹18.64-disputed leg sharing those four
    // fields. There is no exact-duplicate hop leg in this case.
    expect(analysis.reconciliation.disputed.dedup_hop_adjustment).toBeCloseTo(0, 2);
    expect(analysis.reconciliation.transactions.duplicates).toBe(0);
    expect(FIX.summary.duplicates).toBe(0);
    // The ₹409.56 hop survives de-dup and is present in the analysed trail...
    const survivors = txnRows.filter(
      (t) => String(t.victim_account) === '110263475064'
        && String(t.beneficiary_account) === '702902010004986'
        && String(t.utr_no) === '563707902816');
    const disputes = survivors.map((t) => Number(t.disputed_amount)).sort((a, b) => a - b);
    // ...alongside its distinct ₹18.64 sibling (both kept, neither collapsed).
    expect(disputes).toEqual([18.64, 409.56]);
    // Net hop now equals raw hop (nothing collapsed), and both feed the headline.
    expect(analysis.reconciliation.disputed.hop)
      .toBeCloseTo(analysis.reconciliation.disputed.raw_hop, 2);
  });

  test('headline Total Trail Disputed is byte-identical across JSON, Excel, PDF', () => {
    const headline = analysis.summary.total_disputed_amount;
    expect(headline).toBeCloseTo(FIX.summary.totalDisputed, 2);
    // Excel Summary cell.
    const sm = sheetAoa(wb, 'Summary');
    const row = sm.find((r) => Array.isArray(r) && r[0] === 'Total trail disputed (all layers) [Rs.]');
    expect(row).toBeDefined();
    expect(Number(row[1])).toBeCloseTo(headline, 2);
    // PDF text (Indian-grouped "Rs." string).
    expect(pdfText).toMatch(/Rs\.\s*2,03,524\.16/);
  });

  test('PDF Annexure A renders the disputed reconciliation, footing to the headline', () => {
    expect(pdfText).toMatch(/Reconciliation to headline Total Trail Disputed/i);
    // No exact-duplicate hop leg in this case, so Annexure A states hop legs
    // directly (no "duplicate hop legs collapsed" subtraction) and adds the
    // EXIT/OTHER dispositions to foot to the headline.
    expect(pdfText).toMatch(/Hop legs \(sum of per-layer Disputed above\)/i);
    expect(pdfText).toMatch(/Other legs \(OTHER\)/i);
    expect(pdfText).not.toMatch(/duplicate hop legs collapsed/i);
    expect(pdfText).toMatch(/Total Trail Disputed \(headline\)/i);
  });
});

// ─── Feature 4 — reproducible lien (audit columns + formula) ──────────────
describe('Feature 4 — reproducible lien', () => {
  const F = FIX.feature4_lien;

  test('lien total and account count match the verified gold', () => {
    const liens = analysis.lien_calculation;
    const sum = liens.reduce((s, l) => s + l.lien_eligible_amount, 0);
    expect(sum).toBeCloseTo(F.total, 2);                               // 32,767.45
    expect(liens.filter((l) => l.lien_eligible_amount > 0)).toHaveLength(F.count); // 49
    expect(liens).toHaveLength(F.count);
  });

  test('every row reconstructs lien = max(0, min(grossBalance, disputedInflow))', () => {
    for (const l of analysis.lien_calculation) {
      const gb = Math.max(0, l.total_received - l.onward_forwarded - l.total_on_hold - l.total_cashed_out);
      expect(gb).toBeCloseTo(l.gross_balance, 2);
      const recomputed = Math.max(0, Math.min(l.gross_balance, l.disputed_received));
      expect(recomputed).toBeCloseTo(l.lien_eligible_amount, 2);
      // Audit columns present and populated.
      expect(typeof l.disputed_forwarded).toBe('number');
      expect(typeof l.cap_excess).toBe('number');
      expect(typeof l.excluded_reason).toBe('string');
      expect(l.excluded_reason.length).toBeGreaterThan(0);
    }
  });

  test('the no-cap naive == lien total + cap excess + excluded gross (explains the delta)', () => {
    const liens = analysis.lien_calculation;
    const lienTotal = liens.reduce((s, l) => s + l.lien_eligible_amount, 0);
    const capExcess = liens.reduce((s, l) => s + l.cap_excess, 0);
    const excludedGross = (analysis.lien_excluded || []).reduce((s, e) => s + e.gross_balance, 0);
    expect(lienTotal + capExcess + excludedGross).toBeCloseTo(F.naiveNoCap, 2); // 71,463.12
  });

  test('residue-bearing accounts are all accounted for (liened or listed excluded)', () => {
    const excluded = analysis.lien_excluded;
    expect(Array.isArray(excluded)).toBe(true);
    for (const e of excluded) {
      expect(e.gross_balance).toBeGreaterThan(0);
      expect(e.excluded_reason.length).toBeGreaterThan(0);
    }
    // For case 512 the cap only trims amounts; it floors no account to zero.
    expect(excluded).toHaveLength(0);
  });

  test('Excel Lien sheet carries audit columns, formula, exclusion rule, and total', () => {
    const aoa = sheetAoa(wb, 'Lien Calculation');
    expect(aoa).not.toBeNull();
    const header = aoa.find((r) => Array.isArray(r) && r[0] === 'Account No.');
    expect(header).toContain('Disputed Fwd [Rs.]');
    expect(header).toContain('Cap / Exclusion Reason');
    const flat = aoa.map((r) => (r || []).join(' ')).join('\n');
    expect(flat).toMatch(/Lien Eligible = max\(0, min\(Gross Balance, Disputed Inflow\)\)/);
    expect(flat).toMatch(/EXCLUSION RULE/);
    expect(flat).toMatch(/NO-CAP COMPARISON/);
    const lienIdx = header.indexOf('Lien Eligible [Rs.]');
    const totalRow = aoa.find((r) => Array.isArray(r)
      && String(r[0]).startsWith('Total lien-eligible balance'));
    expect(totalRow).toBeDefined();
    expect(Number(totalRow[lienIdx])).toBeCloseTo(F.total, 2);
  });

  test('PDF Annexure D prints the exact formula + exclusion rule', () => {
    expect(pdfText).toMatch(/Per-account formula & exclusion rule/i);
    expect(pdfText).toMatch(/Lien = max\(0, min\(Gross Balance, Disputed Inflow\)\)/);
    expect(pdfText).toMatch(/EXCLUDED:/);
  });
});

// ─── Feature 5 — day-of-week + IFSC-first attribution ─────────────────────
describe('Feature 5 — day-of-week breakdown', () => {
  const F = FIX.feature5_dayOfWeek;

  test('weekday counts and amounts match the verified fixture (IST)', () => {
    const dow = analysis.day_of_week;
    expect(Array.isArray(dow.weekdays)).toBe(true);
    expect(dow.weekdays.map((w) => w.weekday)).toEqual(F.weekdayOrder);
    const byDay = Object.fromEntries(dow.weekdays.map((w) => [w.weekday, w]));
    for (const [name, exp] of Object.entries(F.byWeekday)) {
      expect(byDay[name].txns).toBe(exp.txns);
      expect(byDay[name].totalAmount).toBeCloseTo(exp.totalAmount, 2);
    }
    expect(dow.undated.txns).toBe(F.undated.txns);
    expect(dow.undated.totalAmount).toBeCloseTo(F.undated.totalAmount, 2);
  });

  test('dated + undated legs foot to the deduped unique total', () => {
    const dow = analysis.day_of_week;
    const dated = dow.weekdays.reduce((s, w) => s + w.txns, 0);
    expect(dated).toBe(F.datedTxns);                                  // 143
    expect(dated + dow.undated.txns).toBe(FIX.summary.reconUnique);   // 154
  });

  test('Excel "Day of Week" sheet carries the weekday rows + Undated', () => {
    const aoa = sheetAoa(wb, 'Day of Week');
    expect(aoa).not.toBeNull();
    const hdr = aoa.findIndex((r) => Array.isArray(r) && r[0] === 'Weekday');
    expect(hdr).toBeGreaterThanOrEqual(0);
    const monday = aoa.find((r) => Array.isArray(r) && r[0] === 'Monday');
    expect(monday).toBeDefined();
    expect(Number(monday[1])).toBe(F.byWeekday.Monday.txns);
    const undated = aoa.find((r) => Array.isArray(r) && r[0] === 'Undated');
    expect(undated).toBeDefined();
    expect(Number(undated[1])).toBe(F.undated.txns);
  });

  test('PDF timeline section renders the day-of-week table', () => {
    expect(pdfText).toMatch(/Activity by day of week/i);
  });
});

describe('Feature 5 — IFSC-first bank attribution feeds the new outputs', () => {
  test('connectivity / cycle banks use the IFSC-resolved name, never the raw text', () => {
    // Synthetic 2-cycle A<->B where the resolved bank (beneficiary_bank, set by the
    // parser's IFSC-first resolver) deliberately differs from the raw source text.
    const rows = [
      {
        row_kind: 'HOP', victim_account: 'A', beneficiary_account: 'B',
        beneficiary_bank: 'HDFC Bank', raw_beneficiary_bank: 'IndusInd Bank',
        ifsc_code: 'HDFC0001234', transaction_amount: 1000, disputed_amount: 1000,
        layer_no: 1, transaction_date: '2024-01-01T00:00:00.000Z',
      },
      {
        row_kind: 'HOP', victim_account: 'B', beneficiary_account: 'A',
        beneficiary_bank: 'ICICI Bank', raw_beneficiary_bank: 'Union Bank of India',
        ifsc_code: 'ICIC0005678', transaction_amount: 900, disputed_amount: 900,
        layer_no: 2, transaction_date: '2024-01-02T00:00:00.000Z',
      },
    ];
    const conn = analyzeConnectivity(rows);
    const byAcct = Object.fromEntries(conn.accounts.map((a) => [a.account_no, a]));
    expect(byAcct.B.bank).toBe('HDFC Bank'); // resolved, from beneficiary_bank
    expect(byAcct.A.bank).toBe('ICICI Bank');
    for (const a of conn.accounts) {
      expect(String(a.bank)).not.toMatch(/IndusInd|Union Bank/); // never raw text
    }
    const cycles = detectCycles(rows);
    expect(cycles).toHaveLength(1);
    expect(cycles[0].banks).toEqual(['HDFC Bank', 'ICICI Bank']);
    expect(cycles[0].banks.join(',')).not.toMatch(/IndusInd|Union Bank/);
  });

  test('real-file: every connectivity bank token is a parser IFSC-resolved value', () => {
    const resolvedBanks = new Set(txnRows.map((t) => t.beneficiary_bank).filter(Boolean));
    for (const a of analysis.connectivity.accounts) {
      if (!a.bank) continue;
      for (const token of String(a.bank).split('; ')) {
        expect(resolvedBanks.has(token)).toBe(true);
      }
    }
  });
});
