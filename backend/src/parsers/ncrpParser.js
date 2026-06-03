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
 * Real NCRP "BankAction CompleteTrail" exports split a case across MULTIPLE
 * sheets, one per disbursement channel:
 *   "Money Transfer to"      — onward bank-to-bank transfers (the only sheet
 *                              that carries a beneficiary "Account No").
 *   "Withdrawal through ATM" — ATM cash withdrawals.
 *   "Withdrawal through POS" — POS card purchases.
 *   "AEPS"                   — Aadhaar-enabled cash withdrawals.
 *   "Transaction put on hold"— funds frozen by the holding bank.
 *   "Other" / "Others Less Then 500" — misc / low-value debits.
 * Each sheet has its OWN header row (on row 0) and its OWN column set — the
 * amount/date columns are named per channel ("Withdrawal Amount",
 * "Put on hold Date", etc.). This parser detects the header + column mapping
 * PER SHEET, materialises each sheet's rows, and concatenates them into one
 * canonical array. Sheets without recognisable NCRP columns are skipped.
 *
 * Because the non-transfer sheets carry no dedicated payment-mode column, the
 * sheet's channel is folded into `payment_mode` ('ATM' / 'POS' / 'AEPS' /
 * 'HOLD') so the analyzer's cashout classification (which keys on
 * payment_mode / atm_id) works directly. An explicit payment-mode column, when
 * present, always wins over the channel default.
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

/**
 * Number of leading rows scanned for the header row. Real exports put the
 * header on row 0, but some portal versions prepend a title/metadata row, so
 * we scan a few rows and pick the best match (see {@link findHeaderRow}).
 */
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

/**
 * Strip a leading "Label :- " / "Label : " prefix from a cell, returning the
 * trailing value with internal whitespace collapsed.
 *
 * Real ATM/POS sheets store these fields with an embedded label, e.g.
 *   " ATM ID :-12221442"        → "12221442"
 *   "Place of ATM :-LUCKNOW"    → "LUCKNOW"
 *   "Place of ATM :-GOLE   DLIN"→ "GOLE DLIN"
 * Values with no leading alpha-label (plain ids, merchant names) pass
 * through unchanged, so it is safe to apply unconditionally.
 *
 * @param {unknown} value
 * @returns {string|null}
 */
function stripLabel(value) {
  const s = trimOrNull(value);
  if (s === null) return null;
  const m = s.match(/^[A-Za-z][A-Za-z .\/]*?:\s*-?\s*(.+)$/s);
  const out = (m ? m[1] : s).trim().replace(/\s+/g, ' ');
  return out === '' ? null : out;
}

// ─── Amount parsing ──────────────────────────────────────────────────

/**
 * Parse an amount cell to a finite number.
 *
 * Handles all NCRP / Indian formatting variants observed in production:
 *   • ₹ symbol, "INR" / "Rs." prefixes (case-insensitive)
 *   • Indian lakh-comma grouping ("1,23,456.78") AND western grouping
 *   • Leading whitespace (" 50,000.00" — common in real exports)
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
  // Trailing Indian rupee terminator ("50,000/-" → "50000"). Note: this only
  // drops a bare "/-" or "/"; multiplier suffixes like "Cr"/"L" are NOT
  // stripped (they would need a ×10^7 / ×10^5 scale, and NCRP machine exports
  // never use them), so an unrecognised alpha-suffixed amount still falls
  // through to the 0 / "unparseable" path rather than being silently mis-scaled.
  s = s.replace(/\/+-?$/, '');

  if (s === '') return 0;
  const n = Number(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

// ─── Date / time parsing ─────────────────────────────────────────────

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
 * Build an ISO 8601 UTC string from (year, month, day[, hour, minute, second]).
 *
 * The wall-clock time is treated as UTC (NOT shifted from IST) so the calendar
 * date never drifts — the analyzer applies the IST offset itself when it needs
 * "same calendar day" semantics. Returns null if the components don't form a
 * valid calendar date (e.g. 31 Feb) or a valid clock time.
 *
 * @param {number} year
 * @param {number} month  1-12
 * @param {number} day    1-31
 * @param {number} [hour=0]
 * @param {number} [minute=0]
 * @param {number} [second=0]
 * @returns {string|null}
 */
