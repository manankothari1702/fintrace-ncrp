'use strict';

/**
 * FinTrace NCRP — self-healing fuzzy resolver for sheet names + column headers.
 *
 * COURT-FACING SAFETY CONTRACT
 * ----------------------------
 * This module is a PURE, side-effect-free matching library. It is the THIRD
 * resolution tier, consulted by ncrpParser.js ONLY after the authoritative
 * exact-normalised match AND the punctuation-insensitive loose match have both
 * missed. It never runs on the happy path, so it cannot change the byte-for-byte
 * output of any file that already parses cleanly today.
 *
 * Every resolution it returns is:
 *   • Gated at a hard confidence floor (>= {@link FUZZY_THRESHOLD}). Below the
 *     floor it returns `null` — the caller then FAILS LOUD (required column /
 *     unknown channel) or degrades exactly as it does today. A bad guess never
 *     silently becomes a parsed figure.
 *   • Refused when ambiguous: if a second target mapping to a DIFFERENT canonical
 *     value scores within {@link AMBIGUITY_MARGIN} of the best, the resolver
 *     returns `null` rather than pick one (mirrors the loose-map ambiguity drop).
 *   • Reported: the caller surfaces the matched-from / matched-to / confidence in
 *     a structured parse warning so the resolution is auditable in the dossier.
 *
 * Similarity metric: the MAX of two complementary, length-normalised scores,
 * both in [0,1] and both implemented inline (no external dependency):
 *   • Sørensen–Dice over character bigrams — resilient to token reordering and
 *     partial overlap ("Beneficiary Bank" vs "Bank Beneficiary").
 *   • Normalised Levenshtein ratio (1 − editDistance/maxLen) — resilient to the
 *     dominant NCRP failure: single-character typos / OCR drift / transpositions
 *     inside an otherwise-known spelling, where Dice alone dips below the floor
 *     (e.g. "Transcation Amount" → Dice 0.81 but Lev-ratio 0.88).
 * Taking the max lets EITHER strength rescue a header while the shared 0.85
 * floor + ambiguity guard keep a wrong guess from ever being accepted. Both
 * scores are length-normalised so one threshold behaves consistently across
 * "AEPS" and "Account No./ (Wallet /PG/PA) Id".
 *
 * @module backend/src/parsers/parseFuzzy
 */

const HEADER_SYNONYMS = require('../config/header_synonyms.json');

// ─── Thresholds ──────────────────────────────────────────────────────

/**
 * Minimum Dice similarity (0–1) for a fuzzy resolution to be accepted. 0.85 ==
 * the spec's ">= 85% similarity" floor. Below this, the resolver returns null
 * and the caller fails loud / degrades — never a silent bad parse.
 *
 * @type {number}
 */
const FUZZY_THRESHOLD = 0.85;

/**
 * Minimum score gap between the best match and the best DIFFERENT-canonical
 * runner-up for the best match to be trusted. If two distinct canonical fields
 * (or two distinct sheet categories) both clear the threshold and sit within
 * this margin, the match is ambiguous and we refuse to guess.
 *
 * @type {number}
 */
const AMBIGUITY_MARGIN = 0.10;

// ─── String normalisation (self-contained; mirrors ncrpParser loose form) ──

/**
 * Strip a leading UTF-8 BOM, if present.
 * @param {string} str
 * @returns {string}
 */
function stripBOM(str) {
  if (typeof str !== 'string' || str.length === 0) return str;
  return str.charCodeAt(0) === 0xFEFF ? str.slice(1) : str;
}

/**
 * Loose normalisation used for similarity scoring: strip BOM, lowercase, and
 * remove every character that is not a Latin letter, digit, or Devanagari
 * letter. Deliberately identical in spirit to ncrpParser's normalizeHeaderLoose
 * so the fuzzy tier scores the SAME canonical form the loose tier already tried
 * (and missed on) — the only difference is exact-equality vs Dice similarity.
 *
 * @param {unknown} value
 * @returns {string}
 */
function normalizeLoose(value) {
  if (value === null || value === undefined) return '';
  return stripBOM(String(value))
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9ऀ-ॿ]+/g, '');
}

// ─── Sørensen–Dice coefficient over character bigrams ──────────────────

/**
 * Build the multiset of adjacent character bigrams of a string, as a Map of
 * bigram → count.
 *
 * @param {string} s - Already loose-normalised.
 * @returns {Map<string, number>}
 */
function bigramCounts(s) {
  const counts = new Map();
  for (let i = 0; i < s.length - 1; i++) {
    const bg = s.slice(i, i + 2);
    counts.set(bg, (counts.get(bg) || 0) + 1);
  }
  return counts;
}

/**
 * Sørensen–Dice similarity (0–1) between two strings, computed over their
 * loose-normalised character-bigram multisets.
 *
 *   dice = 2 · |A ∩ B| / (|A| + |B|)
 *
 * Edge cases:
 *   • Both normalise to the same string → 1 (covers identical and sub-2-char
 *     equal inputs, where no bigram exists).
 *   • Either normalises to < 2 characters and they differ → 0 (no shared
 *     bigram is possible; refuse to over-credit a single-character overlap).
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} similarity in [0, 1].
 */
