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
 * Each sheet has its OWN header row (usually row 0; banner rows above the
 * table are tolerated — the first 11 rows are scanned) and its OWN column set —
 * the amount/date columns are named per channel ("Withdrawal Amount",
 * "Put on hold Date", etc.). This parser forward-fills merged cells, detects
 * the header + column mapping PER SHEET (exact synonym match first, then a
 * punctuation-insensitive loose match), matches sheet names fuzzily against
 * the known channel names, materialises each sheet's rows, and concatenates
 * them into one canonical array. Sheets without recognisable NCRP columns are
 * skipped and logged; a sheet WITH data whose required columns cannot be
 * confidently mapped — or whose disbursement channel cannot be determined at
 * all (unknown name AND no payment-mode / ATM-ID / beneficiary column) —
 * FAILS LOUD via structured `errors` (and contributes no rows) rather than
 * producing silently wrong figures.
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
const { resolveBank } = require('../lib/ifscBankResolver');

// ─── Constants ───────────────────────────────────────────────────────

/**
 * Number of leading rows scanned for the header row (rows 0–10 inclusive).
 * Real exports put the header on row 0, but some portal versions prepend
 * title/banner/metadata rows above the table, so we scan a window and pick
 * the best match (see {@link findHeaderRow}).
 */
const HEADER_SCAN_DEPTH = 11;

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
  // Bank-attribution audit fields (FinTrace v0.2.0). `beneficiary_bank` now
  // carries the IFSC-authoritative name; these preserve the original text and
  // record how the name was resolved (see lib/ifscBankResolver).
  'raw_beneficiary_bank', 'bank_source', 'bank_flag',
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

/**
 * Loose inverse synonym map: alphanumeric-only header string → canonical
 * field. Consulted only when the exact-normalised lookup misses, so it can
 * never change the mapping of a header the exact map already knows. Catches
 * punctuation/spacing drift the synonym list can't enumerate ("Layer-No.",
 * "A/C No", "Txn.Amount"). Keys that would map to TWO different canonical
 * fields are dropped entirely — when a loose match is ambiguous we refuse to
 * guess (the column simply stays unmapped and is surfaced as such).
 *
 * @type {ReadonlyMap<string, string>}
 */