function isoFromYMD(year, month, day, hour = 0, minute = 0, second = 0) {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const h = Number.isInteger(hour) ? hour : 0;
  const mi = Number.isInteger(minute) ? minute : 0;
  const s = Number.isInteger(second) ? second : 0;
  if (h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) return null;
  const d = new Date(Date.UTC(year, month - 1, day, h, mi, s));
  if (!Number.isFinite(d.getTime())) return null;
  // Reject silent rollover (e.g. Date.UTC(2024, 1, 31) → 2024-03-02).
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
    return null;
  }
  return d.toISOString();
}

/**
 * Parse the time portion of a datetime cell to a {h, mi, s} triple, or null
 * if no usable time is present.
 *
 * Handles every variant observed in real exports:
 *   • "05:34:19 PM"   — 12-hour with seconds + meridiem
 *   • "12:00:00 AM"   — midnight (12 AM → 00)
 *   • "19:09:PM"      — malformed: 24-hour hour with a stray ":PM" where the
 *                       seconds should be → meridiem ignored when hour > 12
 *   • "00:00:AM"      — malformed midnight
 *   • "05:00:00.000Z" — ISO time tail (meridiem absent, fractional/zone dropped)
 *
 * @param {string} timeStr
 * @returns {{ h: number, mi: number, s: number }|null}
 */
function parseClock(timeStr) {
  if (timeStr === null || timeStr === undefined) return null;
  const up = String(timeStr).trim().toUpperCase();
  if (up === '') return null;

  let meridiem = null;
  if (up.includes('PM')) meridiem = 'PM';
  else if (up.includes('AM')) meridiem = 'AM';

  // Keep digits + colons; everything else (letters, '.', 'Z', spaces) → space.
  const firstTok = up.replace(/[^0-9:]/g, ' ').trim().split(/\s+/)[0] || '';
  const segs = firstTok.split(':').filter((x) => x !== '');
  if (segs.length === 0) return null;

  let h = parseInt(segs[0], 10);
  let mi = segs.length > 1 ? parseInt(segs[1], 10) : 0;
  let s = segs.length > 2 ? parseInt(segs[2], 10) : 0;
  if (!Number.isFinite(h)) return null;
  if (!Number.isFinite(mi)) mi = 0;
  if (!Number.isFinite(s)) s = 0;

  // Apply meridiem only when the hour is in the 12-hour range. A 24-hour hour
  // (e.g. "19:09:PM") already carries the right value — ignore the stray PM.
  if (meridiem && h >= 1 && h <= 12) {
    if (meridiem === 'PM' && h < 12) h += 12;
    if (meridiem === 'AM' && h === 12) h = 0;
  }

  if (h < 0 || h > 23 || mi < 0 || mi > 59 || s < 0 || s > 59) return null;
  return { h, mi, s };
}