function diceCoefficient(a, b) {
  const sa = normalizeLoose(a);
  const sb = normalizeLoose(b);
  if (sa === '' && sb === '') return 1;
  if (sa === sb) return 1;
  if (sa.length < 2 || sb.length < 2) return 0;

  const ca = bigramCounts(sa);
  const cb = bigramCounts(sb);
  let intersection = 0;
  for (const [bg, na] of ca) {
    const nb = cb.get(bg);
    if (nb) intersection += Math.min(na, nb);
  }
  return (2 * intersection) / (sa.length - 1 + (sb.length - 1));
}

/**
 * Levenshtein edit distance between two strings (single-character insertions,
 * deletions, substitutions). Two-row dynamic programming — O(m·n) time, O(min)
 * space. Operates on the raw strings passed in; {@link levenshteinRatio} feeds
 * it the loose-normalised forms.
 *
 * @param {string} a
 * @param {string} b
 * @returns {number} edit distance (>= 0).
 */
function levenshtein(a, b) {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    const ai = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = ai === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev; prev = curr; curr = tmp;
  }
  return prev[n];
}

/**
 * Normalised Levenshtein similarity (0–1) over the loose-normalised forms:
 *   ratio = 1 − editDistance / max(|A|, |B|)
 *
 * Edge cases mirror {@link diceCoefficient}: equal-after-normalise → 1; one side
 * empty and the other not → 0.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} similarity in [0, 1].
 */
