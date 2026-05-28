'use strict';

/**
 * FinTrace NCRP — BankAction CompleteTrail parser.
 *
 * Reads an NCRP portal export (.xlsx / .xls), auto-detects which columns
 * are present (NCRP exports vary across portal versions and bank suffixes),
 * normalises every cell to the canonical schema used by the
 * `ncrp_transactions` table, and reports back any structural issues for
 * surfacing in the UI.
 *
 * Parser is intentionally narrow: it produces canonical rows, nothing more.
 * Analyzer-derived fields (`same_day_cashout`, `cashout_mode`) are emitted
 * with neutral defaults (0 / null) so the persister can insert without
 * additional shaping.
 *
 * @module backend/src/parsers/ncrpParser
 */

const fs = require('fs');
const XLSX = require('xlsx');

const HEADER_SYNONYMS = require('../config/header_synonyms.json');

// ─── Constants ───────────────────────────────────────────────────────

/** Number of leading rows scanned for the header row. */
const HEADER_SCAN_DEPTH = 5;

/**
 * Minimum canonical-column matches a row must contain to be accepted as the
 * header row. Three is small enough to handle bank-specific exports that
 * omit several columns, large enough to reject title/metadata rows that
 * happen to contain one stray keyword.
 */
const HEADER_DETECTION_MIN_MATCHES = 3;

/** Layer-number bounds and default for missing/blank cells. */
const LAYER_MIN = 0;
const LAYER_MAX = 20;
const LAYER_DEFAULT = 1;

/** Cap on per-row validation errors so a broken file doesn't OOM the caller. */
const MAX_VALIDATION_ERRORS = 100;

/** Days between 1900-01-01 (Excel epoch w/ leap-bug) and 1970-01-01 (UNIX epoch). */
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const MS_PER_DAY = 86400 * 1000;

/**
 * Canonical schema fields produced for every parsed row. Order matches the
 * spec exactly so consumers can rely on object-key iteration order.
 *
 * @type {ReadonlyArray<string>}
 */
const CANONICAL_FIELDS = Object.freeze([
  'ack_no', 'complaint_date',
  'victim_account', 'victim_bank',
  'beneficiary_account', 'beneficiary_bank', 'beneficiary_name', 'ifsc_code',
  'transaction_date', 'transaction_amount', 'disputed_amount', 'utr_no',
  'payment_mode', 'layer_no',
  'atm_id', 'atm_location', 'city', 'state', 'remarks',
]);

/**
 * Inverse synonym map: normalised-header-string → canonical-field-name.
 * Built once at module load. The canonical name itself is also registered
 * so a header that already uses the canonical form matches without needing
 * to be listed as a synonym of itself.
 *
 * @type {ReadonlyMap<string, string>}
 */
