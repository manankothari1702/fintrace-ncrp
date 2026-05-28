'use strict';

/**
 * Unit tests for backend/src/parsers/ncrpParser.js.
 *
 * Covers the public API (parseNcrpFile, detectColumnMapping, validateParsedData)
 * and the parsing-primitive internals exposed under `_internals`
 * (parseAmount, parseDate, parseLayer).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  parseNcrpFile,
  detectColumnMapping,
  validateParsedData,
  _internals,
} = require('../parsers/ncrpParser');

const HEADER_SYNONYMS = require('../config/header_synonyms.json');
const {
  buildStandardRows,
  STANDARD_HEADERS,
  ALTERNATE_HEADERS,
  writeTempXlsx,
} = require('./helpers/xlsx');

const { parseAmount, parseDate, parseLayer } = _internals;

// ─── parseNcrpFile ──────────────────────────────────────────────────────

describe('parseNcrpFile', () => {
  const tempFiles = [];

  afterAll(() => {
    for (const f of tempFiles) {
      try { fs.unlinkSync(f); } catch (_e) { /* best effort */ }
    }
  });

  test('parses a standard NCRP export with the expected row count', () => {
    const rows = buildStandardRows();
    const filePath = writeTempXlsx(rows);
    tempFiles.push(filePath);

    const { rows: parsed, columnMapping, warnings } = parseNcrpFile(filePath);

    // The fixture has 5 data rows after the header.
    expect(parsed).toHaveLength(5);
    expect(columnMapping.beneficiary_account).toBeDefined();
    expect(columnMapping.transaction_amount).toBeDefined();
    expect(warnings).toEqual(expect.any(Array));

    // Spot-check the first parsed row is canonical-shaped.
    expect(parsed[0]).toMatchObject({
      ack_no: 'NCRP202612345678',
      beneficiary_account: 'M0001',
      beneficiary_bank: 'ICICI Bank',
      transaction_amount: 100000,
      layer_no: 1,
    });
  });

  test('maps alternate / bank-specific column names to canonical fields', () => {
    const rows = [
      ALTERNATE_HEADERS,
      // One minimal row.
      [
        'ALT-1', '2024-02-01T00:00:00.000Z',
        'V99', 'BankA',
        'B99', 'BankB', 'Bene', 'BNKB0001234',
        '2024-02-02T00:00:00.000Z', 5000, 5000,
        'UTR-ALT', 'UPI', 1,
        null, null, 'Mumbai', 'Maharashtra', null,
      ],
    ];
    const filePath = writeTempXlsx(rows);
    tempFiles.push(filePath);

    const { rows: parsed, columnMapping } = parseNcrpFile(filePath);

    expect(parsed).toHaveLength(1);
    // Each alternate header should land at its canonical field index.
    expect(columnMapping.ack_no).toBe(0);                  // Complaint Number
    expect(columnMapping.beneficiary_account).toBe(4);     // Bene Account
    expect(columnMapping.transaction_amount).toBe(9);      // Txn Amount
    expect(columnMapping.ifsc_code).toBe(7);               // Bene IFSC
    expect(columnMapping.layer_no).toBe(13);               // Layer No
    expect(parsed[0].beneficiary_account).toBe('B99');
    expect(parsed[0].payment_mode).toBe('UPI');
  });

  test('defaults missing layer column to layer 1', () => {
    // Header row without a Layer column.
    const headersNoLayer = STANDARD_HEADERS.filter((h) => h !== 'Layer');
    const dataRow = [
      'NCRP-X', '2024-03-01T00:00:00.000Z',
      'V1', 'HDFC',
      'B1', 'ICICI', 'Bene', 'ICIC0009999',
      '2024-03-02T00:00:00.000Z', 1000, 1000,
      'UTR-X', 'IMPS',
      null, null, 'Pune', 'Maharashtra', null,
    ];
    const filePath = writeTempXlsx([headersNoLayer, dataRow]);
    tempFiles.push(filePath);

    const { rows: parsed, columnMapping } = parseNcrpFile(filePath);
    expect(columnMapping.layer_no).toBeUndefined();
    expect(parsed).toHaveLength(1);
    expect(parsed[0].layer_no).toBe(1);
  });
});