/**
 * Parse a date (or datetime) cell to an ISO 8601 UTC string.
 *
 * Accepted forms:
 *   • Excel serial number (45306 → 2024-01-15) — numeric and string-encoded
 *   • Native `Date` instances (SheetJS returns these when `cellDates: true`)
 *   • DD/MM/YYYY [hh:mm[:ss] [AM/PM]] (Indian convention — default for d/m ≤ 12)
 *   • DD-MM-YYYY, DD.MM.YYYY (with optional time)
 *   • MM/DD/YYYY — detected when the middle component is > 12
 *   • YYYY-MM-DD[Thh:mm:ss] (ISO-ish, detected when first component is 4 digits)
 *
 * When a time portion is present it is preserved (in UTC); a date with no time
 * yields midnight UTC. Returns null for blank or unparseable input.
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

  // Split into date and (optional) time around the first space or 'T'.
  const sepIdx = raw.search(/[T\s]/);
  const datePart = sepIdx === -1 ? raw : raw.slice(0, sepIdx);
  const timePart = sepIdx === -1 ? '' : raw.slice(sepIdx + 1);
  const clock = parseClock(timePart);
  const h = clock ? clock.h : 0;
  const mi = clock ? clock.mi : 0;
  const s = clock ? clock.s : 0;

  const parts = datePart.split(/[\/\-.]/).map((p) => p.trim());
  if (parts.length === 3 && parts.every((p) => /^\d+$/.test(p))) {
    const [pa, pb, pc] = parts;
    const a = Number(pa), b = Number(pb), c = Number(pc);

    if (pa.length === 4) {
      // YYYY-MM-DD
      return isoFromYMD(a, b, c, h, mi, s);
    }
    if (pc.length === 4 || c > 1900) {
      // Last component is the four-digit year.
      if (a > 12 && b <= 12) return isoFromYMD(c, b, a, h, mi, s);   // unambiguous DD/MM
      if (b > 12 && a <= 12) return isoFromYMD(c, a, b, h, mi, s);   // unambiguous MM/DD
      // Ambiguous: default to DD/MM (Indian convention).
      return isoFromYMD(c, b, a, h, mi, s);
    }
    if (pa.length <= 2 && pb.length <= 2 && pc.length <= 2) {
      // Two-digit year (DD/MM/YY). Resolve to 19YY/20YY (70-pivot) and keep the
      // DD/MM (Indian) convention + UTC, rather than letting new Date() below
      // guess US MM/DD in machine-local time (which drifts the date by the local
      // UTC offset and flips the month — non-deterministic across environments).
      const yr = c < 70 ? 2000 + c : 1900 + c;
      if (a > 12 && b <= 12) return isoFromYMD(yr, b, a, h, mi, s);
      if (b > 12 && a <= 12) return isoFromYMD(yr, a, b, h, mi, s);
      return isoFromYMD(yr, b, a, h, mi, s);
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

// ─── Sheet-channel classification ─────────────────────────────────────

/**
 * Channel categories derived from a sheet's name. Drives the per-row
 * `payment_mode` default and whether ATM/POS field extraction runs.
 *
 * @enum {string}
 */
const SHEET_CATEGORY = Object.freeze({
  TRANSFER: 'TRANSFER',
  ATM: 'ATM',
  POS: 'POS',
  AEPS: 'AEPS',
  HOLD: 'HOLD',
  OTHER: 'OTHER',
});

/**
 * Classify a sheet by its name into a disbursement channel.
 *
 * @param {string} sheetName
 * @returns {string} One of SHEET_CATEGORY.
 */
function classifySheetCategory(sheetName) {
  const n = String(sheetName || '').toLowerCase();
  if (/withdrawal\s*through\s*atm|\batm\b/.test(n)) return SHEET_CATEGORY.ATM;
  if (/withdrawal\s*through\s*pos|\bpos\b/.test(n)) return SHEET_CATEGORY.POS;
  if (/aeps/.test(n)) return SHEET_CATEGORY.AEPS;
  if (/put\s*on\s*hold|on\s*hold|\bhold\b/.test(n)) return SHEET_CATEGORY.HOLD;
  if (/money\s*transfer|\btransfer\b/.test(n)) return SHEET_CATEGORY.TRANSFER;
  return SHEET_CATEGORY.OTHER;
}

/**
 * Infer a payment rail (UPI / IMPS / NEFT / RTGS) from a transfer-row's remarks
 * when no dedicated payment-mode column exists. Returns null when nothing
 * recognisable is present. Substring (not word-boundary) matching is used so
 * concatenated codes like "DRRTGS-..." still resolve.
 *
 * @param {unknown} remarks
 * @returns {string|null}
 */
function derivePaymentRail(remarks) {
  if (remarks === null || remarks === undefined) return null;
  const r = String(remarks).toUpperCase();
  // Match a rail token as a standalone word ("UPI, ...") OR as the tail of a
  // DR/CR-prefixed transaction code ("DRRTGS-...", "CRNEFT-..."), but never
  // buried inside an ordinary word — a raw includes('UPI') matches "GROUPING",
  // "OCCUPIED", "RECOUPING". Returns the left-most rail actually present, so
  // "NEFT-UPI ref" resolves to NEFT, not UPI.
  const m = r.match(/(?:^|[^A-Z])(?:DR|CR)?(UPI|IMPS|NEFT|RTGS)(?![A-Z])/);
  return m ? m[1] : null;
}