const SYNONYM_TO_CANONICAL = (() => {
  const map = new Map();
  for (const [canonical, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    map.set(normalizeHeader(canonical), canonical);
    for (const syn of synonyms) {
      map.set(normalizeHeader(syn), canonical);
    }
  }
  return map;
})();

// ─── String / cell utilities ─────────────────────────────────────────

/**
 * Strip the UTF-8 byte-order mark, if present, from the start of a string.
 * Some NCRP exports prefix the first header with a BOM, which would
 * otherwise prevent the synonym lookup from matching.
 *
 * @param {string} str
 * @returns {string}
 */
function stripBOM(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

/**
 * Normalise a header cell for synonym matching: strip BOM, lowercase, trim,
 * collapse internal whitespace. Punctuation (slashes, dots) is preserved
 * because synonyms like "Beneficiary A/C" and "UTR/Reference No" rely on it.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHeader(value) {
  if (value === null || value === undefined) return '';
  let s = String(value);
  s = stripBOM(s);
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

/**
 * Treat the value as "no data". Covers SheetJS's null/undefined sentinels,
 * empty strings, whitespace-only strings, NaN, and the common placeholder
 * tokens NCRP operators paste in for missing values.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isBlank(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'number') return Number.isNaN(value);
  if (typeof value === 'string') {
    const t = stripBOM(value).trim();
    if (t === '' || t === '-' || t === '—') return true;
    return t.toLowerCase() === 'n/a';
  }
  return false;
}

/**
 * Trim a value to a non-empty string, or null if blank.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function trimOrNull(value) {
  if (isBlank(value)) return null;
  return stripBOM(String(value)).trim();
}

// ─── Amount parsing ──────────────────────────────────────────────────

/**
 * Parse an amount cell to a finite number.
 *
 * Handles all NCRP / Indian formatting variants observed in production:
 *   • ₹ symbol, "INR" / "Rs." prefixes (case-insensitive)
 *   • Indian lakh-comma grouping ("1,23,456.78") AND western grouping
 *   • Parenthesised negatives ("(50,000)" → -50000)
 *   • Blank / "-" / "N/A" → 0
 *
 * Returns 0 (not NaN) for unparseable values so downstream sum/aggregation
 * code never has to defensively check for NaN. Validation surfaces the
 * "must be numeric" rule separately if callers need strictness.
 *
 * @param {unknown} value
 * @returns {number}
 */
function parseAmount(value) {
  if (isBlank(value)) return 0;
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;

  let s = stripBOM(String(value)).trim();

  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  } else if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }

  s = s.replace(/₹/g, '');
  s = s.replace(/(?:INR\b|Rs\.?\s*)/gi, '');
  s = s.replace(/,/g, '');
  s = s.replace(/\s+/g, '');

  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

// ─── Date parsing ────────────────────────────────────────────────────

/**
 * Convert an Excel serial-date number to an ISO 8601 UTC string.
 * Assumes the post-1900-03-01 calendar (Excel's leap-year bug only affects
 * dates in January / February 1900, which NCRP data will never contain).
 *
 * @param {number} serial
 * @returns {string|null} ISO 8601 string or null if `serial` produces an invalid Date.
 */
function excelSerialToIso(serial) {
  if (!Number.isFinite(serial)) return null;
  const d = new Date((serial - EXCEL_EPOCH_OFFSET_DAYS) * MS_PER_DAY);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Build an ISO 8601 UTC string from a (year, month, day) triple. Returns
 * null if the components don't form a valid calendar date (e.g. 31 Feb).
 *
 * @param {number} year
 * @param {number} month  1-12
 * @param {number} day    1-31
 * @returns {string|null}
 */
function isoFromYMD(year, month, day) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(d.getTime())) return null;
  // Reject silent rollover (e.g. Date.UTC(2024, 1, 31) → 2024-03-02).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString();
}

