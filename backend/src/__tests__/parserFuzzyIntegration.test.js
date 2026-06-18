'use strict';

/**
 * Integration tests for the self-healing fuzzy tier wired into ncrpParser.
 *
 * These exercise the FULL parser (real .xlsx via SheetJS), not the resolver in
 * isolation, and pin the court-facing contract end-to-end:
 *   • a clean, exactly-named file produces ZERO parse warnings (the fuzzy path
 *     never runs — behaviour is byte-identical to before this feature);
 *   • a high-confidence typo in a sheet name / required column is rescued AND
 *     logged in parseWarnings (never silently accepted);
 *   • a below-threshold required column still FAILS LOUD (structured ParseError),
 *     never a silent bad parse or a crash;
 *   • informational column gaps (IFSC on a transfer sheet, transaction date)
 *     degrade gracefully with a warning;
 *   • SMOKE: a fuzzy-resolved file yields byte-identical canonical rows to the
 *     exact-match run.
 */

process.env.NODE_ENV = 'test';

const fs = require('fs');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');
const request = require('supertest');

const { parseNcrpFile } = require('../parsers/ncrpParser');
const { initializeDatabase } = require('../db/schema');
const { createApp } = require('../server');

// ─── Fixture helpers ─────────────────────────────────────────────────

const tempFiles = [];
afterAll(() => {
  for (const f of tempFiles) {
    try { fs.unlinkSync(f); } catch (_e) { /* best effort */ }
  }
});

function writeWorkbook(sheetDefs) {
  const wb = XLSX.utils.book_new();
  for (const def of sheetDefs) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(def.rows), def.name);
  }
  const p = path.join(
    os.tmpdir(),
    `ncrp-fuzzy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`
  );
  XLSX.writeFile(wb, p);
  tempFiles.push(p);
  return p;
}

// A transfer sheet with the canonical (exact) header spellings, used as the
// byte-identical baseline. `headerOverrides` swaps specific headers for typos.
const TRANSFER_HEADERS = [
  'Acknowledgement No', 'Account No./ (Wallet /PG/PA) Id', 'Bank/FIs', 'Layer',
  'Account No', 'Action Taken By bank', 'IFSC Code', 'Transaction Date',
  'Transaction Amount', 'Disputed Amount', 'UTR/Reference No', 'Remarks',
];
const TRANSFER_ROW = [
  'ACK1', 'V0001', 'HDFC Bank', 1,
  'MULE1', 'ICICI Bank', 'ICIC0001234', '2024-01-15 10:00:00',
  100000, 100000, 'UTR1', 'IMPS',
];

function transferSheet(name = 'Money Transfer to', headers = TRANSFER_HEADERS) {
  return { name, rows: [headers, TRANSFER_ROW] };
}

// Strip volatile keys so two parse runs can be compared for byte-identity.
const stripVolatile = (rows) => rows.map((r) => ({ ...r }));

// ─── 1. Clean file → no fuzzy path, no parse warnings ────────────────

describe('exact-named file is byte-identical (fuzzy never fires)', () => {
  test('zero parseWarnings and one canonical row', () => {
    const parsed = parseNcrpFile(writeWorkbook([transferSheet()]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.parseWarnings).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].transaction_amount).toBe(100000);
    expect(parsed.rows[0].disputed_amount).toBe(100000);
    expect(parsed.rows[0].beneficiary_account).toBe('MULE1');
  });
});

// ─── 2. High-confidence fuzzy → rescued + logged ─────────────────────

