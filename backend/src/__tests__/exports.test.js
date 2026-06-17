'use strict';

/**
 * Export reconciliation + presentation tests — PDF dossier (pdfGenerator) and
 * XLSX workbook (excelGenerator), driven by the real CypherSOL gold case
 * (32712250107145) through the actual parser + analyzer. These lock the three
 * writer-side fixes that keep the dossier internally reconcilable:
 *
 *   ISSUE 1 — the ATM and POS cash-out detail tables are scoped cleanly (no
 *     terminal/transaction on both) and carry a gross-vs-confirmed
 *     reconciliation line that is arithmetically exact
 *     (gross - duplicates - cap = confirmed headline).
 *   ISSUE 2 — the PDF actually lists the POS merchant cash-outs and only prints
 *     "No POS / merchant cashouts were detected" when there are genuinely none.
 *   ISSUE 3 — the XLSX Lien Calculation sheet populates the derivation columns
 *     (Layer + Received/Forwarded/On Hold/Cashed Out) and reconciles to Lien
 *     Eligible via the analyzer's real formula
 *     (Lien Eligible = min(max(0, Received - Forwarded - On Hold - Cashed Out),
 *      Disputed Inflow)), with the headline total unchanged.
 *
 * These are PRESENTATION assertions: the money figures they reference
 * (cashed_out 5,44,282.95; lien total 4,34,394.61) come straight from the
 * analyzer and must stay byte-identical.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const { parseNcrpFile } = require('../parsers/ncrpParser');
const { analyzeReport } = require('../analyzers/analyzer');
const { generateReportExcel } = require('../utils/excelGenerator');
const { generateReportPdf } = require('../utils/pdfGenerator');
const { extractPdfText } = require('./helpers/pdfText');

const GOLD_PATH = path.join(__dirname, '..', '..', '..', '32712250107145 (1).xlsx');

// Headline figures that the writer fixes must not change (gold standard).
const HEADLINE_CASHOUT = 544282.95;
// FIX 4 (canonical-account merge): the zero-padded duplicate of SBI account
// …9366 merges into one pass-through account, removing a false ₹10,000 lien
// (4,34,394.61 → 4,24,394.61). Recovery headline unchanged.
const LIEN_TOTAL = 424394.61;
const POS_GROSS = 113050; // 11 POS legs in the source ledger.
const EPS = 0.02;

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Rows of a sheet from row 1 up to (not including) the first all-blank row. */
function leadingDataRows(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const blank = r.length === 0 || r.every((c) => c === '' || c === null || c === undefined);
    if (blank) break;
    out.push(r);
  }
  return out;
}

/** Parse the gross/dup/cap/confirmed cash-out reconciliation block from a sheet. */
function reconFrom(sheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
  const find = (label) => {
    const r = rows.find((row) => String(row[0]).startsWith(label));
    return r ? num(r[1]) : null;
  };
  return {
    header: rows.some((r) => String(r[0]).startsWith('CASH-OUT RECONCILIATION')),
    gross: find('Gross withdrawals shown'),
    dup: find('Less duplicate rows included'),
    cap: find('Less excess over disputed inflow'),
    confirmed: find('Confirmed cashed out (headline)'),
  };
}

let analysis;
let txnRows;
let liens;
let wb;
let pdfText;

beforeAll(async () => {
  expect(fs.existsSync(GOLD_PATH)).toBe(true);
  const parsed = parseNcrpFile(GOLD_PATH);
  expect(parsed.errors).toEqual([]);
  txnRows = parsed.rows.map((r, i) => ({ id: i + 1, ...r }));
  analysis = await analyzeReport(1, txnRows, []);
  liens = analysis.lien_calculation;

  const buf = generateReportExcel({
    report: {}, analysis, liens, transactions: txnRows, ack_no: '32712250107145',
  });
  wb = XLSX.read(buf, { type: 'buffer' });

  const pdfPath = path.join(os.tmpdir(), `ncrp-export-test-${process.pid}.pdf`);
  await generateReportPdf({
    report: {}, analysis, liens, transactions: txnRows, ack_no: '32712250107145',
  }, pdfPath);
  pdfText = extractPdfText(fs.readFileSync(pdfPath));
  fs.unlinkSync(pdfPath);
}, 60000);

