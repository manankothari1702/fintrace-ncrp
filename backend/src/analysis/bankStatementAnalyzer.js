'use strict';

/**
 * FinTrace Bank Statement module — SINGLE-STATEMENT analysis engine.
 *
 * Computes what one account's ledger + its extracted counterparties
 * genuinely support: in/out aggregation, counterparty distribution, top-N
 * rankings, and single-account behavioral flags. Nothing here builds
 * cross-statement graphs, layers, or multi-hop tracing — that requires
 * multiple linked statements and is a later milestone by design.
 *
 * Deliberately its own engine, separate from the NCRP analyzer: the data
 * shape is different (one account's ledger with extracted counterparties —
 * no layer_no/victim/beneficiary structure), and NCRP's velocity/same-day
 * logic is entangled with that structure rather than being extractable pure
 * helpers. What IS reused from NCRP are its conventions: value + plain-
 * language "why" on every flag, named tunable thresholds in a config module
 * (bankStatementThresholds), analysis computed once and cached as JSON on
 * the parent row (analysis_json), and honesty-first presentation.
 *
 * ── Counterparty grouping (explicit keying rules) ──
 * Transactions group under the BEST available identifier, in priority
 * order: VPA (strongest — bank-issued handle), then phone (IMPS), then
 * IFSC+name (NEFT/RTGS), then IFSC alone, then bare name (weakest — PNB
 * truncates names at 8 chars, so name-only keys are only used when nothing
 * better exists). LOW-confidence extractions are namespaced (`low|…`) so
 * they group among themselves but can NEVER merge into a high-confidence
 * identity — a partial parse must not contaminate a solid one. Rows with a
 * low-confidence parse and no identifier at all are counted as
 * `unattributed`, and non-counterparty rows (interest/charges/unknown
 * formats — confidence 'none') stay out of the distribution entirely.
 *
 * ── Timing granularity ──
 * Statement dates carry no time-of-day, so every timing signal (rapid
 * transactions, pass-through) is computed at DAY granularity and says so in
 * its "why" text. No intra-day velocity is ever claimed.
 *
 * @module backend/src/analysis/bankStatementAnalyzer
 */

const T = require('../config/bankStatementThresholds');

/** Engine version stamped into every result (cache-busting on upgrades). */
const ENGINE_VERSION = 1;

// ─── Small math helpers (local; NCRP's equivalents are not exported) ──

/** Round to 2 decimals for money output. */
const round2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

/** 'YYYY-MM-DD' day key from an ISO string (UTC — statement wall-clock). */
const dayKey = (iso) => (typeof iso === 'string' && iso.length >= 10 ? iso.slice(0, 10) : null);

/** Net movement of one row from the account's perspective. */
const netOf = (t) => (t.credit_amount || 0) - (t.debit_amount || 0);

// ─── Ledger orientation ──────────────────────────────────────────────

/**
 * Determine whether the rows (in file order) run newest-first (PNB style)
 * or oldest-first, from the first differing pair of dates.
 *
 * @param {Array<object>} txns - rows in file order.
 * @returns {'newest-first'|'oldest-first'|'unknown'}
 */
function ledgerOrder(txns) {
  for (let i = 1; i < txns.length; i++) {
    const a = txns[i - 1].txn_date;
    const b = txns[i].txn_date;
    if (a && b && a !== b) return a > b ? 'newest-first' : 'oldest-first';
  }
  return 'unknown';
}

// ─── Summary (in/out aggregation) ────────────────────────────────────

/**
 * Account-level headline numbers. total_credit / total_debit MUST
 * reconcile exactly with the ingestion-level sums — that is this
 * milestone's correctness anchor (tested against the PNB fixture's
 * 85 debits ₹50,196.00 / 11 credits ₹43,852.00).
 *
 * @param {object} statement - bank_statements row (may be partial in tests).
 * @param {Array<object>} txns - canonical rows in file order.
 */