/**
 * The channel-default payment mode for a row, used only when the sheet has no
 * explicit payment-mode column value. ATM/POS/AEPS/HOLD fold the channel into
 * payment_mode so the analyzer's cashout classifier (which keys on
 * payment_mode / atm_id) recognises them. Transfers fall back to a remarks-
 * derived rail; "Other" channels stay null.
 *
 * @param {string} category - One of SHEET_CATEGORY.
 * @param {unknown} remarks
 * @returns {string|null}
 */
function defaultPaymentMode(category, remarks) {
  switch (category) {
    case SHEET_CATEGORY.ATM:  return 'ATM';
    case SHEET_CATEGORY.POS:  return 'POS';
    case SHEET_CATEGORY.AEPS: return 'AEPS';
    case SHEET_CATEGORY.HOLD: return 'HOLD';
    case SHEET_CATEGORY.TRANSFER: return derivePaymentRail(remarks);
    default: return null;
  }
}

/**
 * Extract a terminal id / acceptor location embedded in a cashout row's
 * remarks, used as a fallback when the dedicated ATM ID / location columns are
 * absent in a particular export variant. Only meaningful for ATM/POS rows.
 *
 *   "... // Terminal ID : 21258798 // Card acceptor name: ARIHANT SELECTION"
 *
 * @param {unknown} remarks
 * @returns {{ atm_id: string|null, atm_location: string|null }}
 */
function parseAtmFromRemarks(remarks) {
  const out = { atm_id: null, atm_location: null };
  if (remarks === null || remarks === undefined) return out;
  const r = String(remarks);

  const term = r.match(/terminal\s*id\s*:?-?\s*([A-Za-z0-9]+)/i);
  if (term) out.atm_id = term[1].trim() || null;

  const acc = r.match(/card\s*acceptor\s*name\s*:?-?\s*([^/|\n]+)/i);
  if (acc) {
    const v = acc[1].trim().replace(/\s+/g, ' ');
    out.atm_location = v === '' ? null : v;
  }
  return out;
}

// ─── Header detection ────────────────────────────────────────────────

/**
 * Map a row of header cells to canonical schema fields.
 *
 * Matches are case-insensitive and whitespace-tolerant. If two cells in the
 * same row both map to the same canonical field, the first wins and the
 * second is reported as `unmapped` — this also covers the real "Money Transfer
 * to" sheet's two near-identical UTR columns ("Transaction Id / UTR Number"
 * and "Transaction ID / UTR Number"), which carry the same value, so taking
 * the first is correct.
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
 * `HEADER_DETECTION_MIN_MATCHES` threshold — typically signals the sheet
 * isn't a BankAction CompleteTrail data sheet at all.
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

// ─── Per-sheet materialisation ─────────────────────────────────────────

/**
 * Build canonical rows from a single worksheet's array-of-arrays.
 *
 * @param {ReadonlyArray<ReadonlyArray<unknown>>} aoa
 * @param {{ row: number }} headerInfo
 * @param {Record<string, number>} mapping
 * @param {string} category - One of SHEET_CATEGORY.
 * @returns {{ rows: Array<Object>, skipped: number }}
 */