// ─── Gold-figure anchor — binds this test's analysis to the gold standard ───
describe('gold case anchor', () => {
  test('cashed-out headline and lien total match the gold standard', () => {
    expect(analysis.cashout_analysis.total_cashout_amount).toBeCloseTo(HEADLINE_CASHOUT, 2);
    expect(analysis.summary.cashed_out).toBeCloseTo(HEADLINE_CASHOUT, 2);
    const lienTotal = liens.reduce((s, l) => s + num(l.lien_eligible_amount), 0);
    expect(lienTotal).toBeCloseTo(LIEN_TOTAL, 2);
  });
});

// ─── ISSUE 1 — cash-out detail tables reconcile to the headline ─────────────
describe('ISSUE 1 — ATM/POS scoping + gross-vs-confirmed reconciliation', () => {
  test('ATM and POS detail sheets share no terminal / transaction', () => {
    const atm = leadingDataRows(wb.Sheets['ATM Exit Details']);
    const pos = leadingDataRows(wb.Sheets['POS Exit Details']);
    expect(atm.length).toBeGreaterThan(0);
    expect(pos.length).toBeGreaterThan(0);

    const atmTerminals = new Set(atm.map((r) => String(r[0])).filter(Boolean)); // ATM ID col
    const posTerminals = new Set(pos.map((r) => String(r[5])).filter(Boolean)); // Terminal ID col

    const overlap = [...atmTerminals].filter((id) => posTerminals.has(id));
    expect(overlap).toEqual([]);

    // The specific terminals the bug report saw double-listed belong to POS only.
    for (const posOnly of ['01298676', '39143920', '999999998']) {
      expect(posTerminals.has(posOnly)).toBe(true);
      expect(atmTerminals.has(posOnly)).toBe(false);
    }
  });

  test('detail amount columns are labelled as gross', () => {
    const atmHeader = XLSX.utils.sheet_to_json(wb.Sheets['ATM Exit Details'], { header: 1 })[0];
    const posHeader = XLSX.utils.sheet_to_json(wb.Sheets['POS Exit Details'], { header: 1 })[0];
    expect(atmHeader).toContain('Gross Amount [Rs.]');
    expect(posHeader).toContain('Gross Amount [Rs.]');
  });

  test('XLSX reconciliation line is present and arithmetically exact on both sheets', () => {
    for (const name of ['ATM Exit Details', 'POS Exit Details']) {
      const r = reconFrom(wb.Sheets[name]);
      expect(r.header).toBe(true);
      expect(r.gross).not.toBeNull();
      expect(r.confirmed).not.toBeNull();
      // gross - duplicates - cap = confirmed headline. The duplicate line is
      // omitted when the gross is already net of dupes (MINOR B), so treat a
      // missing dup row as 0.
      expect(r.gross - (r.dup || 0) - r.cap).toBeCloseTo(r.confirmed, 2);
      expect(r.confirmed).toBeCloseTo(HEADLINE_CASHOUT, 2);
      // The gross shown is strictly above the headline (the whole point of the line).
      expect(r.gross).toBeGreaterThan(r.confirmed);
    }
  });

  test('PDF carries the same reconciliation statement', () => {
    // Collapse whitespace: PDFKit line-wrapping inserts spaces at wrap points.
    const flat = pdfText.replace(/\s+/g, ' ');
    expect(flat).toContain('Reconciliation:');
    // Gross is already post-dedup, so the formula omits the duplicates term and
    // the line states the dupes were collapsed beforehand (MINOR B).
    expect(flat).toContain('gross - cap = confirmed');
    expect(flat).toContain('already net of');
    expect(flat).not.toMatch(/net of Rs\.\s*0\.00/i);
    expect(flat).toContain('Rs. 5,44,282.95'); // confirmed headline
  });
});