describe('high-confidence typos are rescued and logged', () => {
  test('typo in required column headers → mapped, parsed, and recorded', () => {
    const headers = [...TRANSFER_HEADERS];
    headers[1] = 'Acount No./(Wallet/PG/PA) Id';  // victim_account typo
    headers[8] = 'Transcation Amount';             // transaction_amount transposition
    headers[9] = 'Disputd Amount';                 // disputed_amount dropped char
    const parsed = parseNcrpFile(writeWorkbook([transferSheet('Money Transfer to', headers)]));

    // Required columns rescued → no fail-loud error, figures correct.
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].transaction_amount).toBe(100000);
    expect(parsed.rows[0].disputed_amount).toBe(100000);

    const cols = parsed.parseWarnings.filter((w) => w.code === 'FUZZY_COLUMN_MATCH');
    expect(cols.map((w) => w.matchedTo).sort())
      .toEqual(['disputed_amount', 'transaction_amount', 'victim_account']);
    for (const w of cols) {
      expect(w.confidence).toBeGreaterThanOrEqual(0.85);
      expect(w.severity).toBe('warn');
      expect(w.sheet).toBe('Money Transfer to');
      expect(typeof w.message).toBe('string');
    }
  });

  test('typo in the sheet NAME → resolved to the right channel + logged', () => {
    const parsed = parseNcrpFile(writeWorkbook([transferSheet('Money Transfor to')]));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    const sheetW = parsed.parseWarnings.find((w) => w.code === 'FUZZY_SHEET_MATCH');
    expect(sheetW).toBeDefined();
    expect(sheetW.matchedTo).toBe('TRANSFER');
    expect(sheetW.confidence).toBeGreaterThanOrEqual(0.85);
  });
});

// ─── 3. Below-threshold required column → FAIL LOUD ──────────────────

describe('below-threshold required column fails loud, never silently', () => {
  test('an unrelated header for the amount column → REQUIRED_COLUMN_MISSING, zero rows', () => {
    const headers = [...TRANSFER_HEADERS];
    headers[8] = 'Quantum of Funds Moved';  // not similar to any amount synonym
    const parsed = parseNcrpFile(writeWorkbook([transferSheet('Money Transfer to', headers)]));

    expect(parsed.rows).toHaveLength(0);
    const err = parsed.errors.find((e) => e.code === 'REQUIRED_COLUMN_MISSING');
    expect(err).toBeDefined();
    expect(err.expectedColumn).toBe('Transaction Amount');
    // No fuzzy match should have been recorded for the amount column.
    expect(parsed.parseWarnings.some(
      (w) => w.code === 'FUZZY_COLUMN_MATCH' && w.matchedTo === 'transaction_amount')).toBe(false);
  });

  test('does not throw — returns a structured result', () => {
    const headers = [...TRANSFER_HEADERS];
    headers[8] = 'Quantum of Funds Moved';
    expect(() => parseNcrpFile(writeWorkbook([transferSheet('Money Transfer to', headers)])))
      .not.toThrow();
  });
});

// ─── 4. Informational column gaps degrade gracefully (with warning) ──

describe('informational column gaps are surfaced, not silent', () => {
  test('missing IFSC on a transfer sheet → INFORMATIONAL_COLUMN_MISSING warning, still parses', () => {
    const headers = TRANSFER_HEADERS.filter((h) => h !== 'IFSC Code');
    const row = TRANSFER_ROW.filter((_, i) => i !== 6); // drop IFSC cell
    const parsed = parseNcrpFile(writeWorkbook([{ name: 'Money Transfer to', rows: [headers, row] }]));

    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(1);
    const w = parsed.parseWarnings.find(
      (x) => x.code === 'INFORMATIONAL_COLUMN_MISSING' && x.matchedTo === 'ifsc_code');
    expect(w).toBeDefined();
    expect(w.confidence).toBeUndefined();   // not a similarity match
  });

  test('missing transaction date → INFORMATIONAL_COLUMN_MISSING warning', () => {
    const headers = TRANSFER_HEADERS.filter((h) => h !== 'Transaction Date');
    const row = TRANSFER_ROW.filter((_, i) => i !== 7);
    const parsed = parseNcrpFile(writeWorkbook([{ name: 'Money Transfer to', rows: [headers, row] }]));

    expect(parsed.errors).toEqual([]);
    expect(parsed.parseWarnings.some(
      (w) => w.code === 'INFORMATIONAL_COLUMN_MISSING' && w.matchedTo === 'transaction_date')).toBe(true);
  });
});