// ─── detectColumnMapping ────────────────────────────────────────────────

describe('detectColumnMapping', () => {
  test('returns the right canonical key for every documented synonym', () => {
    // Concatenate every synonym (including the canonical name itself) into one
    // big header row, then verify the mapping for each entry.
    const synonymList = [];
    for (const [canonical, synonyms] of Object.entries(HEADER_SYNONYMS)) {
      synonymList.push({ canonical, header: canonical });
      for (const syn of synonyms) {
        synonymList.push({ canonical, header: syn });
      }
    }

    // Verify each synonym one-at-a-time (avoids the "duplicate column" path
    // where two synonyms of the same canonical field would collide).
    for (const { canonical, header } of synonymList) {
      const { mapping } = detectColumnMapping([header]);
      expect(mapping[canonical]).toBe(0);
    }
  });

  test('flags unknown headers as unmapped', () => {
    const { mapping, unmapped } = detectColumnMapping([
      'Beneficiary A/C',
      'Wholly Made Up Field',
      'Transaction Amount',
    ]);
    expect(mapping.beneficiary_account).toBe(0);
    expect(mapping.transaction_amount).toBe(2);
    expect(unmapped).toEqual(['Wholly Made Up Field']);
  });
});

// ─── Amount parsing ─────────────────────────────────────────────────────

describe('parseAmount', () => {
  test('strips ₹ + Indian comma grouping ("₹1,23,456" → 123456)', () => {
    expect(parseAmount('₹1,23,456')).toBe(123456);
  });

  test('strips ₹ + decimals', () => {
    expect(parseAmount('₹1,23,456.78')).toBeCloseTo(123456.78, 2);
  });

  test('blank / null / "N/A" → 0', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount(null)).toBe(0);
    expect(parseAmount(undefined)).toBe(0);
    expect(parseAmount('N/A')).toBe(0);
    expect(parseAmount('-')).toBe(0);
  });

  test('honours parenthesised negatives', () => {
    expect(parseAmount('(50,000)')).toBe(-50000);
  });

  test('passes finite numbers through unchanged', () => {
    expect(parseAmount(12345.67)).toBeCloseTo(12345.67, 2);
    expect(parseAmount(0)).toBe(0);
  });

  test('Rs. / INR prefixes stripped', () => {
    expect(parseAmount('Rs. 1,000')).toBe(1000);
    expect(parseAmount('INR 2,500')).toBe(2500);
  });
});

// ─── Date parsing ───────────────────────────────────────────────────────

describe('parseDate', () => {
  test('"15/01/2024" (DD/MM/YYYY) → 2024-01-15', () => {
    const iso = parseDate('15/01/2024');
    expect(iso).not.toBeNull();
    expect(iso.startsWith('2024-01-15')).toBe(true);
  });

  test('Excel serial 45306 → 2024-01-15', () => {
    const iso = parseDate(45306);
    expect(iso).not.toBeNull();
    expect(iso.startsWith('2024-01-15')).toBe(true);
  });

  test('"2024-01-15" (ISO) → 2024-01-15', () => {
    const iso = parseDate('2024-01-15');
    expect(iso).not.toBeNull();
    expect(iso.startsWith('2024-01-15')).toBe(true);
  });

  test('blank/null → null', () => {
    expect(parseDate('')).toBeNull();
    expect(parseDate(null)).toBeNull();
    expect(parseDate('-')).toBeNull();
  });

  test('rejects clearly bogus strings', () => {
    expect(parseDate('not a date')).toBeNull();
  });
});

// ─── Layer parsing ──────────────────────────────────────────────────────

describe('parseLayer', () => {
  test('blank → default layer 1', () => {
    expect(parseLayer('')).toBe(1);
    expect(parseLayer(null)).toBe(1);
    expect(parseLayer(undefined)).toBe(1);
  });

  test('truncates floats and clamps to [0, 20]', () => {
    expect(parseLayer(2.7)).toBe(2);
    expect(parseLayer(-5)).toBe(0);
    expect(parseLayer(99)).toBe(20);
  });

  test('parses numeric strings', () => {
    expect(parseLayer('3')).toBe(3);
  });

  test('falls back to default on garbage input', () => {
    expect(parseLayer('abc')).toBe(1);
  });
});