// ─── ISSUE 2 — PDF lists POS merchant cash-outs ─────────────────────────────
describe('ISSUE 2 — PDF POS / merchant cashouts', () => {
  test('PDF POS section is populated and does NOT claim "none detected"', () => {
    expect(pdfText).toContain('Top merchants (POS cashouts');
    expect(pdfText).not.toContain('No POS / merchant cashouts were detected');
    // The merchants the bug report expected to see in POS.
    expect(pdfText).toContain('BAHL');
    expect(pdfText).toContain('COCO');
    expect(pdfText).toContain('Dreamplug');
  });

  test('XLSX POS Exit Details is consistent (populated, sums to the source POS total)', () => {
    const pos = leadingDataRows(wb.Sheets['POS Exit Details']);
    expect(pos.length).toBe(11); // 11 POS legs in the source ledger
    const grossCol = pos.reduce((s, r) => s + num(r[3]), 0); // Gross Amount col
    expect(grossCol).toBeCloseTo(POS_GROSS, 2);
  });

  test('"none detected" IS emitted only when there are genuinely zero POS rows', async () => {
    const noPos = txnRows.filter((t) => String(t.payment_mode).toUpperCase() !== 'POS');
    const noPosAnalysis = {
      ...analysis,
      geography: { ...(analysis.geography || {}), top_merchants: [] },
    };
    const p = path.join(os.tmpdir(), `ncrp-export-nopos-${process.pid}.pdf`);
    await generateReportPdf({
      report: {}, analysis: noPosAnalysis, liens, transactions: noPos, ack_no: '32712250107145',
    }, p);
    const txt = extractPdfText(fs.readFileSync(p));
    fs.unlinkSync(p);
    expect(txt).toContain('No POS / merchant cashouts were detected');
  }, 30000);
});

// ─── ISSUE 3 — XLSX Lien Calculation derivation columns reconcile ────────────
describe('ISSUE 3 — Lien Calculation derivation columns', () => {
  // Column indices on the Lien Calculation sheet.
  const C = {
    layer: 3, received: 4, forwarded: 5, onHold: 6, cashedOut: 7,
    grossBalance: 8, disputedInflow: 9, lienEligible: 10,
  };

  test('every account row has a non-blank Layer and populated components', () => {
    const rows = leadingDataRows(wb.Sheets['Lien Calculation']);
    expect(rows.length).toBeGreaterThan(0);
    // Not the old all-zero bug: every lien row must have received > 0 and a layer.
    let allZero = 0;
    for (const r of rows) {
      expect(String(r[C.layer])).not.toBe('');
      expect(num(r[C.received])).toBeGreaterThan(0);
      if (num(r[C.received]) === 0 && num(r[C.forwarded]) === 0 &&
          num(r[C.onHold]) === 0 && num(r[C.cashedOut]) === 0) allZero += 1;
    }
    expect(allZero).toBe(0);
  });

  test('each row reconciles: lien = min(max(0, recv - fwd - hold - cash), disputed inflow)', () => {
    const rows = leadingDataRows(wb.Sheets['Lien Calculation']);
    for (const r of rows) {
      const received = num(r[C.received]);
      const forwarded = num(r[C.forwarded]);
      const onHold = num(r[C.onHold]);
      const cashedOut = num(r[C.cashedOut]);
      const grossBalance = num(r[C.grossBalance]);
      const disputedInflow = num(r[C.disputedInflow]);
      const lienEligible = num(r[C.lienEligible]);

      // Gross balance is the floored component subtraction.
      expect(grossBalance).toBeCloseTo(Math.max(0, received - forwarded - onHold - cashedOut), 1);
      // Lien eligible is the disputed-inflow-capped gross balance.
      expect(Math.min(grossBalance, disputedInflow)).toBeCloseTo(lienEligible, 1);
    }
  });

  test('the per-row lien values still total 4,34,394.61 (unchanged)', () => {
    const rows = leadingDataRows(wb.Sheets['Lien Calculation']);
    const sum = rows.reduce((s, r) => s + num(r[C.lienEligible]), 0);
    expect(sum).toBeCloseTo(LIEN_TOTAL, 2);

    // ... and the printed total footer matches.
    const all = XLSX.utils.sheet_to_json(wb.Sheets['Lien Calculation'], { header: 1, defval: '' });
    const totalRow = all.find((r) => String(r[0]).startsWith('Total lien-eligible'));
    expect(totalRow).toBeDefined();
    expect(num(totalRow[C.lienEligible])).toBeCloseTo(LIEN_TOTAL, 2);
  });

  test('the footnote states the exact formula including the disputed-inflow cap', () => {
    const all = XLSX.utils.sheet_to_json(wb.Sheets['Lien Calculation'], { header: 1, defval: '' });
    const text = all.map((r) => String(r[0])).join('\n');
    expect(text).toContain('Gross Balance = max(0, Received - Forwarded - On Hold - Cashed Out)');
    expect(text).toContain('min(Gross Balance, Disputed Inflow)');
  });
});