function buildSummary(statement, txns) {
  let totalCredit = 0;
  let totalDebit = 0;
  let creditCount = 0;
  let debitCount = 0;
  let lowConfidence = 0;
  let nonCounterparty = 0;

  for (const t of txns) {
    if (t.credit_amount !== null && t.credit_amount !== undefined) {
      totalCredit += t.credit_amount;
      creditCount += 1;
    }
    if (t.debit_amount !== null && t.debit_amount !== undefined) {
      totalDebit += t.debit_amount;
      debitCount += 1;
    }
    if (t.extraction_confidence === 'low') lowConfidence += 1;
    if (t.extraction_confidence === 'none') nonCounterparty += 1;
  }

  const order = ledgerOrder(txns);
  let openingBalance = null;
  let closingBalance = null;
  if (txns.length > 0 && order !== 'unknown') {
    const newest = order === 'newest-first' ? txns[0] : txns[txns.length - 1];
    const oldest = order === 'newest-first' ? txns[txns.length - 1] : txns[0];
    if (newest.balance !== null && newest.balance !== undefined) {
      closingBalance = round2(newest.balance);
    }
    if (oldest.balance !== null && oldest.balance !== undefined) {
      // The stored balance is AFTER the row's movement; opening precedes it.
      openingBalance = round2(oldest.balance - netOf(oldest));
    }
  }

  const dates = txns.map((t) => t.txn_date).filter(Boolean).sort();
  return {
    total_credit: round2(totalCredit),
    total_debit: round2(totalDebit),
    net_flow: round2(totalCredit - totalDebit),
    credit_count: creditCount,
    debit_count: debitCount,
    txn_count: txns.length,
    period_from: statement.statement_period_from || dates[0] || null,
    period_to: statement.statement_period_to || dates[dates.length - 1] || null,
    opening_balance: openingBalance,
    closing_balance: closingBalance,
    ledger_order: order,
    low_confidence_count: lowConfidence,
    non_counterparty_count: nonCounterparty,
  };
}

// ─── Counterparty distribution ───────────────────────────────────────

/** Normalise a name for keying/display comparison. */
const normName = (s) => String(s || '').replace(/\s+/g, ' ').trim().toUpperCase();

/**
 * Grouping key for one transaction's counterparty, or null when there is
 * no usable identifier (see module doc for the priority + low-confidence
 * namespacing rules).
 *
 * @param {object} t - enriched transaction row.
 * @returns {{ key: string, idKind: string, low: boolean }|null}
 */
function counterpartyKeyOf(t) {
  if (t.extraction_confidence === 'none') return null; // no counterparty by nature
  const vpa = t.counterparty_vpa ? String(t.counterparty_vpa).toLowerCase() : null;
  const phone = t.counterparty_phone ? String(t.counterparty_phone) : null;
  const ifsc = t.counterparty_ifsc ? String(t.counterparty_ifsc).toUpperCase() : null;
  const name = t.counterparty_name ? normName(t.counterparty_name) : null;

  let base = null;
  let idKind = null;
  if (vpa) { base = `vpa:${vpa}`; idKind = 'vpa'; }
  else if (phone) { base = `phone:${phone}`; idKind = 'phone'; }
  else if (ifsc && name) { base = `ifsc:${ifsc}|name:${name}`; idKind = 'ifsc+name'; }
  else if (ifsc) { base = `ifsc:${ifsc}`; idKind = 'ifsc'; }
  else if (name) { base = `name:${name}`; idKind = 'name'; }
  if (!base) return null;

  const low = t.extraction_confidence === 'low';
  return { key: low ? `low|${base}` : base, idKind, low };
}

/**
 * Group transactions into per-counterparty aggregates.
 *
 * @param {Array<object>} txns
 * @returns {{ counterparties: Array<object>, unattributed_count: number }}
 */