// ─── Header detection edge cases ────────────────────────────────────────

describe('header detection edge cases', () => {
  const tmp = [];
  afterAll(() => {
    for (const f of tmp) {
      try { fs.unlinkSync(f); } catch (_e) { /* best effort */ }
    }
  });

  test('returns warning when no header row is detected', () => {
    // Three rows of unrelated garbage — never matches HEADER_DETECTION_MIN_MATCHES.
    const filePath = writeTempXlsx([
      ['random', 'noise'],
      ['nothing', 'recognised'],
      ['here', 'either'],
    ]);
    tmp.push(filePath);
    const { rows, warnings } = parseNcrpFile(filePath);
    expect(rows).toEqual([]);
    expect(warnings.some((w) => /header/i.test(w))).toBe(true);
  });

  test('skips rows with blank beneficiary_account (summary / total rows)', () => {
    const filePath = writeTempXlsx([
      STANDARD_HEADERS,
      // Real row
      [
        'NCRP-1', '2024-01-15',
        'V1', 'HDFC',
        'B1', 'ICICI', 'Bene', 'ICIC0001234',
        '2024-01-16', 1000, 1000,
        'UTR1', 'IMPS', 1,
        null, null, 'Mumbai', 'Maharashtra', null,
      ],
      // Summary row — no beneficiary account.
      [
        null, null, null, null, null, null, null, null, null, 5000, 5000,
        null, null, null, null, null, null, null, 'TOTAL',
      ],
    ]);
    tmp.push(filePath);
    const { rows, warnings } = parseNcrpFile(filePath);
    expect(rows).toHaveLength(1);
    expect(warnings.some((w) => /summary/i.test(w))).toBe(true);
  });
});

// ─── parseDate (more edge cases) ────────────────────────────────────────

describe('parseDate edge cases', () => {
  test('Date instance passes through to ISO', () => {
    const d = new Date('2024-06-15T00:00:00.000Z');
    const iso = parseDate(d);
    expect(iso).not.toBeNull();
    expect(iso.startsWith('2024-06-15')).toBe(true);
  });

  test('"31/02/2024" (invalid calendar day) → null', () => {
    expect(parseDate('31/02/2024')).toBeNull();
  });

  test('numeric string Excel serial ("45306") → 2024-01-15', () => {
    const iso = parseDate('45306');
    expect(iso).not.toBeNull();
    expect(iso.startsWith('2024-01-15')).toBe(true);
  });

  test('MM/DD/YYYY when middle component > 12', () => {
    // "05/31/2024" — 31 > 12 in middle position → MM/DD/YYYY.
    const iso = parseDate('05/31/2024');
    expect(iso).not.toBeNull();
    expect(iso.startsWith('2024-05-31')).toBe(true);
  });
});

// ─── parseAmount (more edge cases) ──────────────────────────────────────

describe('parseAmount edge cases', () => {
  test('NaN → 0', () => {
    expect(parseAmount(NaN)).toBe(0);
  });

  test('explicit leading-minus negative', () => {
    expect(parseAmount('-1,000')).toBe(-1000);
  });

  test('whitespace-only string → 0', () => {
    expect(parseAmount('   ')).toBe(0);
  });
});

// ─── validateParsedData ─────────────────────────────────────────────────

describe('validateParsedData', () => {
  test('valid data → { valid: true, errors: [] }', () => {
    const rows = [
      {
        beneficiary_account: 'B1',
        victim_account: 'V1',
        transaction_amount: 1000,
        layer_no: 1,
      },
    ];
    const result = validateParsedData(rows);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('no rows → { valid: false, errors: [...] }', () => {
    const result = validateParsedData([]);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/at least 1 row/i);
  });

  test('non-array input → invalid', () => {
    const result = validateParsedData(null);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/must be an array/i);
  });

  test('reports row-level errors for non-numeric amount / out-of-range layer', () => {
    const rows = [
      {
        beneficiary_account: 'B1',
        victim_account: 'V1',
        transaction_amount: 'not-a-number',
        layer_no: 999,
      },
    ];
    const result = validateParsedData(rows);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /transaction_amount/.test(e))).toBe(true);
    expect(result.errors.some((e) => /layer_no/.test(e))).toBe(true);
  });
});