// ─── 5. SMOKE — fuzzy run produces byte-identical canonical rows ─────

describe('SMOKE: fuzzy-resolved file matches the exact-match output exactly', () => {
  test('typo sheet name + typo column headers → identical rows, but flagged', () => {
    // Baseline: exact names.
    const baseline = parseNcrpFile(writeWorkbook([transferSheet()]));

    // Variant: misspelled sheet name + capitalisation/typo column headers that
    // can only resolve via the fuzzy tier.
    const headers = [...TRANSFER_HEADERS];
    headers[1] = 'Acount No./(Wallet/PG/PA) Id';
    headers[8] = 'Transcation Amount';
    headers[9] = 'Disputd Amount';
    const variant = parseNcrpFile(writeWorkbook([transferSheet('Money Transfor to', headers)]));

    // Output rows are byte-identical to the clean run …
    expect(stripVolatile(variant.rows)).toEqual(stripVolatile(baseline.rows));

    // … and the baseline carried no warnings while the variant flagged each heal.
    expect(baseline.parseWarnings).toEqual([]);
    expect(variant.parseWarnings.length).toBeGreaterThanOrEqual(4); // 1 sheet + 3 columns
    expect(variant.parseWarnings.some((w) => w.code === 'FUZZY_SHEET_MATCH')).toBe(true);
    expect(variant.parseWarnings.filter((w) => w.code === 'FUZZY_COLUMN_MATCH')).toHaveLength(3);
  });
});

// ─── 6. Route round-trip — persisted + folded into the analysis snapshot ─

describe('upload route persists parseWarnings into the analysis snapshot', () => {
  let db;
  let agent;

  beforeAll(() => {
    db = initializeDatabase(':memory:');
    agent = request(createApp(db));
  });
  afterAll(() => {
    try { db.close(); } catch (_e) { /* best effort */ }
  });

  async function waitForAnalysis(reportId, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const res = await agent.get(`/api/ncrp/${reportId}`);
      if (res.status === 200) {
        const status = res.body && res.body.analysis_status;
        if (status === 'complete' || status === 'error') return res.body;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`analysis did not complete for report ${reportId}`);
  }

  test('202 response surfaces the fuzzy warnings AND they land in analysis_json', async () => {
    const headers = [...TRANSFER_HEADERS];
    headers[8] = 'Transcation Amount';
    headers[9] = 'Disputd Amount';
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb, XLSX.utils.aoa_to_sheet([headers, TRANSFER_ROW]), 'Money Transfor to');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const res = await agent.post('/api/ncrp/upload').attach('ncrpFile', buf, 'typo.xlsx');
    expect(res.status).toBe(202);
    // The upload banner carries the structured fuzzy warnings immediately.
    const codes = res.body.warnings.filter((w) => w && typeof w === 'object').map((w) => w.code);
    expect(codes).toContain('FUZZY_SHEET_MATCH');
    expect(codes).toContain('FUZZY_COLUMN_MATCH');

    // After analysis, the snapshot carries them for the Data Quality panel.
    const report = await waitForAnalysis(res.body.reportId);
    expect(report.analysis_status).toBe('complete');
    const pw = report.analysis_json.parse_warnings;
    expect(Array.isArray(pw)).toBe(true);
    expect(pw.some((w) => w.code === 'FUZZY_SHEET_MATCH')).toBe(true);
    expect(pw.filter((w) => w.code === 'FUZZY_COLUMN_MATCH').length).toBeGreaterThanOrEqual(2);

    // And the data-quality endpoint (bank attribution) is unaffected — still an array.
    const dq = await agent.get(`/api/ncrp/${res.body.reportId}/data-quality`);
    expect(dq.status).toBe(200);
    expect(Array.isArray(dq.body)).toBe(true);
  });
});