function levenshteinRatio(a, b) {
  const sa = normalizeLoose(a);
  const sb = normalizeLoose(b);
  if (sa === '' && sb === '') return 1;
  if (sa === sb) return 1;
  const maxLen = Math.max(sa.length, sb.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(sa, sb) / maxLen;
}

/**
 * Combined similarity (0–1): the MAX of the Dice-bigram and normalised-
 * Levenshtein scores. This is the metric {@link bestMatch} uses. Taking the max
 * means either metric's strength (Dice for reordering, Levenshtein for in-word
 * typos) can rescue a header, while the threshold + ambiguity guard prevent a
 * wrong acceptance.
 *
 * @param {unknown} a
 * @param {unknown} b
 * @returns {number} similarity in [0, 1].
 */
function similarity(a, b) {
  return Math.max(diceCoefficient(a, b), levenshteinRatio(a, b));
}

// ─── Generic best-match with threshold + ambiguity guard ───────────────

/**
 * @typedef {Object} FuzzyTarget
 * @property {string} label - Reference spelling to score the candidate against.
 * @property {string} value - The canonical value this label resolves to
 *                            (canonical field name, or sheet category).
 */

/**
 * @typedef {Object} FuzzyMatch
 * @property {string} value      - The resolved canonical value.
 * @property {string} matched    - The reference label that scored best.
 * @property {number} confidence - Dice similarity of the winning label (0–1).
 * @property {number} runnerUp   - Best score among targets of a DIFFERENT value.
 */

/**
 * Score `candidate` against every target and return the best resolution, or
 * null when nothing clears {@link FUZZY_THRESHOLD} or the result is ambiguous.
 *
 * Targets that share the winning `value` (e.g. several synonyms of the same
 * canonical field) never make a result ambiguous — only a high-scoring target
 * of a DIFFERENT value does.
 *
 * @param {unknown} candidate
 * @param {ReadonlyArray<FuzzyTarget>} targets
 * @param {{ threshold?: number, margin?: number }} [opts]
 * @returns {FuzzyMatch|null}
 */
function bestMatch(candidate, targets, opts = {}) {
  const threshold = opts.threshold === undefined ? FUZZY_THRESHOLD : opts.threshold;
  const margin = opts.margin === undefined ? AMBIGUITY_MARGIN : opts.margin;
  if (!Array.isArray(targets) || targets.length === 0) return null;
  const norm = normalizeLoose(candidate);
  if (norm === '') return null;

  let best = null;          // { value, matched, confidence }
  let bestOtherValue = 0;   // best score among targets whose value !== best.value

  for (const t of targets) {
    if (!t || typeof t.label !== 'string') continue;
    const score = similarity(norm, t.label);
    if (best === null || score > best.confidence) {
      // Demote the previous best into the "other value" pool if it differs.
      if (best !== null && best.value !== t.value) {
        bestOtherValue = Math.max(bestOtherValue, best.confidence);
      }
      best = { value: t.value, matched: t.label, confidence: score };
    } else if (t.value !== best.value) {
      bestOtherValue = Math.max(bestOtherValue, score);
    }
  }

  if (best === null || best.confidence < threshold) return null;
  // Ambiguity guard: a different canonical value also cleared the bar and is
  // too close to call. Refuse rather than risk the wrong channel/column.
  if (bestOtherValue >= threshold && best.confidence - bestOtherValue < margin) {
    return null;
  }
  return { value: best.value, matched: best.matched, confidence: best.confidence, runnerUp: bestOtherValue };
}

// ─── Canonical sheet registry (fuzzy targets) ──────────────────────────

/**
 * Sheet-category string constants. MUST match ncrpParser's SHEET_CATEGORY enum
 * values exactly (verified by a cross-check unit test). Kept as local literals
 * so this module has no dependency on the parser (avoids a require cycle).
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
  OLD_TRANSACTION: 'OLD_TRANSACTION',
});

/**
 * Known sheet spellings per channel, used purely as fuzzy reference labels.
 * These are NOT new channels — fuzzy can only ever resolve an unrecognised
 * sheet name ONTO one of these known categories. A name that matches none of
 * them above the threshold stays unknown, and the parser's existing unknown-
 * sheet policy (skip / consequence-scoped hard-fail) applies untouched.
 *
 * Deliberately conservative: the real spellings plus a few high-confidence
 * variants. Over-broad aliases here would risk pulling a genuine "Other" sheet
 * into a money channel, so new entries must be obvious typo/spacing neighbours
 * of a real NCRP tab name.
 *
 * @type {ReadonlyArray<{ category: string, aliases: ReadonlyArray<string> }>}
 */
const SHEET_REGISTRY = Object.freeze([
  { category: SHEET_CATEGORY.TRANSFER, aliases: ['money transfer to', 'money transfer', 'money transferred'] },
  { category: SHEET_CATEGORY.ATM, aliases: ['withdrawal through atm', 'atm withdrawal', 'atm withdrawals'] },
  { category: SHEET_CATEGORY.POS, aliases: ['withdrawal through pos', 'pos withdrawal', 'pos withdrawals'] },
  { category: SHEET_CATEGORY.AEPS, aliases: ['aeps', 'withdrawal through aeps'] },
  { category: SHEET_CATEGORY.HOLD, aliases: ['transaction put on hold', 'transactions put on hold', 'put on hold'] },
  { category: SHEET_CATEGORY.OTHER, aliases: ['others less then 500', 'others less than 500'] },
  { category: SHEET_CATEGORY.OLD_TRANSACTION, aliases: ['old transaction', 'old transactions'] },
]);

/** Flattened {label, value} sheet targets, built once. @type {FuzzyTarget[]} */
const SHEET_TARGETS = (() => {
  const out = [];
  for (const entry of SHEET_REGISTRY) {
    for (const alias of entry.aliases) out.push({ label: alias, value: entry.category });
  }
  return Object.freeze(out);
})();

/**
 * Fuzzy-resolve a sheet name to one of the known channel categories.
 *
 * @param {unknown} sheetName
 * @returns {{ category: string, matched: string, confidence: number }|null}
 *   null when no category clears the threshold (or the match is ambiguous).
 */
function resolveSheetCategoryFuzzy(sheetName) {
  const m = bestMatch(sheetName, SHEET_TARGETS);
  if (m === null) return null;
  return { category: m.value, matched: m.matched, confidence: m.confidence };
}

// ─── Canonical column registry (fuzzy targets from header synonyms) ─────

/**
 * Flattened {label, value} column targets: every synonym (and the canonical
 * name itself) from header_synonyms.json, labelled with the canonical field it
 * resolves to. Built once at load. The data is the SAME synonym list the exact
 * + loose tiers consult, so the fuzzy tier degrades smoothly from them.
 *
 * @type {ReadonlyArray<FuzzyTarget>}
 */
const COLUMN_TARGETS = (() => {
  const out = [];
  for (const [canonical, synonyms] of Object.entries(HEADER_SYNONYMS)) {
    out.push({ label: canonical, value: canonical });
    for (const syn of synonyms) out.push({ label: syn, value: canonical });
  }
  return Object.freeze(out);
})();

/**
 * Fuzzy-resolve a single column header to a canonical schema field.
 *
 * The caller passes ONLY headers that the exact + loose tiers failed to map,
 * and should skip the result if `canonical` is already mapped on the sheet
 * (first-wins, exactly as detectColumnMapping does today).
 *
 * @param {unknown} header
 * @returns {{ canonical: string, matched: string, confidence: number }|null}
 *   null when no canonical field clears the threshold (or the match is ambiguous).
 */
function resolveColumnFuzzy(header) {
  const m = bestMatch(header, COLUMN_TARGETS);
  if (m === null) return null;
  return { canonical: m.value, matched: m.matched, confidence: m.confidence };
}

// ─── Exports ───────────────────────────────────────────────────────────

module.exports = {
  // High-level resolvers (what the parser calls on the fallback path).
  resolveColumnFuzzy,
  resolveSheetCategoryFuzzy,
  // Thresholds.
  FUZZY_THRESHOLD,
  AMBIGUITY_MARGIN,
  // Primitives + registries — exported for isolated unit testing.
  diceCoefficient,
  levenshtein,
  levenshteinRatio,
  similarity,
  normalizeLoose,
  bestMatch,
  SHEET_CATEGORY,
  SHEET_REGISTRY,
  SHEET_TARGETS,
  COLUMN_TARGETS,
};