function materializeSheetRows(aoa, headerInfo, mapping, category) {
  const rows = [];
  let skipped = 0;

  const getter = (row) => (canonical) => {
    const idx = mapping[canonical];
    if (idx === undefined || idx >= row.length) return null;
    return row[idx];
  };

  const isCashoutChannel = category === SHEET_CATEGORY.ATM || category === SHEET_CATEGORY.POS;

  for (let i = headerInfo.row + 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (!Array.isArray(row) || row.every(isBlank)) continue;

    const get = getter(row);

    const ack_no              = trimOrNull(get('ack_no'));
    const victim_account      = trimOrNull(get('victim_account'));
    let beneficiary_account   = trimOrNull(get('beneficiary_account'));

    // A row with no acknowledgement number AND no account on either side
    // carries no transaction — it's a summary / total / blank row. Drop it.
    if (ack_no === null && victim_account === null && beneficiary_account === null) {
      skipped++;
      continue;
    }

    // Cross-sheet account join: the cashout / hold / AEPS / other channels carry
    // no dedicated beneficiary ("Account No") column — their single account
    // column ("Account No./ (Wallet /PG/PA) Id" → victim_account) IS the
    // account-under-investigation (the mule whose funds were withdrawn or
    // frozen). File that account into beneficiary_account too (victim_account is
    // kept) so its inbound receipt on the "Money Transfer to" sheet and this
    // cash-exit / hold leg collapse onto one account_no. The analyzer keys all
    // per-account logic (same-day cashout FR-12, total_cashed_out, lien
    // eligibility, mule rollup) on beneficiary_account; without this join those
    // metrics read zero/over-stated on real multi-sheet exports. Only applied
    // when the sheet has no beneficiary column, so transfer rows (which carry a
    // genuine onward beneficiary) are never overwritten.
    if (beneficiary_account === null &&
        mapping.beneficiary_account === undefined &&
        victim_account !== null) {
      beneficiary_account = victim_account;
    }

    const remarks = trimOrNull(get('remarks'));

    // ATM / location: strip embedded labels (" ATM ID :-12221442" → "12221442"),
    // then for cashout channels fall back to remarks when a column is absent.
    let atm_id = stripLabel(get('atm_id'));
    let atm_location = stripLabel(get('atm_location'));
    if (isCashoutChannel && (atm_id === null || atm_location === null)) {
      const fromRemarks = parseAtmFromRemarks(remarks);
      if (atm_id === null) atm_id = fromRemarks.atm_id;
      if (atm_location === null) atm_location = fromRemarks.atm_location;
    }

    // Explicit payment-mode column wins; otherwise fold in the channel default.
    const payment_mode = trimOrNull(get('payment_mode')) || defaultPaymentMode(category, remarks);

    rows.push({
      ack_no,
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
      payment_mode,
      layer_no:            parseLayer(get('layer_no')),
      atm_id,
      atm_location,
      city:                trimOrNull(get('city')),
      state:               trimOrNull(get('state')),
      remarks,
      same_day_cashout:    0,
      cashout_mode:        null,
    });
  }

  return { rows, skipped };
}

// ─── Main entry point ────────────────────────────────────────────────