const SYNONYM_TO_CANONICAL_LOOSE = (() => {
  const map = new Map();
  const ambiguous = new Set();
  const add = (key, canonical) => {
    if (key === '') return;
    const existing = map.get(key);
    if (existing !== undefined && existing !== canonical) {
      ambiguous.add(key);
      return;
    }
    map.set(key, canonical);
  };
  for (const [canonical, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    add(normalizeHeaderLoose(canonical), canonical);
    for (const syn of synonyms) add(normalizeHeaderLoose(syn), canonical);
  }
  for (const key of ambiguous) map.delete(key);
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
 * Loose header normalisation: everything {@link normalizeHeader} does, then
 * strip every character that is not a Latin letter, digit, or Devanagari
 * letter. "Layer No." / "Layer-No" / "layerno" all collapse to "layerno".
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHeaderLoose(value) {
  return normalizeHeader(value).replace(/[^a-z0-9ऀ-ॿ]+/g, '');
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
 * Normalise a sheet name for fuzzy matching: lowercase, every punctuation /
 * underscore / extra-whitespace run collapsed to a single space.
 * " MONEY_transfer  TO " → "money transfer to".
 *
 * @param {unknown} name
 * @returns {string}
 */
function normalizeSheetName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * The known NCRP CompleteTrail sheet names (normalised) → channel category.
 * Includes the portal's real spellings ("Others Less Then 500" — sic) and
 * the common shorthand variants.
 *
 * @type {ReadonlyMap<string, string>}
 */
const KNOWN_SHEET_NAMES = new Map([
  ['money transfer to', SHEET_CATEGORY.TRANSFER],
  ['money transfer', SHEET_CATEGORY.TRANSFER],
  ['withdrawal through atm', SHEET_CATEGORY.ATM],
  ['atm', SHEET_CATEGORY.ATM],
  ['withdrawal through pos', SHEET_CATEGORY.POS],
  ['pos', SHEET_CATEGORY.POS],
  ['aeps', SHEET_CATEGORY.AEPS],
  ['transaction put on hold', SHEET_CATEGORY.HOLD],
  ['put on hold', SHEET_CATEGORY.HOLD],
  ['hold', SHEET_CATEGORY.HOLD],
  ['other', SHEET_CATEGORY.OTHER],
  ['others', SHEET_CATEGORY.OTHER],
  ['others less then 500', SHEET_CATEGORY.OTHER],
  ['others less than 500', SHEET_CATEGORY.OTHER],
]);

/**
 * Classify a sheet with fuzzy name matching.
 *
 * Resolution order:
 *   1. Exact match of the normalised name against {@link KNOWN_SHEET_NAMES}
 *      (case/whitespace/punctuation-insensitive) → known.
 *   2. Keyword fallback via {@link classifySheetCategory}; a non-OTHER hit
 *      still counts as known (the channel keyword is unambiguous).
 *   3. Anything else → category OTHER, known=false. Such sheets are still
 *      parsed when they carry recognisable NCRP columns (a renamed sheet
 *      must not silently lose its rows) but are flagged in `warnings`.
 *
 * @param {string} sheetName
 * @returns {{ category: string, known: boolean }}
 */
function classifySheet(sheetName) {
  const normalized = normalizeSheetName(sheetName);
  const exact = KNOWN_SHEET_NAMES.get(normalized);
  if (exact !== undefined) return { category: exact, known: true };
  // Keyword fallback on the NORMALISED name so punctuation/underscores
  // ("Withdrawal_Through_ATM (1)") can't defeat the word-boundary regexes.
  const category = classifySheetCategory(normalized);
  return { category, known: category !== SHEET_CATEGORY.OTHER };
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

// ─── Merged-cell handling ────────────────────────────────────────────

/**
 * Forward-fill merged regions in a worksheet, in place.
 *
 * Excel stores a merged range's value only in its top-left (anchor) cell; the
 * covered cells read back as blank, which would silently blank out headers and
 * data (e.g. an Ack No merged down a block of rows). For every range in
 * `ws['!merges']`, copy the anchor's value into each covered cell that is
 * empty, so `sheet_to_json` sees the value everywhere the spreadsheet displays
 * it. Non-empty covered cells are never overwritten.
 *
 * @param {XLSX.WorkSheet} ws
 * @returns {number} Count of cells filled.
 */
function forwardFillMerges(ws) {
  const merges = ws && ws['!merges'];
  if (!Array.isArray(merges) || merges.length === 0) return 0;
  let filled = 0;
  for (const m of merges) {
    if (!m || !m.s || !m.e) continue;
    const anchor = ws[XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c })];
    if (!anchor || anchor.v === undefined || anchor.v === null || anchor.v === '') continue;
    for (let r = m.s.r; r <= m.e.r; r++) {
      for (let c = m.s.c; c <= m.e.c; c++) {
        if (r === m.s.r && c === m.s.c) continue;
        const addr = XLSX.utils.encode_cell({ r, c });
        const cell = ws[addr];
        if (cell === undefined || cell.v === undefined || cell.v === null || cell.v === '') {
          ws[addr] = { t: anchor.t, v: anchor.v, w: anchor.w };
          filled++;
        }
      }
    }
  }
  return filled;
}

/**
 * True when a data row is just a copy of the header row — the artefact a
 * vertically-merged (two-row) header leaves behind after forward-fill, and
 * the shape of headers some exporters repeat mid-table. Compares only the
 * mapped columns; requires at least two matching cells so a sparse row can't
 * false-positive.
 *
 * @param {ReadonlyArray<unknown>} row
 * @param {ReadonlyArray<unknown>} headers
 * @param {Record<string, number>} mapping
 * @returns {boolean}
 */
function isRepeatedHeaderRow(row, headers, mapping) {
  if (!Array.isArray(row)) return false;
  let compared = 0;
  for (const idx of Object.values(mapping)) {
    const h = normalizeHeader(headers[idx]);
    if (h === '') continue;
    const c = normalizeHeader(idx < row.length ? row[idx] : null);
    if (c !== h) return false;
    compared++;
  }
  return compared >= 2;
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
    // Exact-normalised match first (authoritative); loose alphanumeric-only
    // match as fallback so punctuation/spacing drift still resolves. The loose
    // map drops ambiguous keys at build time, so it never guesses.
    const canonical = SYNONYM_TO_CANONICAL.get(normalized)
      || SYNONYM_TO_CANONICAL_LOOSE.get(normalizeHeaderLoose(cell));
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

// ─── Required-column policy (FAIL LOUD) ───────────────────────────────

/**
 * Columns that MUST be confidently mapped before a sheet's rows may
 * contribute to any computed figure, per channel. A wrong number in front of
 * an SP is unacceptable; refusing with a clear reason is correct — so when a
 * required column is missing on a sheet that has data rows, the parser emits
 * a structured {@link ParseError} and contributes NO rows from that sheet.
 *
 * The pseudo-column 'account' is satisfied by EITHER victim_account (the
 * channel sheets' single "Account No./ (Wallet /PG/PA) Id" column) or
 * beneficiary_account (the transfer sheet's "Account No").
 *
 * Channel-aware on purpose — real NCRP exports genuinely omit columns per
 * channel: "Others Less Then 500" carries NO amount column at all, and
 * "Transaction put on hold" has no Disputed Amount. Requiring those would
 * reject every authentic file.
 *
 * @type {Readonly<Record<string, ReadonlyArray<string>>>}
 */
const REQUIRED_COLUMNS_BY_CATEGORY = Object.freeze({
  [SHEET_CATEGORY.TRANSFER]: Object.freeze(['account', 'transaction_amount', 'disputed_amount']),
  [SHEET_CATEGORY.ATM]:      Object.freeze(['account', 'transaction_amount']),
  [SHEET_CATEGORY.POS]:      Object.freeze(['account', 'transaction_amount']),
  [SHEET_CATEGORY.AEPS]:     Object.freeze(['account', 'transaction_amount']),
  [SHEET_CATEGORY.HOLD]:     Object.freeze(['account', 'transaction_amount']),
  [SHEET_CATEGORY.OTHER]:    Object.freeze(['account']),
});

/** Officer-facing labels + example headers for each required column. */
const REQUIRED_COLUMN_INFO = Object.freeze({
  account: {
    label: 'Account No./ (Wallet /PG/PA) Id',
    canonicalFields: ['victim_account', 'beneficiary_account'],
  },
  transaction_amount: {
    label: 'Transaction Amount',
    canonicalFields: ['transaction_amount'],
  },
  disputed_amount: {
    label: 'Disputed Amount',
    canonicalFields: ['disputed_amount'],
  },
});

/**
 * @typedef {Object} ParseError
 * @property {'REQUIRED_COLUMN_MISSING'|'UNKNOWN_CHANNEL_WITH_TRANSACTIONS'} code
 * @property {string} sheet            Sheet name as it appears in the workbook.
 * @property {string} category         SHEET_CATEGORY the sheet was classified as.
 * @property {string} [expectedColumn] Officer-facing name of the missing column
 *                                     (REQUIRED_COLUMN_MISSING only).
 * @property {string[]} [canonicalFields] Canonical field(s) that would satisfy it.
 * @property {string[]} [acceptedHeaders] Sample header spellings that would match.
 * @property {string[]} foundHeaders   Non-blank headers actually present.
 * @property {number} dataRows         Data rows the sheet holds (excluded from output).
 * @property {string} message          Human-readable explanation.
 */

/**
 * Build the structured error for a required column that could not be mapped.
 *
 * @param {string} sheetName
 * @param {string} category
 * @param {string} requiredKey - Key of REQUIRED_COLUMN_INFO.
 * @param {ReadonlyArray<unknown>} headers
 * @param {number} dataRows
 * @returns {ParseError}
 */
function buildRequiredColumnError(sheetName, category, requiredKey, headers, dataRows) {
  const info = REQUIRED_COLUMN_INFO[requiredKey];
  const accepted = [];
  for (const field of info.canonicalFields) {
    for (const syn of (HEADER_SYNONYMS[field] || []).slice(0, 4)) accepted.push(syn);
  }
  const found = (Array.isArray(headers) ? headers : [])
    .filter((h) => !isBlank(h))
    .map((h) => String(h).trim());
  return {
    code: 'REQUIRED_COLUMN_MISSING',
    sheet: sheetName,
    category,
    expectedColumn: info.label,
    canonicalFields: [...info.canonicalFields],
    acceptedHeaders: accepted,
    foundHeaders: found,
    dataRows,
    message:
      `Sheet '${sheetName}' has ${dataRows} data row(s) but no column matching ` +
      `'${info.label}' could be identified. Found columns: ` +
      `${found.length ? found.join(', ') : '(none)'}. ` +
      'Figures from this sheet cannot be computed safely — correct the header ' +
      'or re-export the file from NCRP, then upload again.',
  };
}

/**
 * Build the structured error for an unknown-named sheet that carries
 * transaction-shaped rows but no way to determine its disbursement channel.
 *
 * WHY THIS BLOCKS (consequence-scoped policy): the channel decides whether a
 * row is a cash EXIT. Cash exits reduce an account's lien-eligible balance
 * (lien = received − forwarded − on_hold − cashed_out, floored and capped).
 * Rows we can't classify would be EXCLUDED from cashed_out, which UNDERSTATES
 * cash-out and INFLATES the lien — the dangerous direction, since the lien
 * figure goes into Section 102 CrPC bank letters and SP reports. Refusing
 * with a clear reason is correct; a quiet warning is not.
 *
 * @param {string} sheetName
 * @param {ReadonlyArray<unknown>} headers
 * @param {number} txnRows - Count of rows carrying both an account and an amount.
 * @returns {ParseError}
 */
function buildUnknownChannelError(sheetName, headers, txnRows) {
  const found = (Array.isArray(headers) ? headers : [])
    .filter((h) => !isBlank(h))
    .map((h) => String(h).trim());
  return {
    code: 'UNKNOWN_CHANNEL_WITH_TRANSACTIONS',
    sheet: sheetName,
    category: SHEET_CATEGORY.OTHER,
    foundHeaders: found,
    dataRows: txnRows,
    message:
      `Sheet '${sheetName}' is not a recognised NCRP sheet name, but it appears ` +
      `to contain ${txnRows} transaction row(s) (account and amount values present; ` +
      `columns found: ${found.length ? found.join(', ') : '(none)'}). ` +
      'The disbursement channel could not be determined — the sheet carries no ' +
      'payment-mode, ATM-ID, or beneficiary-account column to classify its rows. ' +
      'Processing is refused: counting these rows without a channel would ' +
      'understate cashed-out funds and overstate the lien-eligible balance. ' +
      "Rename the sheet to its NCRP channel (e.g. 'AEPS', 'Withdrawal through ATM', " +
      "'Money Transfer to') or re-export the file from NCRP, then upload again.",
  };
}

// ─── Per-sheet materialisation ─────────────────────────────────────────

/**
 * Build canonical rows from a single worksheet's array-of-arrays.
 *
 * @param {ReadonlyArray<ReadonlyArray<unknown>>} aoa
 * @param {{ row: number, headers: ReadonlyArray<unknown> }} headerInfo
 * @param {Record<string, number>} mapping
 * @param {string} category - One of SHEET_CATEGORY.
 * @returns {{ rows: Array<Object>, skipped: number, repeatedHeaders: number }}
 */
function materializeSheetRows(aoa, headerInfo, mapping, category) {
  const rows = [];
  let skipped = 0;
  let repeatedHeaders = 0;

  const getter = (row) => (canonical) => {
    const idx = mapping[canonical];
    if (idx === undefined || idx >= row.length) return null;
    return row[idx];
  };

  const isCashoutChannel = category === SHEET_CATEGORY.ATM || category === SHEET_CATEGORY.POS;

  for (let i = headerInfo.row + 1; i < aoa.length; i++) {
    const row = aoa[i];
    if (!Array.isArray(row) || row.every(isBlank)) continue;

    // A copy of the header row (left behind by a vertically-merged two-row
    // header after forward-fill, or a mid-table repeated header) is not data.
    if (isRepeatedHeaderRow(row, headerInfo.headers, mapping)) {
      repeatedHeaders++;
      continue;
    }

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

    // ── Authoritative bank attribution (FinTrace v0.2.0) ──────────────────
    // The raw "Bank/FIs" text is unreliable; the IFSC's first four chars are
    // authoritative. Resolve the BENEFICIARY/destination side (the freeze
    // target) so every downstream consumer — lien letters, mule list, bank
    // rollups, exports — inherits the corrected name. The original text is
    // preserved in `raw_beneficiary_bank` for audit, and a data-quality flag
    // records any IFSC↔text disagreement. Only resolve when there is something
    // to resolve; rows from the cash-exit / hold / AEPS channels carry no
    // beneficiary bank or IFSC and are left untouched (null) rather than being
    // stamped "Unknown".
    const rawBeneficiaryBank = trimOrNull(get('beneficiary_bank'));
    const ifscCode = trimOrNull(get('ifsc_code'));
    let beneficiary_bank = rawBeneficiaryBank;
    let raw_beneficiary_bank = null;
    let bank_source = null;
    let bank_flag = null;
    if (ifscCode || rawBeneficiaryBank) {
      const resolved = resolveBank({
        rawBank: rawBeneficiaryBank,
        ifsc: ifscCode,
        account: beneficiary_account,
      });
      beneficiary_bank = resolved.bank;
      raw_beneficiary_bank = rawBeneficiaryBank; // original text, preserved for audit
      bank_source = resolved.source;             // 'IFSC' | 'TEXT'
      bank_flag = resolved.flag;                 // null | 'IFSC_TEXT_MISMATCH' | ...
    }

    rows.push({
      ack_no,
      complaint_date:      parseDate(get('complaint_date')),
      victim_account,
      victim_bank:         trimOrNull(get('victim_bank')),
      beneficiary_account,
      beneficiary_bank,
      beneficiary_name:    trimOrNull(get('beneficiary_name')),
      ifsc_code:           ifscCode,
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
      raw_beneficiary_bank,
      bank_source,
      bank_flag,
      same_day_cashout:    0,
      cashout_mode:        null,
    });
  }

  return { rows, skipped, repeatedHeaders };
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
 * FAIL-LOUD CONTRACT: `errors` carries one structured {@link ParseError} per
 * required column that could not be mapped on a sheet that has data rows
 * (see REQUIRED_COLUMNS_BY_CATEGORY). Such sheets contribute ZERO rows, and
 * callers MUST treat a non-empty `errors` as blocking — no figure derived
 * from this file may be shown until the file is fixed.
 *
 * @param {string} filePath - Absolute or relative path to .xlsx / .xls file.
 * @returns {{
 *   rows: Array<Object>,
 *   columnMapping: Record<string, number>,
 *   warnings: string[],
 *   errors: ParseError[],
 *   sheets: Array<{
 *     name: string, accepted: boolean, reason?: string, category?: string,
 *     headerRow?: number, rows?: number, skipped?: number, dataRows?: number,
 *     missingColumns?: string[], unmappedColumns?: string[]
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
  /** @type {ParseError[]} */
  const errors = [];
  const sheets = [];
  const allRows = [];
  /** @type {Record<string, number>|null} */
  let firstMapping = null;
  const acceptedSheets = [];
  const skippedSheets = [];
  let totalSkippedRows = 0;

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];

    // Merged regions store their value only in the anchor cell — forward-fill
    // so merged header/data cells don't read back as blanks.
    const mergedFilled = forwardFillMerges(sheet);

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
    const { category, known } = classifySheet(sheetName);

    const hasKeyColumns =
      mapping.ack_no !== undefined ||
      mapping.victim_account !== undefined ||
      mapping.beneficiary_account !== undefined;

    // A sheet whose name matches nothing known AND that carries none of the
    // key NCRP columns merely matched a few stray synonyms — not an NCRP data
    // sheet. Skip it (logged below), exactly as before.
    if (!hasKeyColumns && !known) {
      sheets.push({
        name: sheetName, accepted: false, reason: 'no-key-columns',
        unmappedColumns: unmapped,
      });
      skippedSheets.push(sheetName);
      continue;
    }

    // Count usable data rows below the header (blank rows and repeated-header
    // artefacts excluded) BEFORE deciding whether missing columns are fatal —
    // a header-only sheet with nothing to mis-compute is not an error.
    let dataRows = 0;
    for (let i = headerInfo.row + 1; i < aoa.length; i++) {
      const row = aoa[i];
      if (!Array.isArray(row) || row.every(isBlank)) continue;
      if (isRepeatedHeaderRow(row, headerInfo.headers, mapping)) continue;
      dataRows++;
    }

    // FAIL LOUD: a sheet with data whose required columns can't be confidently
    // mapped contributes structured errors and ZERO rows. Guessing here is how
    // a wrong figure ends up in front of an SP.
    if (dataRows > 0) {
      const required = REQUIRED_COLUMNS_BY_CATEGORY[category] || ['account'];
      const missing = required.filter((req) => (
        req === 'account'
          ? mapping.victim_account === undefined && mapping.beneficiary_account === undefined
          : mapping[req] === undefined
      ));
      if (missing.length > 0) {
        for (const req of missing) {
          errors.push(buildRequiredColumnError(
            sheetName, category, req, headerInfo.headers, dataRows
          ));
        }
        sheets.push({
          name: sheetName,
          accepted: false,
          reason: 'missing-required-columns',
          category,
          headerRow: headerInfo.row,
          dataRows,
          missingColumns: missing.map((req) => REQUIRED_COLUMN_INFO[req].label),
          unmappedColumns: unmapped,
        });
        continue;
      }
    }

    // CONSEQUENCE-SCOPED unknown-sheet policy. An unknown-named sheet whose
    // rows can still be classified individually — an explicit payment-mode
    // column, an ATM-ID column (renamed ATM/POS sheets), or a beneficiary
    // column (renamed transfer sheets, classified HOP by account identity) —
    // parses normally with a warning. But an unknown-named sheet carrying
    // transaction-shaped rows (account + amount) with NONE of those signals
    // is unclassifiable: its rows would silently drop out of cashed_out,
    // understating cash-out and INFLATING the lien. That must fail loud.
    // Sheets without transaction-shaped rows (cover pages, notes) keep the
    // old skip-and-warn behaviour — refusing a whole file over a notes tab
    // is not acceptable.
    if (!known && dataRows > 0) {
      const channelEvidence =
        mapping.payment_mode !== undefined ||
        mapping.atm_id !== undefined ||
        mapping.beneficiary_account !== undefined;
      if (!channelEvidence && mapping.transaction_amount !== undefined) {
        // Count transaction-shaped rows: a recognised account value AND a
        // recognised amount value on the same row. (beneficiary_account is
        // unmapped in this branch, so the account column is victim_account —
        // guaranteed mapped by the required-columns gate above.)
        const acctIdx = mapping.victim_account;
        const amtIdx = mapping.transaction_amount;
        let txnShaped = 0;
        for (let i = headerInfo.row + 1; i < aoa.length; i++) {
          const row = aoa[i];
          if (!Array.isArray(row) || row.every(isBlank)) continue;
          if (isRepeatedHeaderRow(row, headerInfo.headers, mapping)) continue;
          const acct = acctIdx !== undefined && acctIdx < row.length ? row[acctIdx] : null;
          const amt = amtIdx < row.length ? row[amtIdx] : null;
          if (!isBlank(acct) && !isBlank(amt)) txnShaped++;
        }
        if (txnShaped > 0) {
          errors.push(buildUnknownChannelError(sheetName, headerInfo.headers, txnShaped));
          sheets.push({
            name: sheetName,
            accepted: false,
            reason: 'unknown-channel',
            headerRow: headerInfo.row,
            dataRows: txnShaped,
            unmappedColumns: unmapped,
          });
          continue;
        }
      }
    }

    const { rows: sheetRows, skipped, repeatedHeaders } = materializeSheetRows(
      aoa, headerInfo, mapping, category
    );

    if (!known && sheetRows.length > 0) {
      warnings.push(
        `Sheet '${sheetName}' does not match any known NCRP sheet name — ` +
        'parsed as a generic channel based on its columns.'
      );
    }
    if (mergedFilled > 0) {
      warnings.push(
        `Sheet '${sheetName}': filled ${mergedFilled} blank cell(s) from merged regions.`
      );
    }
    if (repeatedHeaders > 0) {
      warnings.push(
        `Sheet '${sheetName}': skipped ${repeatedHeaders} repeated header row(s).`
      );
    }

    // No Layer column on an accepted sheet that produced rows: every row was
    // defaulted to Layer 1 (see parseLayer), which flattens the layer analysis.
    // Surface it so the officer knows the layer breakdown is approximate.
    if (mapping.layer_no === undefined && sheetRows.length > 0) {
      warnings.push(
        `Layer column not found in sheet '${sheetName}' — defaulting all rows to Layer 1. ` +
        'This may affect layer analysis accuracy.'
      );
    }

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

  // No sheet was accepted. When structured errors exist they are the real
  // story (required columns missing); otherwise the file simply isn't a
  // CompleteTrail export.
  if (acceptedSheets.length === 0) {
    return {
      rows: [],
      columnMapping: {},
      warnings: errors.length > 0 ? warnings : [
        `Could not detect a header row within the first ${HEADER_SCAN_DEPTH} rows of any sheet`,
      ],
      errors,
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

  return { rows: allRows, columnMapping: firstMapping || {}, warnings, errors, sheets };
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
    normalizeHeaderLoose,
    normalizeSheetName,
    stripLabel,
    findHeaderRow,
    forwardFillMerges,
    isRepeatedHeaderRow,
    classifySheetCategory,
    classifySheet,
    derivePaymentRail,
    defaultPaymentMode,
    parseAtmFromRemarks,
    SHEET_CATEGORY,
    CANONICAL_FIELDS,
    HEADER_SYNONYMS,
    KNOWN_SHEET_NAMES,
    REQUIRED_COLUMNS_BY_CATEGORY,
    HEADER_SCAN_DEPTH,
  }),
};
