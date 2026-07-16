'use strict';

/**
 * FinTrace Bank Statement module — counterparty extraction from narration.
 *
 * Turns a bank-formatted narration string into structured counterparty
 * fields. This is EXTRACTION ONLY: no analysis, no aggregation, no bank-name
 * resolution — the raw narration is always kept alongside, and every field
 * is either confidently parsed or NULL. A wrong counterparty in an
 * investigation tool is worse than a blank one, so nothing is ever inferred
 * beyond what the narration literally states (same fail-loud/mark-uncertain
 * principle as the NCRP parser).
 *
 * ── Architecture ──
 * One dispatcher over an ordered list of per-channel extractors, each
 * `{ channel, test(narration), extract(narration) }`. The first extractor
 * whose `test` matches owns the narration; no match → channel OTHER with
 * every field NULL. Supporting another bank's narration grammar later means
 * APPENDING extractors (or channel variants), never rewriting the engine.
 *
 * ── PNB grammars implemented (verified against the committed fixture) ──
 *   UPI    UPI/{DR|CR}/{rrn}/{name}/{bank code}/{vpa}/{tail…}
 *          Name and VPA are TRUNCATED BY THE BANK at fixed field widths
 *          ("RAM BAHA", "paytm.s267plo@p") — captured as-is, never
 *          reconstructed. The tail is a remnant of "Payment"/"UPI".
 *   IMPS   IMPS-IN/{ref}/{phone}/{name}   (also accepts IMPSIN/, IMPS_IN/)
 *   NEFT   NEFT_IN:{seq}{sender ref}{IFSC}//{sender ref}/{name}
 *          The head is CONCATENATED without separators, and a greedy IFSC
 *          regex scan can hallucinate one across token boundaries (e.g.
 *          "…HDFCH01060851299…" contains the false match "DFCH0106085"), so
 *          the IFSC is only accepted ANCHORED to the end of the pre-`//`
 *          head. RTGS shares this grammar.
 *   INTEREST / CHARGE / CASH — internal, non-counterparty postings
 *          (e.g. "…:Int.Pd:01-03-2026 to 31-05-2026"): channel classified,
 *          all counterparty fields NULL, confidence 'none'.
 *
 * PDF-sourced narrations may carry stray spaces where wrapped lines were
 * rejoined ("paytm.s267 plo@p"). Tokens that can never contain whitespace
 * (refs, bank codes, VPAs, phones, IFSCs) are de-spaced; names keep their
 * (collapsed) spaces because names really do contain them.
 *
 * ── Confidence ──
 *   'high'  every structural field of the channel grammar parsed cleanly;
 *   'low'   the channel matched but the row is partial/malformed — only the
 *           individually-valid fields are kept, the rest are NULL;
 *   'none'  no counterparty exists (interest/charges/internal) or the
 *           narration matches no known grammar (channel OTHER).
 *
 * @module backend/src/parsers/bankStatement/counterparty
 */

// ─── Field normalisers ───────────────────────────────────────────────

/** Remove ALL whitespace — for tokens that can never legally contain it. */
const deSpace = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, '');

/** Collapse runs of whitespace — for names, which do contain spaces. */
const collapse = (s) => String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();

/** Standard IFSC shape: 4 letters + '0' + 6 alphanumerics. */
const RE_IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Empty extraction result (channel/confidence filled by the caller). */
const EMPTY_FIELDS = Object.freeze({
  counterparty_name: null,
  counterparty_bank_code: null,
  counterparty_ifsc: null,
  counterparty_vpa: null,
  counterparty_phone: null,
});

// ─── Per-channel extractors ──────────────────────────────────────────

/**
 * UPI: UPI/{DR|CR}/{rrn}/{name}/{bank code}/{vpa}/{tail…}
 * High confidence requires all six structural parts, a plausible numeric
 * RRN, a 4-letter bank code, a non-empty name and a non-empty VPA field.
 */