/**
 * Parse an NCRP BankAction CompleteTrail export.
 *
 * Iterates EVERY sheet in the workbook. Each sheet's header row + column
 * mapping are detected independently (NCRP splits a case across one sheet per
 * disbursement channel, each with its own columns). Rows from every sheet that
 * carries recognisable NCRP columns are concatenated into one canonical array;
 * sheets without a detectable header (or without any account-identifying
 * column) are skipped and noted in `warnings`.
 *
 * A row is dropped (silently, counted in `warnings`) when it has no
 * acknowledgement number AND no account on either side — the signal for a
 * summary / total / blank row.
 *
 * Throws on filesystem / SheetJS errors; returns a normal result with
 * `warnings` set when the file is structurally valid but no header row can be
 * located on any sheet.
 *
 * @param {string} filePath - Absolute or relative path to .xlsx / .xls file.
 * @returns {{
 *   rows: Array<Object>,
 *   columnMapping: Record<string, number>,
 *   warnings: string[],
 *   sheets: Array<{
 *     name: string, accepted: boolean, reason?: string, category?: string,
 *     headerRow?: number, rows?: number, skipped?: number,
 *     unmappedColumns?: string[]
 *   }>
 * }}
 *
 * @example
 *   const { parseNcrpFile } = require('./parsers/ncrpParser');
 *   const { rows, columnMapping, warnings, sheets } = parseNcrpFile('upload.xlsx');
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

  const warnings = [];
  const sheets = [];
  const allRows = [];
  /** @type {Record<string, number>|null} */
  let firstMapping = null;
  const acceptedSheets = [];
  const skippedSheets = [];
  let totalSkippedRows = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    const aoa = XLSX.utils.sheet_to_json(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: false,
    });

    if (aoa.length === 0) {
      sheets.push({ name: sheetName, accepted: false, reason: 'empty' });
      skippedSheets.push(sheetName);
      continue;
    }

    const headerInfo = findHeaderRow(aoa);
    if (headerInfo === null) {
      sheets.push({ name: sheetName, accepted: false, reason: 'no-header-row' });
      skippedSheets.push(sheetName);
      continue;
    }

    const { mapping, unmapped } = detectColumnMapping(headerInfo.headers);

    // Safety check: a genuine NCRP data sheet always carries an acknowledgement
    // number and at least one account column. Reject sheets that merely matched
    // a few unrelated synonyms.
    if (
      mapping.ack_no === undefined &&
      mapping.victim_account === undefined &&
      mapping.beneficiary_account === undefined
    ) {
      sheets.push({
        name: sheetName, accepted: false, reason: 'no-key-columns',
        unmappedColumns: unmapped,
      });
      skippedSheets.push(sheetName);
      continue;
    }

    const category = classifySheetCategory(sheetName);
    const { rows: sheetRows, skipped } = materializeSheetRows(
      aoa, headerInfo, mapping, category
    );

    if (firstMapping === null) firstMapping = mapping;
    for (const r of sheetRows) allRows.push(r);
    totalSkippedRows += skipped;
    acceptedSheets.push(sheetName);

    sheets.push({
      name: sheetName,
      accepted: true,
      category,
      headerRow: headerInfo.row,
      rows: sheetRows.length,
      skipped,
      unmappedColumns: unmapped,
    });
  }

  // No sheet yielded a usable header → the file isn't a CompleteTrail export.
  if (acceptedSheets.length === 0) {
    return {
      rows: [],
      columnMapping: {},
      warnings: [
        `Could not detect a header row within the first ${HEADER_SCAN_DEPTH} rows of any sheet`,
      ],
      sheets,
    };
  }

  if (acceptedSheets.length > 1) {
    warnings.push(
      `Combined ${allRows.length} rows from ${acceptedSheets.length} sheets: ${acceptedSheets.join(', ')}`
    );
  }
  if (skippedSheets.length > 0) {
    warnings.push(
      `Skipped ${skippedSheets.length} sheet(s) without recognizable NCRP columns: ${skippedSheets.join(', ')}`
    );
  }
  if (totalSkippedRows > 0) {
    warnings.push(
      `Skipped ${totalSkippedRows} row(s) with no account identifiers (likely summary/blank rows)`
    );
  }

  // Duplicate detection. The "Transaction Id / UTR Number" column NCRP fills is
  // often a reused batch/reference token (one value spread across many distinct
  // legs with different amounts/dates), so UTR + beneficiary alone over-reports.
  // Require UTR + beneficiary + amount + timestamp to all match — a genuine
  // re-export of the same transaction, not a shared reference. Only transfer
  // rows carry a beneficiary account, so cross-sheet rows never false-positive.
  const seen = new Set();
  let duplicateCount = 0;
  for (const r of allRows) {
    if (!r.utr_no || !r.beneficiary_account) continue;
    const key = `${r.utr_no}|${r.beneficiary_account}|${r.transaction_amount}|${r.transaction_date || ''}`;
    if (seen.has(key)) duplicateCount++;
    else seen.add(key);
  }
  if (duplicateCount > 0) {
    warnings.push(
      `${duplicateCount} duplicate row(s) detected (identical UTR, account, amount and date). ` +
      'The same transaction often appears in more than one NCRP channel sheet — ' +
      'this is normal NCRP portal behaviour and does not indicate a problem with your file.'
    );
  }

  return { rows: allRows, columnMapping: firstMapping || {}, warnings, sheets };
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
    parseClock,
    normalizeHeader,
    stripLabel,
    findHeaderRow,
    classifySheetCategory,
    derivePaymentRail,
    defaultPaymentMode,
    parseAtmFromRemarks,
    SHEET_CATEGORY,
    CANONICAL_FIELDS,
    HEADER_SYNONYMS,
  }),
};