/**
 * Parse a date cell to an ISO 8601 UTC string.
 *
 * Accepted forms:
 *   • Excel serial number (45306 → 2024-01-15) — both numeric and string-encoded
 *   • Native `Date` instances (SheetJS returns these when `cellDates: true`)
 *   • DD/MM/YYYY (Indian convention — default for ambiguous d/m ≤ 12)
 *   • DD-MM-YYYY, DD.MM.YYYY
 *   • MM/DD/YYYY — detected when middle component is > 12
 *   • YYYY-MM-DD / YYYY/MM/DD (ISO-ish, detected when first component is 4 digits)
 *
 * Returns null for blank or unparseable input.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function parseDate(value) {
  if (isBlank(value)) return null;

  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }

  if (typeof value === 'number') {
    return excelSerialToIso(value);
  }

  const raw = stripBOM(String(value)).trim();
  if (raw === '') return null;

  // String-encoded Excel serial (e.g. exporter wrote "45306" as text).
  // Restrict to the plausible NCRP era (≈ 1980-2099) to avoid swallowing
  // a numeric account number that happens to be 5 digits.
  if (/^\d{4,6}(?:\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (n >= 29221 && n <= 73050) {
      return excelSerialToIso(n);
    }
  }

  // Strip any trailing time portion ("15/01/2024 10:30:00" → "15/01/2024").
  const datePart = raw.split(/[T\s]/)[0];
  const parts = datePart.split(/[\/\-.]/).map((p) => p.trim());
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    const [pa, pb, pc] = parts;
    const a = Number(pa), b = Number(pb), c = Number(pc);

    if (pa.length === 4) {
      // YYYY-MM-DD
      return isoFromYMD(a, b, c);
    }
    if (pc.length === 4 || c > 1900) {
      // Last component is the year.
      if (a > 12 && b <= 12) return isoFromYMD(c, b, a);   // unambiguous DD/MM
      if (b > 12 && a <= 12) return isoFromYMD(c, a, b);   // unambiguous MM/DD
      // Ambiguous: default to DD/MM (Indian convention).
      return isoFromYMD(c, b, a);
    }
  }

  // Last resort — let the JS Date parser try. Only accept if it produced
  // a finite result; reject ambiguous parses by sanity-checking the year.
  const fallback = new Date(raw);
  if (Number.isFinite(fallback.getTime()) && fallback.getUTCFullYear() > 1900) {
    return fallback.toISOString();
  }
  return null;
}

// ─── Layer parsing ───────────────────────────────────────────────────

/**
 * Parse a layer-number cell.
 *
 * Behaviour matches the spec exactly:
 *   • Blank cell  → LAYER_DEFAULT (1)
 *   • Missing col → LAYER_DEFAULT (1) — caller passes `null` here
 *   • Otherwise   → integer clamped into [LAYER_MIN, LAYER_MAX]
 *   • Unparseable → LAYER_DEFAULT (1)
 *
 * @param {unknown} value
 * @returns {number}
 */
function parseLayer(value) {
  if (isBlank(value)) return LAYER_DEFAULT;
  let n;
  if (typeof value === 'number') {
    n = Math.trunc(value);
  } else {
    n = parseInt(stripBOM(String(value)).trim(), 10);
  }
  if (!Number.isFinite(n)) return LAYER_DEFAULT;
  if (n < LAYER_MIN) return LAYER_MIN;
  if (n > LAYER_MAX) return LAYER_MAX;
  return n;
}

// ─── Header detection ────────────────────────────────────────────────

/**
 * Map a row of header cells to canonical schema fields.
 *
 * Matches are case-insensitive and whitespace-tolerant. If two cells in the
 * same row both map to the same canonical field, the first wins and the
 * second is reported as `unmapped` — NCRP data has no legitimate duplicate
 * columns, so the second is almost always a data-entry error.
 *
 * @param {ReadonlyArray<unknown>} headers - One row of the worksheet.
 * @returns {{ mapping: Record<string, number>, unmapped: string[] }}
 *   `mapping[canonical]` is the zero-based column index of that field.
 *   `unmapped` lists header strings that could not be assigned to a canonical
 *   field (unknown headers OR duplicates of an already-mapped field).
 */
function detectColumnMapping(headers) {
  const mapping = {};
  const unmapped = [];
  if (!Array.isArray(headers)) {
    return { mapping, unmapped };
  }
  for (let i = 0; i < headers.length; i++) {
    const cell = headers[i];
    const normalized = normalizeHeader(cell);
    if (normalized === '') continue;
    const canonical = SYNONYM_TO_CANONICAL.get(normalized);
    if (canonical) {
      if (mapping[canonical] === undefined) {
        mapping[canonical] = i;
      } else {
        unmapped.push(String(cell));
      }
    } else {
      unmapped.push(String(cell));
    }
  }
  return { mapping, unmapped };
}

/**
 * Scan the first `HEADER_SCAN_DEPTH` rows of the worksheet and pick the one
 * with the most canonical-column matches. Returns null if no row clears the
 * `HEADER_DETECTION_MIN_MATCHES` threshold — typically signals the file
 * isn't a BankAction CompleteTrail export at all.
 *
 * @param {ReadonlyArray<ReadonlyArray<unknown>>} rows
 * @returns {{ row: number, matches: number, headers: ReadonlyArray<unknown> }|null}
 */