function extractUpi(narration) {
  const parts = narration.split('/');
  const fields = { ...EMPTY_FIELDS };
  let clean = parts.length >= 6;

  const direction = parts.length > 1 ? deSpace(parts[1]).toUpperCase() : '';
  if (!/^(DR|CR)$/.test(direction)) clean = false;

  const rrn = parts.length > 2 ? deSpace(parts[2]) : '';
  if (!/^\d{6,}$/.test(rrn)) clean = false;

  const name = parts.length > 3 ? collapse(parts[3]) : '';
  if (name !== '') fields.counterparty_name = name; else clean = false;

  const bankCode = parts.length > 4 ? deSpace(parts[4]).toUpperCase() : '';
  if (/^[A-Z]{4}$/.test(bankCode)) fields.counterparty_bank_code = bankCode; else clean = false;

  // The VPA field is whatever the bank recorded — frequently truncated
  // ("paytm.s267plo@p", "gpay-1125954981"). Captured verbatim (de-spaced);
  // no attempt to complete the handle.
  const vpa = parts.length > 5 ? deSpace(parts[5]) : '';
  if (vpa !== '') fields.counterparty_vpa = vpa; else clean = false;

  return { fields, confidence: clean ? 'high' : 'low' };
}

/**
 * IMPS: IMPS-IN/{ref}/{phone}/{name} (separator variants tolerated).
 */
function extractImps(narration) {
  const parts = narration.split('/');
  const fields = { ...EMPTY_FIELDS };
  let clean = parts.length >= 4;

  const ref = parts.length > 1 ? deSpace(parts[1]) : '';
  if (!/^\d{6,}$/.test(ref)) clean = false;

  const phone = parts.length > 2 ? deSpace(parts[2]) : '';
  if (/^\d{10,12}$/.test(phone)) fields.counterparty_phone = phone; else clean = false;

  const name = parts.length > 3 ? collapse(parts.slice(3).join('/')) : '';
  if (name !== '') fields.counterparty_name = name; else clean = false;

  return { fields, confidence: clean ? 'high' : 'low' };
}

/**
 * NEFT / RTGS: {PREFIX}:{seq}{sender ref}{IFSC}//{sender ref}/{name}
 *
 * The IFSC is accepted ONLY when the 11 characters at the END of the
 * pre-`//` head match the IFSC shape — a greedy scan across the
 * concatenated head can fabricate one spanning token boundaries, and a
 * fabricated IFSC is exactly what this module must never produce. When the
 * anchored check fails the IFSC stays NULL and confidence drops to 'low'.
 * The bank code is the IFSC's own first four letters (definitional, not a
 * lookup).
 */
function extractNeftRtgs(narration) {
  const fields = { ...EMPTY_FIELDS };
  let clean = true;

  const colonIdx = narration.indexOf(':');
  const body = colonIdx === -1 ? '' : narration.slice(colonIdx + 1);
  const sepIdx = body.indexOf('//');
  if (sepIdx === -1) {
    return { fields, confidence: 'low' };
  }

  const head = deSpace(body.slice(0, sepIdx));
  const tailParts = body.slice(sepIdx + 2).split('/');

  const ifscCandidate = head.slice(-11).toUpperCase();
  if (RE_IFSC.test(ifscCandidate)) {
    fields.counterparty_ifsc = ifscCandidate;
    fields.counterparty_bank_code = ifscCandidate.slice(0, 4);
  } else {
    clean = false;
  }

  // tail = {sender ref}/{name…}; the name may itself contain '/'.
  const name = collapse(tailParts.slice(1).join('/'));
  if (name !== '') fields.counterparty_name = name; else clean = false;

  return { fields, confidence: clean ? 'high' : 'low' };
}

/** Non-counterparty postings: classified, never force-extracted. */
const nonCounterparty = () => ({ fields: { ...EMPTY_FIELDS }, confidence: 'none' });

/**
 * Ordered extractor registry — the dispatcher walks this list and the first
 * `test` hit wins. Adding another bank's grammar = appending entries here.
 * Anchored channel prefixes come first; loose non-counterparty classifiers
 * after; anything unmatched falls through to OTHER.
 *
 * @type {ReadonlyArray<{ channel: string,
 *   test: (narration: string) => boolean,
 *   extract: (narration: string) => { fields: object, confidence: string } }>}
 */