function buildCounterparties(txns) {
  const groups = new Map();
  let unattributed = 0;

  for (const t of txns) {
    if (t.extraction_confidence === 'none') continue; // interest/charges/unknown
    const keyed = counterpartyKeyOf(t);
    if (!keyed) { unattributed += 1; continue; }

    let g = groups.get(keyed.key);
    if (!g) {
      g = {
        key: keyed.key,
        id_kind: keyed.idKind,
        confidence: keyed.low ? 'low' : 'high',
        nameCounts: new Map(),
        vpa: null,
        ifsc: null,
        bank_code: null,
        phone: null,
        sent_total: 0,
        received_total: 0,
        sent_count: 0,
        received_count: 0,
        txn_count: 0,
        first_seen: null,
        last_seen: null,
        txn_ids: [],
      };
      groups.set(keyed.key, g);
    }

    const name = t.counterparty_name ? normName(t.counterparty_name) : null;
    if (name) g.nameCounts.set(name, (g.nameCounts.get(name) || 0) + 1);
    if (!g.vpa && t.counterparty_vpa) g.vpa = t.counterparty_vpa;
    if (!g.ifsc && t.counterparty_ifsc) g.ifsc = t.counterparty_ifsc;
    if (!g.bank_code && t.counterparty_bank_code) g.bank_code = t.counterparty_bank_code;
    if (!g.phone && t.counterparty_phone) g.phone = t.counterparty_phone;

    if (t.debit_amount !== null && t.debit_amount !== undefined) {
      g.sent_total += t.debit_amount;
      g.sent_count += 1;
    }
    if (t.credit_amount !== null && t.credit_amount !== undefined) {
      g.received_total += t.credit_amount;
      g.received_count += 1;
    }
    g.txn_count += 1;
    if (t.txn_date) {
      if (!g.first_seen || t.txn_date < g.first_seen) g.first_seen = t.txn_date;
      if (!g.last_seen || t.txn_date > g.last_seen) g.last_seen = t.txn_date;
    }
    const rowId = t.id !== undefined ? t.id : t.source_row;
    if (rowId !== undefined && rowId !== null) g.txn_ids.push(rowId);
  }

  const counterparties = [...groups.values()].map((g) => {
    // Display name: the name most often seen with this identifier (VPAs can
    // surface under more than one truncated payee label); alternates kept.
    const namesByFreq = [...g.nameCounts.entries()].sort((a, b) => b[1] - a[1]);
    const { nameCounts, ...rest } = g;
    return {
      ...rest,
      display_name: namesByFreq.length > 0 ? namesByFreq[0][0] : null,
      names: namesByFreq.map(([n]) => n),
      sent_total: round2(g.sent_total),
      received_total: round2(g.received_total),
      net: round2(g.received_total - g.sent_total),
      volume: round2(g.sent_total + g.received_total),
    };
  });

  counterparties.sort((a, b) => b.volume - a.volume || b.txn_count - a.txn_count);
  return { counterparties, unattributed_count: unattributed };
}

/**
 * Top-N rankings — by total volume and, separately, by frequency.
 *
 * @param {Array<object>} counterparties - already volume-sorted.
 * @returns {{ by_amount: string[], by_frequency: string[] }} counterparty keys.
 */
function rankTop(counterparties) {
  const byAmount = counterparties.slice(0, T.TOP_N).map((c) => c.key);
  const byFrequency = [...counterparties]
    .sort((a, b) => b.txn_count - a.txn_count || b.volume - a.volume)
    .slice(0, T.TOP_N)
    .map((c) => c.key);
  return { by_amount: byAmount, by_frequency: byFrequency };
}

// ─── Entry point ─────────────────────────────────────────────────────

/**
 * Analyze one statement. Pure computation — no DB access; callers persist
 * the result (bank_statements.analysis_json) and serve it cached.
 *
 * @param {object} statement - bank_statements row (id/period fields used).
 * @param {Array<object>} transactions - the statement's canonical rows, in
 *   file order, WITH the m3 counterparty extraction fields present.
 * @returns {object} analysis document (JSON-serialisable).
 */
function analyzeStatement(statement, transactions) {
  const txns = Array.isArray(transactions) ? transactions : [];
  const summary = buildSummary(statement || {}, txns);
  const { counterparties, unattributed_count } = buildCounterparties(txns);
  const top = rankTop(counterparties);

  return {
    engine_version: ENGINE_VERSION,
    summary,
    counterparties,
    unattributed_count,
    top_by_amount: top.by_amount,
    top_by_frequency: top.by_frequency,
    low_confidence_counterparty_count: counterparties.filter((c) => c.confidence === 'low').length,
    thresholds: { ...T },
  };
}

module.exports = {
  analyzeStatement,
  ENGINE_VERSION,
  // Exposed for unit tests; not part of the public contract.
  _internals: Object.freeze({
    buildSummary, buildCounterparties, counterpartyKeyOf, rankTop, ledgerOrder, dayKey, round2,
  }),
};