function findHeaderRow(rows) {
  let best = null;
  const limit = Math.min(HEADER_SCAN_DEPTH, rows.length);
  for (let i = 0; i < limit; i++) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    const { mapping } = detectColumnMapping(row);
    const matches = Object.keys(mapping).length;
    if (best === null || matches > best.matches) {
      best = { row: i, matches, headers: row };
    }
  }
  if (best === null || best.matches < HEADER_DETECTION_MIN_MATCHES) {
    return null;
  }
  return best;
}

// ─── Main entry point ────────────────────────────────────────────────

/**
 * Parse an NCRP BankAction CompleteTrail export.
 *
 * Always opens the first sheet (index 0) — NCRP exports place data on
 * "Sheet1" / "BankAction" / "Trail" depending on portal version, but the
 * first sheet is always the data sheet.
 *
 * Rows are skipped (silently) when `beneficiary_account` is blank, which is
 * the spec's signal for summary / total rows that NCRP appends to the
 * bottom of some exports. A skip count is included in `warnings` if any
 * rows were dropped, so the UI can show "parsed N of M rows" when relevant.
 *
 * Throws on filesystem / SheetJS errors; returns a normal result with
 * `warnings` set when the file is structurally valid but the header row
 * cannot be located.
 *
 * @param {string} filePath - Absolute or relative path to .xlsx / .xls file.
 * @returns {{
 *   rows: Array<Object>,
 *   columnMapping: Record<string, number>,
 *   warnings: string[]
 * }}
 *
 * @example
 *   const { parseNcrpFile } = require('./parsers/ncrpParser');
 *   const { rows, columnMapping, warnings } = parseNcrpFile('upload.xlsx');
 *   //   rows[0].beneficiary_account  → "1234567890"
 *   //   rows[0].layer_no             → 1
 *   //   rows[0].transaction_amount   → 50000
 */
function parseNcrpFile(filePath) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new TypeError('parseNcrpFile: filePath must be a non-empty string');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`parseNcrpFile: file not found at ${filePath}`);
  }

  /** @type {XLSX.WorkBook} */
  let workbook;
  try {
    workbook = XLSX.readFile(filePath, { cellDates: false, raw: true });
  } catch (err) {
    throw new Error(`parseNcrpFile: failed to read workbook (${err.message})`);
  }

  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) {
    throw new Error('parseNcrpFile: workbook contains no sheets');
  }

  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  });

  const warnings = [];

  if (aoa.length === 0) {
    return { rows: [], columnMapping: {}, warnings: ['File contains no data'] };
  }

  const headerInfo = findHeaderRow(aoa);
  if (headerInfo === null) {
    return {
      rows: [],
      columnMapping: {},
      warnings: [
        `Could not detect a header row within the first ${HEADER_SCAN_DEPTH} rows`,
      ],
    };
  }

  const { mapping, unmapped } = detectColumnMapping(headerInfo.headers);
  if (unmapped.length > 0) {
    warnings.push(`Unrecognized columns ignored: ${unmapped.join(', ')}`);
  }

  // ── Row materialisation ──────────────────────────────────────────
  const rows = [];
  let skippedSummaryRows = 0;
  let rowsMissingCritical = 0;

  const getter = (row) => (canonical) => {
    const idx = mapping[canonical];
    if (idx === undefined || idx >= row.length) return null;
    return row[idx];
  };

  for (let i = headerInfo.row + 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (!Array.isArray(row) || row.every(isBlank)) continue;

    const get = getter(row);

    const beneficiary_account = trimOrNull(get('beneficiary_account'));
    const victim_account      = trimOrNull(get('victim_account'));

    // Summary / total rows have no beneficiary account → drop silently.
    if (beneficiary_account === null) {
      skippedSummaryRows++;
      continue;
    }
    if (victim_account === null) {
      rowsMissingCritical++;
    }

    rows.push({
      ack_no:              trimOrNull(get('ack_no')),
      complaint_date:      parseDate(get('complaint_date')),
      victim_account,
      victim_bank:         trimOrNull(get('victim_bank')),
      beneficiary_account,
      beneficiary_bank:    trimOrNull(get('beneficiary_bank')),
      beneficiary_name:    trimOrNull(get('beneficiary_name')),
      ifsc_code:           trimOrNull(get('ifsc_code')),
      transaction_date:    parseDate(get('transaction_date')),
      transaction_amount:  parseAmount(get('transaction_amount')),
      disputed_amount:     parseAmount(get('disputed_amount')),
      utr_no:              trimOrNull(get('utr_no')),
      payment_mode:        trimOrNull(get('payment_mode')),
      layer_no:            parseLayer(get('layer_no')),
      atm_id:              trimOrNull(get('atm_id')),
      atm_location:        trimOrNull(get('atm_location')),
      city:                trimOrNull(get('city')),
      state:               trimOrNull(get('state')),
      remarks:             trimOrNull(get('remarks')),
      same_day_cashout:    0,
      cashout_mode:        null,
    });
  }

  if (skippedSummaryRows > 0) {
    warnings.push(
      `Skipped ${skippedSummaryRows} row(s) with blank beneficiary account (likely summary rows)`
    );
  }
  if (rowsMissingCritical > 0) {
    warnings.push(
      `${rowsMissingCritical} row(s) have a beneficiary account but no victim account`
    );
  }

  // Duplicate detection: same UTR + same beneficiary account.
  const seen = new Set();
  let duplicateCount = 0;
  for (const r of rows) {
    if (!r.utr_no || !r.beneficiary_account) continue;
    const key = `${r.utr_no} ${r.beneficiary_account}`;
    if (seen.has(key)) duplicateCount++;
    else seen.add(key);
  }
  if (duplicateCount > 0) {
    warnings.push(
      `${duplicateCount} duplicate row(s) detected (same UTR + beneficiary account)`
    );
  }

  return { rows, columnMapping: mapping, warnings };
}