// Channel-prefix tests tolerate stray whitespace INSIDE the prefix: PDF
// narrations are reassembled from wrapped lines, and the wrap can fall mid-
// token ("IMPS- IN/…" in the real fixture). Recognising the channel through
// that seam is still identification, not guessing.
const EXTRACTORS = Object.freeze([
  { channel: 'UPI', test: (n) => /^UPI\s*\//i.test(n), extract: extractUpi },
  { channel: 'IMPS', test: (n) => /^IMPS[-_\s]*IN\b/i.test(n), extract: extractImps },
  { channel: 'NEFT', test: (n) => /^NEFT[-_\s]*(IN|OUT)?\b/i.test(n), extract: extractNeftRtgs },
  { channel: 'RTGS', test: (n) => /^RTGS[-_\s]*(IN|OUT)?\b/i.test(n), extract: extractNeftRtgs },
  { channel: 'INTEREST', test: (n) => /:Int\.?\s*Pd\s*:/i.test(n) || /^INTEREST\b/i.test(n), extract: nonCounterparty },
  { channel: 'CHARGE', test: (n) => /\bCHRG\b|\bCHARGES?\b|\bLF\s*CHG\b|\bSMS\s*ALERT\b/i.test(n), extract: nonCounterparty },
  { channel: 'CASH', test: (n) => /^CSH\b|\bCASH\s*(DEP|WDL|DEPOSIT|WITHDRAWAL)\b/i.test(n), extract: nonCounterparty },
]);

// ─── Dispatcher ──────────────────────────────────────────────────────

/**
 * Extract structured counterparty fields from one narration string.
 *
 * @param {unknown} narration - raw narration (kept untouched by callers).
 * @returns {{ txn_channel: string, extraction_confidence: 'high'|'low'|'none',
 *   counterparty_name: string|null, counterparty_bank_code: string|null,
 *   counterparty_ifsc: string|null, counterparty_vpa: string|null,
 *   counterparty_phone: string|null }}
 */
function extractCounterparty(narration) {
  const text = typeof narration === 'string' ? narration.trim() : '';
  if (text !== '') {
    for (const { channel, test, extract } of EXTRACTORS) {
      if (!test(text)) continue;
      const { fields, confidence } = extract(text);
      return { txn_channel: channel, extraction_confidence: confidence, ...fields };
    }
  }
  return { txn_channel: 'OTHER', extraction_confidence: 'none', ...EMPTY_FIELDS };
}

/**
 * Enrich parsed canonical transactions with counterparty fields, in place
 * of nothing — the original keys (narration included) are never modified.
 *
 * @param {Array<object>} transactions
 * @returns {Array<object>} new array of enriched copies.
 */
function enrichTransactions(transactions) {
  return transactions.map((t) => ({ ...t, ...extractCounterparty(t.narration) }));
}

/**
 * Coverage summary for a set of enriched transactions — the milestone's
 * honesty metric (how much was extracted vs left NULL, and why).
 *
 * @param {Array<object>} enriched
 * @returns {{ total: number, byChannel: Record<string, number>,
 *   byConfidence: Record<string, number>, withName: number, withVpa: number,
 *   withIfsc: number, withPhone: number, withBankCode: number,
 *   nonCounterparty: number }}
 */
function coverageSummary(enriched) {
  const summary = {
    total: enriched.length,
    byChannel: {},
    byConfidence: { high: 0, low: 0, none: 0 },
    withName: 0,
    withVpa: 0,
    withIfsc: 0,
    withPhone: 0,
    withBankCode: 0,
    nonCounterparty: 0,
  };
  for (const t of enriched) {
    summary.byChannel[t.txn_channel] = (summary.byChannel[t.txn_channel] || 0) + 1;
    summary.byConfidence[t.extraction_confidence] += 1;
    if (t.counterparty_name) summary.withName += 1;
    if (t.counterparty_vpa) summary.withVpa += 1;
    if (t.counterparty_ifsc) summary.withIfsc += 1;
    if (t.counterparty_phone) summary.withPhone += 1;
    if (t.counterparty_bank_code) summary.withBankCode += 1;
    if (t.extraction_confidence === 'none') summary.nonCounterparty += 1;
  }
  return summary;
}

module.exports = {
  extractCounterparty,
  enrichTransactions,
  coverageSummary,
  // Exposed for unit tests; not part of the public contract.
  _internals: Object.freeze({ extractUpi, extractImps, extractNeftRtgs, EXTRACTORS }),
};
