'use strict';

/**
 * Visual-dossier tests — the SVG→PNG chart rasteriser (utils/charts) and the
 * restructured PDF dossier (Visual Summary up front, bulky tables in an
 * Annexure at the back). Driven by the real CypherSOL gold case through the
 * actual parser + analyzer, so the charts reflect production data.
 *
 * These lock the highest-visibility quality jump for the proof pack:
 *   • the three charts (money-flow network, layer breakdown, daily timeline)
 *     build and rasterise to PNG, and are byte-identical for the same case
 *     (reproducible proof pack);
 *   • the dossier embeds the charts, leads with a Visual Summary, and relegates
 *     the data tables to a labelled Annexure — without dropping any of the lien
 *     letters or changing any financial figure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { parseNcrpFile } = require('../parsers/ncrpParser');
const { analyzeReport } = require('../analyzers/analyzer');
const { generateDraftEmails } = require('../utils/emailGenerator');
const { generateReportPdf } = require('../utils/pdfGenerator');
const charts = require('../utils/charts');
const { extractPdfText } = require('./helpers/pdfText');

const GOLD_PATH = path.join(__dirname, '..', '..', '..', '32712250107145 (1).xlsx');

// Gold-standard figures the layout change must not touch.
const HEADLINE_CASHOUT = 'Rs. 5,44,282.95';
const LIEN_TOTAL = 'Rs. 4,34,394.61';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let analysis;
let txnRows;
let liens;
let emails;
let chartSet;
let pdfBuf;
let pdfFlat;

beforeAll(async () => {
  expect(fs.existsSync(GOLD_PATH)).toBe(true);
  const parsed = parseNcrpFile(GOLD_PATH);
  expect(parsed.errors).toEqual([]);
  txnRows = parsed.rows.map((r, i) => ({ id: i + 1, ...r }));
  analysis = await analyzeReport(1, txnRows, []);
  liens = analysis.lien_calculation;
  emails = generateDraftEmails(0, liens, {
    ack_no: '32712250107145', complaint_date: null,
    total_disputed_amount: analysis.summary.total_disputed_amount,
  });

  chartSet = charts.renderCharts(analysis, txnRows);

  const pdfPath = path.join(os.tmpdir(), `ncrp-charts-test-${process.pid}.pdf`);
  await generateReportPdf({
    report: { id: 0, ack_no: '32712250107145' },
    analysis, liens, emails, layers: analysis.layer_analysis, transactions: txnRows,
    ack_no: '32712250107145',
  }, pdfPath);
  pdfBuf = fs.readFileSync(pdfPath);
  pdfFlat = extractPdfText(pdfBuf).replace(/\s+/g, ' ');
  fs.unlinkSync(pdfPath);
}, 60000);

// ─── Chart builders (SVG) ───────────────────────────────────────────────────
describe('SVG chart builders', () => {
  const { buildNetworkSvg, buildLayerSvg, buildTimelineSvg } = charts._internals;

  test('money-flow network SVG is built from the trail edges', () => {
    const svg = buildNetworkSvg(analysis.money_flow_network || {});
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('Money-Flow Network');
    // Hierarchical layer columns + role legend present.
    expect(svg).toContain('Victim');
    expect(svg).toContain('Layer 1');
    expect(svg).toContain('Exit / cash-out');
    // One bezier edge per top edge, each carrying an amount label.
    const edgeCount = (analysis.money_flow_network.top_edges || []).length;
    expect(edgeCount).toBeGreaterThan(0);
    expect((svg.match(/<path /g) || []).length).toBeGreaterThanOrEqual(edgeCount);
  });

  test('layer-breakdown SVG has one bar per analysed layer', () => {
    const svg = buildLayerSvg(analysis.layer_analysis);
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('Layer Breakdown');
    // A bar label "L1".."Ln" per layer row.
    for (const l of analysis.layer_analysis) {
      expect(svg).toContain(`>L${l.layer_no}<`);
    }
  });

  test('timeline SVG highlights same-day cash-out days', () => {
    const svg = buildTimelineSvg(analysis.timeline, txnRows);
    expect(svg).toMatch(/^<svg/);
    expect(svg).toContain('Daily Volume Timeline');
    // The cash-out overlay finds >0 days from the ledger (gold case has them).
    const cashoutByDay = charts._internals.dailyCashoutByDay(txnRows);
    expect(cashoutByDay.size).toBeGreaterThan(0);
    expect(svg).toContain('Same-day cash-out');
  });

  test('builders return null for empty inputs (graceful, no throw)', () => {
    expect(buildNetworkSvg({ top_edges: [] })).toBeNull();
    expect(buildLayerSvg([])).toBeNull();
    expect(buildTimelineSvg([], [])).toBeNull();
  });
});

// ─── Rasterisation + determinism ─────────────────────────────────────────────
describe('SVG→PNG rasterisation', () => {
  test('all three charts rasterise to non-trivial PNG buffers', () => {
    expect(chartSet.available).toBe(true);
    for (const key of ['network', 'layers', 'timeline']) {
      expect(chartSet[key]).not.toBeNull();
      expect(Buffer.isBuffer(chartSet[key].png)).toBe(true);
      expect(chartSet[key].png.length).toBeGreaterThan(1000);
      // PNG magic number.
      expect(chartSet[key].png.slice(0, 4).toString('hex')).toBe('89504e47');
      expect(chartSet[key].w).toBeGreaterThan(0);
      expect(chartSet[key].h).toBeGreaterThan(0);
    }
  });

  test('same case -> byte-identical charts (reproducible proof pack)', () => {
    const again = charts.renderCharts(analysis, txnRows);
    for (const key of ['network', 'layers', 'timeline']) {
      expect(sha(again[key].png)).toBe(sha(chartSet[key].png));
    }
  });
});

// ─── Restructured dossier ─────────────────────────────────────────────────────
describe('PDF dossier — visual section + annexure', () => {
  test('leads with a Visual Summary and embeds the chart images', () => {
    expect(pdfFlat).toContain('1. Executive Summary');
    expect(pdfFlat).toContain('2. Visual Summary');
    expect(pdfFlat).toContain('Money-flow network');
    // Embedded raster images (PNG XObjects) are present in the PDF.
    const raw = pdfBuf.toString('latin1');
    expect(raw).toContain('/Image');
    expect(raw).toContain('/XObject');
  });

  test('bulky tables are relegated to a labelled Annexure (A–H)', () => {
    expect(pdfFlat).toContain('ANNEXURE');
    expect(pdfFlat).toContain('Supporting Data Tables');
    for (const ann of ['Annexure A', 'Annexure B', 'Annexure C', 'Annexure D',
      'Annexure E', 'Annexure F', 'Annexure G', 'Annexure H']) {
      expect(pdfFlat).toContain(ann);
    }
  });

  test('all lien letters are retained, unchanged in count', () => {
    expect(emails.length).toBeGreaterThan(0);
    const letters = pdfFlat.match(/Letter \d+ of \d+/g) || [];
    expect(letters.length).toBe(emails.length);
    expect(pdfFlat).toContain(`Letter 1 of ${emails.length}`);
    expect(pdfFlat).toContain(`Letter ${emails.length} of ${emails.length}`);
  });

  test('financial figures and the reconciliation are unchanged', () => {
    expect(pdfFlat).toContain(HEADLINE_CASHOUT);
    expect(pdfFlat).toContain(LIEN_TOTAL);
    expect(pdfFlat).toContain('gross - duplicates - cap = confirmed');
    expect(pdfFlat).toContain('Top merchants (POS cashouts');
  });

  test('reviewer notes point at the data-quality annexure (Annexure H)', () => {
    expect(pdfFlat).toContain('See Annexure H');
    expect(pdfFlat).not.toContain('See section 12');
  });
});

// ─── Graceful degradation ─────────────────────────────────────────────────────
describe('graceful degradation', () => {
  test('dossier still generates when there is no chartable data (no throw)', async () => {
    // Empty analysis bundle -> every chart builder returns null, so each chart
    // slot falls back to its annexure pointer instead of throwing.
    const p = path.join(os.tmpdir(), `ncrp-charts-empty-${process.pid}.pdf`);
    await generateReportPdf({
      report: { id: 0, ack_no: 'EMPTY' }, analysis: {}, liens: [], emails: [],
      layers: [], transactions: [], ack_no: 'EMPTY',
    }, p);
    const txt = extractPdfText(fs.readFileSync(p)).replace(/\s+/g, ' ');
    fs.unlinkSync(p);
    expect(txt).toContain('2. Visual Summary');
    expect(txt).toContain('chart unavailable; see the Annexure tables for the data');
    // The dossier still completes through to the letters section.
    expect(txt).toContain('Draft Lien-Request Emails');
  }, 30000);
});