// ─── Validation ──────────────────────────────────────────────────────

/**
 * Sanity-check a set of parsed rows against the schema invariants.
 *
 * Designed to be cheap to run repeatedly: stops accumulating errors after
 * `MAX_VALIDATION_ERRORS` so a broken file with thousands of malformed
 * rows can't blow up the caller. The `valid` flag is still accurate even
 * when the error list is truncated.
 *
 * @param {ReadonlyArray<Object>} rows
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateParsedData(rows) {
  const errors = [];
  if (!Array.isArray(rows)) {
    return { valid: false, errors: ['rows must be an array'] };
  }
  if (rows.length === 0) {
    return { valid: false, errors: ['At least 1 row must be parsed'] };
  }

  let truncated = false;
  const push = (msg) => {
    if (errors.length < MAX_VALIDATION_ERRORS) errors.push(msg);
    else truncated = true;
  };

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const label = `Row ${i + 1}`;

    if (typeof r.transaction_amount !== 'number' || !Number.isFinite(r.transaction_amount)) {
      push(`${label}: transaction_amount must be a finite number`);
    }
    if (!Number.isInteger(r.layer_no) || r.layer_no < LAYER_MIN || r.layer_no > LAYER_MAX) {
      push(`${label}: layer_no must be an integer in [${LAYER_MIN}, ${LAYER_MAX}]`);
    }
    if (!r.beneficiary_account && !r.victim_account) {
      push(`${label}: must have at least one of beneficiary_account or victim_account`);
    }

    if (truncated) break;
  }

  if (truncated) {
    errors.push(`(error list truncated at ${MAX_VALIDATION_ERRORS} entries)`);
  }

  return { valid: errors.length === 0, errors };
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  parseNcrpFile,
  detectColumnMapping,
  validateParsedData,
  // Exposed for unit tests / advanced callers; not part of the public contract.
  _internals: Object.freeze({
    parseAmount,
    parseDate,
    parseLayer,
    normalizeHeader,
    findHeaderRow,
    CANONICAL_FIELDS,
    HEADER_SYNONYMS,
  }),
};
