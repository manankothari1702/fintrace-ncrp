'use strict';

/**
 * FinTrace NCRP — core analysis engine.
 *
 * Consumes canonical transaction rows (the shape produced by
 * `parsers/ncrpParser.js` and persisted into `ncrp_transactions`) and runs
 * eight independent analysis modules over them, returning one structured
 * result object that the UI + report generator render directly.
 *
 * Design rules (carried from the rest of the backend):
 *   • CommonJS, synchronous compute. The single public entry point is async
 *     only so it can optionally write derived columns back to SQLite.
 *   • Every module is fault-isolated: if one throws, the failure is recorded
 *     in `result.errors` and the remaining modules still run. The analysis
 *     never crashes the caller.
 *   • All arithmetic tolerates null / undefined / NaN. Amounts default to 0,
 *     missing dates are skipped rather than poisoning aggregates.
 *   • dayjs (with the UTC plugin) handles every date computation. Calendar-day
 *     comparisons are done in IST (UTC+5:30) because NCRP is an Indian system
 *     and "same day" is an Indian-clock concept.
 *
 * The canonical row fields this engine reads:
 *   id, ack_no, complaint_date, victim_account, victim_bank,
 *   beneficiary_account, beneficiary_bank, beneficiary_name, ifsc_code,
 *   transaction_date, transaction_amount, disputed_amount, utr_no,
 *   payment_mode, layer_no, atm_id, atm_location, city, state, remarks.
 *
 * @module backend/src/analyzers/analyzer
 */

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

const MULE_WEIGHTS = require('../config/mule_weights.json');
const { updateTransactionCashout } = require('../db/queries');
const { computeCashedOut, POLICIES: CASHOUT_POLICIES } = require('../lib/cashoutPolicy');
const { detectCycles } = require('../analysis/cycleDetector');
const { analyzeConnectivity } = require('../analysis/connectivity');
const { dayOfWeekBreakdown } = require('../analysis/dayOfWeek');

/**
 * Cash-out counting policy (FinTrace v0.2.0). Fraud proceeds cashed out cannot
 * exceed what an account received as disputed funds, so the headline
 * `total_cashout_amount` is capped per account at its disputed inflow
 * (CAP_AT_RECEIVED). This is a single, named definition so the figure stops
 * drifting; see lib/cashoutPolicy.js. Flip to CASHOUT_POLICIES.RAW to restore
 * the uncapped legacy sum.
 */
const CASHOUT_POLICY = CASHOUT_POLICIES.CAP_AT_RECEIVED;

// ─── Constants ───────────────────────────────────────────────────────

/** IST is UTC+5:30. Used for "same calendar day" comparisons (FR-12). */
const IST_OFFSET_MINUTES = 330;

/** Cashout classifications (FR-11). */
const CASHOUT_MODE = Object.freeze({
  ATM: 'ATM_WITHDRAWAL',
  POS: 'POS_PURCHASE',
  UPI: 'UPI_TRANSFER_OUT',
  ONLINE: 'ONLINE_PURCHASE',
  UNKNOWN: 'UNKNOWN',
});

/** Modes whose cashout classification means money physically left the chain. */
const CASH_EXIT_MODES = Object.freeze(
  new Set([CASHOUT_MODE.ATM, CASHOUT_MODE.POS])
);

/**
 * Row kind — the fundamental distinction that makes FinTrace's numbers match a
 * forensic reading of an NCRP CompleteTrail export (and CypherSOL).
 *
 * A CompleteTrail file mixes two very different kinds of rows on its channel
 * sheets, and counting them all as "transactions" double-counts the same money:
 *
 *   • HOP   — a real fund movement between two DISTINCT accounts
 *             (beneficiary_account ≠ victim_account, from the "Money Transfer
 *             to" sheet). This is THE transaction — one laundering hop.
 *   • EXIT  — a cash exit (ATM / POS / AEPS withdrawal). A *disposition* of money
 *             already received, not a new transaction. Its account column is the
 *             account-under-investigation (folded into beneficiary_account by the
 *             parser's cross-sheet join, so beneficiary === victim).
 *   • HOLD  — funds frozen by the holding bank ("Transaction put on hold"). Also
 *             a disposition, also benef === victim.
 *   • OTHER — self-referential transfers (benef === victim, e.g. a wallet round-
 *             trip) and the misc "Other" / "Others Less Then 500" rows.
 *
 * Transaction counts, layer amounts, and the headline victim-loss are computed
 * over HOP rows only; EXIT / HOLD feed the recovery / lien view as dispositions.
 *
 * @enum {string}
 */
const ROW_KIND = Object.freeze({
  HOP: 'HOP',
  EXIT: 'EXIT',
  HOLD: 'HOLD',
  OTHER: 'OTHER',
});

/** Mule risk-label thresholds against the 0-100 score. */
const RISK_HIGH = 70;
const RISK_MEDIUM = 40;

/** Mule signal thresholds (the "what counts as suspicious" knobs). */
const PASS_THROUGH_FULL = 0.8;   // ratio at/above which pass-through scores full
const FAST_FORWARD_HOURS = 4;    // forwarded within this many hours → full speed pts
const SLOW_FORWARD_HOURS = 24;   // beyond this → no speed pts
const HIGH_TXN_COUNT = 10;       // > this many txns → full count pts

// ─── Small numeric / string helpers ──────────────────────────────────

/**
 * Coerce any value to a finite number, defaulting to 0. Strings with stray
 * formatting are not re-parsed here — the parser already produced numbers;
 * this is purely a NaN/null guard for defensive aggregation.
 *
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/**
 * Trim-or-null a possibly-missing string field.
 *
 * @param {unknown} v
 * @returns {string|null}
 */
function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/**
 * Coerce a layer value to a non-negative integer, tolerating numeric strings.
 * The parser already emits integers; this guards advanced callers that hand
 * the analyzer raw DB rows where the value arrived as text.
 *
 * @param {unknown} v
 * @returns {number}
 */
function layerOf(v) {
  if (Number.isInteger(v)) return v;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/** Canonical IFSC shape (4 letters, '0', 6 alphanumerics). */
const VALID_IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/**
 * Canonical account-identity key for de-duplicating rollup / data-quality
 * entries. The SAME bank account can appear zero-padded on one row and bare on
 * another (e.g. "00000044021519366" vs "44021519366"); both denote one account
 * and must aggregate once. We therefore strip leading zeros — but ONLY for
 * all-digit account numbers. Non-numeric identifiers (wallet / PG / PA labels
 * such as "NA", "Paytm", UPI handles) are returned verbatim and case-preserved,
 * so distinct placeholders (e.g. "NA" vs "Na") are never wrongly merged.
 *
 * @param {unknown} acc
 * @returns {string}
 */
function canonicalAccountKey(acc) {
  const s = String(acc ?? '').trim();
  if (!s) return s;
  if (/^\d+$/.test(s)) return s.replace(/^0+/, '') || '0';
  return s;
}

/**
 * Round to a fixed number of decimals without floating-point noise.
 *
 * @param {number} n
 * @param {number} [decimals=2]
 * @returns {number}
 */
function round(n, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round((num(n) + Number.EPSILON) * f) / f;
}

/**
 * Format an Indian-Rupee amount with Cr / L / K suffixes for officer-facing
 * findings (e.g. 420000 → "₹4.2L", 12500000 → "₹1.25Cr").
 *
 * @param {number} amount
 * @returns {string}
 */
function formatINR(amount) {
  const n = num(amount);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  /** @param {number} x */
  const trim = (x) => String(round(x, 2)).replace(/\.0+$/, '');
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${trim(abs / 1e3)}K`;
  return `${sign}₹${trim(abs)}`;
}

// ─── Date helpers ─────────────────────────────────────────────────────

/**
 * Parse an ISO date string to epoch milliseconds, or null if unparseable.
 *
 * @param {unknown} iso
 * @returns {number|null}
 */
function toMs(iso) {
  if (iso === null || iso === undefined) return null;
  const m = Date.parse(String(iso));
  return Number.isFinite(m) ? m : null;
}

/**
 * Difference in hours between two ISO instants (b − a). Returns null if
 * either instant is missing/unparseable.
 *
 * @param {unknown} aIso - The earlier instant.
 * @param {unknown} bIso - The later instant.
 * @returns {number|null}
 */
function diffHours(aIso, bIso) {
  const a = toMs(aIso);
  const b = toMs(bIso);
  if (a === null || b === null) return null;
  return (b - a) / 3_600_000;
}

/**
 * Calendar-day key (YYYY-MM-DD) in IST for an ISO instant. Two timestamps
 * share a "same day" iff this key matches. Returns null for bad input.
 *
 * @param {unknown} iso
 * @returns {string|null}
 */
function istDayKey(iso) {
  const m = toMs(iso);
  if (m === null) return null;
  return dayjs.utc(m).add(IST_OFFSET_MINUTES, 'minute').format('YYYY-MM-DD');
}

// ─── Cashout classification (FR-11) ───────────────────────────────────

/**
 * Classify a single transaction's cashout mode per FR-11.
 *
 *   • payment_mode contains 'ATM'/'AEPS' OR atm_id present → ATM_WITHDRAWAL
 *   • payment_mode contains 'POS'                    → POS_PURCHASE
 *   • payment_mode === 'UPI'                         → UPI_TRANSFER_OUT
 *   • payment_mode ∈ {IMPS, NEFT, RTGS}              → ONLINE_PURCHASE
 *   • otherwise                                      → UNKNOWN
 *
 * AEPS (Aadhaar-enabled biometric withdrawal at a banking correspondent) is a
 * physical cash exit, indistinguishable from an ATM withdrawal for recovery
 * purposes, so it is classified as ATM_WITHDRAWAL — this makes it count in the
 * cash-exit totals, same-day-cashout detection (FR-12), and layer cashout_count
 * with no other branch changes. The original 'AEPS' value is preserved in the
 * row's payment_mode for display/filtering.
 *
 * @param {Record<string, unknown>} txn
 * @returns {string} One of CASHOUT_MODE.
 */
function classifyCashoutMode(txn) {
  const mode = (str(txn.payment_mode) || '').toUpperCase();
  const hasAtm = str(txn.atm_id) !== null;
  if (mode.includes('ATM') || mode.includes('AEPS') || hasAtm) return CASHOUT_MODE.ATM;
  if (mode.includes('POS')) return CASHOUT_MODE.POS;
  if (mode === 'UPI') return CASHOUT_MODE.UPI;
  if (mode === 'IMPS' || mode === 'NEFT' || mode === 'RTGS') {
    return CASHOUT_MODE.ONLINE;
  }
  return CASHOUT_MODE.UNKNOWN;
}

/**
 * Classify a row into one of {@link ROW_KIND}. Order matters: a frozen-funds or
 * cash-exit row is a *disposition* even though its account columns look like a
 * transfer, so HOLD / EXIT are tested before the HOP (distinct-account) test.
 *
 * @param {Record<string, unknown>} t - A row already carrying `cashout_mode`.
 * @returns {string} One of ROW_KIND.
 */
function classifyRowKind(t) {
  const mode = (str(t.payment_mode) || '').toUpperCase();
  if (mode === 'HOLD') return ROW_KIND.HOLD;
  if (CASH_EXIT_MODES.has(t.cashout_mode)) return ROW_KIND.EXIT;
  const benef = str(t.beneficiary_account);
  const victim = str(t.victim_account);
  if (benef && benef !== victim) return ROW_KIND.HOP;
  return ROW_KIND.OTHER;
}

/**
 * Collapse rows that are an EXACT-DUPLICATE ledger row — the SAME money listed
 * twice (the same leg re-listed across channel sheets, or repeated within one
 * sheet). A row is a duplicate only when EVERY material field matches:
 * sender (victim_account), beneficiary_account, transaction_date,
 * transaction_amount, disputed_amount and utr_no. NCRP routinely re-lists one
 * leg; without this collapse the same rupees are counted two or three times in
 * every aggregate. Rows missing a UTR are never merged (the composite key would
 * be too loose), and the first occurrence of each key is kept.
 *
 * Both `victim_account` (the sender) and `disputed_amount` are part of the key
 * on purpose. UTR is NOT unique-per-transaction in these files — one UTR can
 * fan out to several distinct transfers (different sender/beneficiary/amount)
 * and one transfer can be apportioned across layers with DIFFERENT disputed
 * amounts. Keying on (beneficiary|date|amount|utr) alone silently dropped genuine
 * legs whose only difference from a sibling was the sender or the disputed
 * amount — e.g. case 32709's ₹409.56 hop (a UTR-563707902816 / ₹1400 leg whose
 * twin carried disputed ₹18.64) and case …145's ₹20,000 ATM cash-out (a
 * UTR-270324046951 leg whose siblings carried disputed ₹9,963.48 and ₹20,000).
 * Including sender + disputed keeps those distinct legs and collapses only
 * byte-identical duplicates.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows - Enriched rows.
 * @returns {{ rows: Array<Record<string, unknown>>, removed: number }}
 */
function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  let removed = 0;
  for (const r of rows) {
    const utr = str(r.utr_no);
    // Only merge when a UTR is present — a row with no UTR has no reliable
    // transaction identity, so the composite key would be too loose to collapse.
    if (utr) {
      const key = [
        str(r.victim_account) || '',
        str(r.beneficiary_account) || '',
        str(r.transaction_date) || '',
        num(r.transaction_amount),
        num(r.disputed_amount),
        utr,
      ].join('|');
      if (seen.has(key)) { removed += 1; continue; }
      seen.add(key);
    }
    out.push(r);
  }
  return { rows: out, removed };
}

/**
 * Annotate every transaction with its computed `cashout_mode`,
 * `same_day_cashout` (FR-11 + FR-12), and `row_kind` on a shallow copy, leaving
 * the inputs untouched.
 *
 * Same-day rule (FR-12): a transaction is a same-day cashout when its
 * classification is ATM_WITHDRAWAL AND it falls on the same IST calendar day
 * as the first moment its beneficiary account received inbound funds.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns
 * @returns {Array<Record<string, unknown>>} Enriched copies.
 */
function enrichTransactions(txns) {
  // First inbound instant per account = earliest transaction where that
  // account is the beneficiary (i.e. first time it received money).
  /** @type {Map<string, number>} */
  const firstInboundMs = new Map();
  for (const t of txns) {
    const acct = str(t.beneficiary_account);
    if (!acct) continue;
    const ms = toMs(t.transaction_date);
    if (ms === null) continue;
    const prev = firstInboundMs.get(acct);
    if (prev === undefined || ms < prev) firstInboundMs.set(acct, ms);
  }

  return txns.map((t) => {
    const cashoutMode = classifyCashoutMode(t);
    let sameDay = 0;
    if (cashoutMode === CASHOUT_MODE.ATM) {
      const acct = str(t.beneficiary_account);
      const inboundMs = acct ? firstInboundMs.get(acct) : undefined;
      if (inboundMs !== undefined) {
        const txnDay = istDayKey(t.transaction_date);
        const inboundDay = istDayKey(new Date(inboundMs).toISOString());
        if (txnDay !== null && txnDay === inboundDay) sameDay = 1;
      }
    }
    const enriched = { ...t, cashout_mode: cashoutMode, same_day_cashout: sameDay };
    enriched.row_kind = classifyRowKind(enriched);
    return enriched;
  });
}

// ─── Module 1 — layer analysis ─────────────────────────────────────────

/**
 * Per-layer aggregates over the laundering trail (Module 5).
 *
 * Transaction counts and amounts are computed over HOP rows only — a layer's
 * "transactions" are the fund movements INTO that layer (the "Money Transfer to"
 * legs), not the ATM/POS/hold dispositions that happen to carry the same Layer
 * number. This is what makes Layer 1 read "19 transactions, ₹10.65L" on a real
 * file instead of "70 rows, ₹18.8L" (the latter folds in every cashout leg).
 *
 * Per layer:
 *   • txn_count    — HOP rows arriving at the layer.
 *   • total_amount / disputed_amount — summed over those hops.
 *   • account_count / bank_count     — distinct beneficiary accounts / banks.
 *   • cashout_count — EXIT rows (ATM/POS) attributed to the layer.
 *   • fan_out_ratio — accounts_in_next_layer / accounts_in_this_layer.
 *   • top_banks     — up to three "Bank (n)" labels by hop count.
 *   • avg_forward_time_hours — mean hours from receipt at layer N to the
 *     earliest hop at layer N+1 sharing the account's ack_no (null at the tail).
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {Array<{
 *   layer_no: number, txn_count: number, account_count: number,
 *   total_amount: number, disputed_amount: number, cashout_count: number,
 *   avg_forward_time_hours: number|null, unique_banks: number,
 *   bank_count: number, fan_out_ratio: number|null, top_banks: string[],
 * }>} Sorted ascending by layer_no.
 */
function layerAnalysis(txns) {
  /** @type {Map<number, any>} */
  const byLayer = new Map();
  // earliest[`${ack}|${layer}`] = min hop ms — for cross-layer forward timing.
  /** @type {Map<string, number>} */
  const earliestAckLayer = new Map();
  // account → { layer → earliest receipt ms } and set of acks it touches.
  /** @type {Map<string, { receipt: Map<number, number>, acks: Set<string> }>} */
  const acct = new Map();

  const ensureLayer = (layer) => {
    if (!byLayer.has(layer)) {
      byLayer.set(layer, {
        layer_no: layer,
        accounts: new Set(),
        banks: new Set(),
        bankCounts: new Map(),
        txn_count: 0,
        total_amount: 0,
        disputed_amount: 0,
        cashout_count: 0,
      });
    }
    return byLayer.get(layer);
  };

  for (const t of txns) {
    const layer = layerOf(t.layer_no);
    const ms = toMs(t.transaction_date);
    const ackKey = str(t.ack_no) || '∅';
    const g = ensureLayer(layer);

    if (t.row_kind === ROW_KIND.EXIT) {
      g.cashout_count += 1;
      continue; // dispositions don't add to the hop aggregates
    }
    if (t.row_kind !== ROW_KIND.HOP) continue; // HOLD / OTHER: not transactions

    if (ms !== null) {
      const k = `${ackKey}|${layer}`;
      const prev = earliestAckLayer.get(k);
      if (prev === undefined || ms < prev) earliestAckLayer.set(k, ms);
    }

    g.txn_count += 1;
    g.total_amount += num(t.transaction_amount);
    g.disputed_amount += num(t.disputed_amount);
    const benef = str(t.beneficiary_account);
    if (benef) g.accounts.add(benef);
    const bank = str(t.beneficiary_bank);
    if (bank) {
      g.banks.add(bank);
      g.bankCounts.set(bank, (g.bankCounts.get(bank) || 0) + 1);
    }

    if (benef && ms !== null) {
      if (!acct.has(benef)) acct.set(benef, { receipt: new Map(), acks: new Set() });
      const a = acct.get(benef);
      a.acks.add(ackKey);
      const prevR = a.receipt.get(layer);
      if (prevR === undefined || ms < prevR) a.receipt.set(layer, ms);
    }
  }

  const sorted = [...byLayer.values()].sort((a, b) => a.layer_no - b.layer_no);
  // Account count of the immediately-following layer, for fan-out.
  const accountsByLayer = new Map(sorted.map((g) => [g.layer_no, g.accounts.size]));

  return sorted.map((g) => {
    // Average forward time for accounts that received hops in this layer.
    const diffs = [];
    for (const [, info] of acct) {
      const receiptMs = info.receipt.get(g.layer_no);
      if (receiptMs === undefined) continue;
      let nextMs;
      for (const ack of info.acks) {
        const cand = earliestAckLayer.get(`${ack}|${g.layer_no + 1}`);
        if (cand !== undefined && (nextMs === undefined || cand < nextMs)) nextMs = cand;
      }
      if (nextMs !== undefined && nextMs >= receiptMs) {
        diffs.push((nextMs - receiptMs) / 3_600_000);
      }
    }
    const avg = diffs.length
      ? round(diffs.reduce((s, d) => s + d, 0) / diffs.length, 2)
      : null;

    const nextAccounts = accountsByLayer.get(g.layer_no + 1);
    const fanOut = (nextAccounts !== undefined && g.accounts.size > 0)
      ? round(nextAccounts / g.accounts.size, 2)
      : null;

    const topBanks = [...g.bankCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([bank, n]) => `${bank} (${n})`);

    return {
      layer_no: g.layer_no,
      txn_count: g.txn_count,
      account_count: g.accounts.size,
      total_amount: round(g.total_amount),
      disputed_amount: round(g.disputed_amount),
      cashout_count: g.cashout_count,
      avg_forward_time_hours: avg,
      unique_banks: g.banks.size,
      bank_count: g.banks.size,
      fan_out_ratio: fanOut,
      top_banks: topBanks,
    };
  });
}

// ─── Module 2 — cashout analysis ───────────────────────────────────────

/**
 * Aggregate everything about money leaving the laundering chain (ATM
 * withdrawals and POS purchases).
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {{
 *   total_cashout_amount: number,
 *   total_cashout_transactions: number,
 *   atm_cashouts: Array<{ atm_id: string, atm_location: string|null,
 *     city: string|null, state: string|null, amount: number, count: number }>,
 *   same_day_cashouts: number,
 *   cashout_by_state: Array<{ state: string, amount: number, count: number }>,
 *   fastest_cashout_hours: number|null,
 * }}
 */
function cashoutAnalysis(txns) {
  let totalAmount = 0;
  let totalCount = 0;
  let sameDay = 0;
  let fastest = null;
  /** @type {Map<string, any>} */
  const byAtm = new Map();
  /** @type {Map<string, { amount: number, count: number }>} */
  const byState = new Map();

  // Earliest victim-side debit per ack_no = when funds first left the victim.
  /** @type {Map<string, number>} */
  const victimDebitMs = new Map();
  for (const t of txns) {
    const ms = toMs(t.transaction_date);
    if (ms === null) continue;
    const ackKey = str(t.ack_no) || '∅';
    const layer = layerOf(t.layer_no);
    // Layer 0 (or the earliest seen) approximates the victim debit moment.
    if (layer <= 0 || !victimDebitMs.has(ackKey)) {
      const prev = victimDebitMs.get(ackKey);
      if (prev === undefined || ms < prev) victimDebitMs.set(ackKey, ms);
    }
  }

  for (const t of txns) {
    if (!CASH_EXIT_MODES.has(t.cashout_mode)) continue;
    const amt = num(t.transaction_amount);
    totalAmount += amt;
    totalCount += 1;
    if (t.same_day_cashout) sameDay += 1;

    const state = str(t.state);
    if (state) {
      if (!byState.has(state)) byState.set(state, { amount: 0, count: 0 });
      const s = byState.get(state);
      s.amount += amt;
      s.count += 1;
    }

    if (t.cashout_mode === CASHOUT_MODE.ATM) {
      const atmId = str(t.atm_id) || 'UNKNOWN_ATM';
      if (!byAtm.has(atmId)) {
        byAtm.set(atmId, {
          atm_id: atmId,
          atm_location: str(t.atm_location),
          city: str(t.city),
          state,
          amount: 0,
          count: 0,
        });
      }
      const a = byAtm.get(atmId);
      a.amount += amt;
      a.count += 1;

      // Fastest cashout: victim debit → this ATM withdrawal.
      const ackKey = str(t.ack_no) || '∅';
      const debit = victimDebitMs.get(ackKey);
      const withdraw = toMs(t.transaction_date);
      if (debit !== undefined && withdraw !== null && withdraw >= debit) {
        const hrs = (withdraw - debit) / 3_600_000;
        if (fastest === null || hrs < fastest) fastest = hrs;
      }
    }
  }

  return {
    total_cashout_amount: round(totalAmount),
    total_cashout_transactions: totalCount,
    atm_cashouts: [...byAtm.values()]
      .map((a) => ({ ...a, amount: round(a.amount) }))
      .sort((a, b) => b.amount - a.amount),
    same_day_cashouts: sameDay,
    cashout_by_state: [...byState.entries()]
      .map(([state, v]) => ({ state, amount: round(v.amount), count: v.count }))
      .sort((a, b) => b.amount - a.amount),
    fastest_cashout_hours: fastest === null ? null : round(fastest, 2),
  };
}

// ─── Per-account rollup (shared by mule + lien) ───────────────────────

/**
 * Build a per-account rollup used by mule scoring, lien calculation, and the
 * recovery view, so every module agrees on each account's money flow.
 *
 * Unlike a single bank statement, an NCRP CompleteTrail lets us observe BOTH
 * sides of an account: it appears as a `beneficiary_account` when it receives a
 * hop, and as the `victim_account` (sender) of the next layer's hop when it
 * forwards onward. That lets us reconstruct a real per-account balance:
 *
 *   • total_received   — Σ gross HOP amounts where the account is the beneficiary.
 *   • onward_forwarded — Σ gross HOP amounts where the account is the sender
 *                        (the money it pushed to the next layer).
 *   • total_cashed_out — Σ EXIT (ATM/POS/AEPS) amounts at the account.
 *   • total_on_hold    — Σ HOLD amounts frozen at the account.
 *   • lien_eligible_amount = max(0, received − onward_forwarded − on_hold −
 *     cashed_out): the money that flowed in but cannot be accounted for as
 *     having left — i.e. the balance a lien can still freeze. This is the
 *     CypherSOL formula (Received − Sent − On Hold − Exits), and it reproduces
 *     their per-account figures exactly (e.g. an account that received ₹94,300
 *     and did nothing else → lien ₹94,300).
 *   • total_forwarded  — onward_forwarded + cashed_out (everything that left;
 *     shown in the UI and used for the mule pass-through ratio).
 *   • pass_through_ratio — total_forwarded / total_received (mule signal; can
 *     exceed 1 when an account commingles funds from several inflows).
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {Map<string, any>}
 */
function buildAccountRollup(txns) {
  const maxLayer = txns.reduce((m, t) => {
    if (t.row_kind !== ROW_KIND.HOP) return m;
    const l = layerOf(t.layer_no);
    return l > m ? l : m;
  }, 0);

  /** @type {Map<string, any>} */
  const accounts = new Map();
  const ensure = (acctRaw, seed = {}) => {
    const key = canonicalAccountKey(acctRaw);
    if (!accounts.has(key)) {
      accounts.set(key, {
        account_no: acctRaw,
        bank_name: null,
        ifsc_code: null,
        bank_source: null,
        bank_flag: null,
        raw_bank: null,
        names: new Set(),
        banks: new Set(),
        ifscs: new Set(),
        acks: new Set(),
        senders: new Set(),
        channels: new Set(),
        minLayer: Infinity,
        txn_count: 0,
        total_received: 0,
        onward_forwarded: 0,
        total_cashed_out: 0,
        total_on_hold: 0,
        disputed_received: 0,
        disputed_forwarded: 0,
        disputed_cashed_out: 0,
        firstReceiptMs: null,
        firstExitMs: null,
        firstForwardMs: null,
        lastActivityMs: null,
        cashoutStates: new Set(),
        homeStates: new Set(),
      });
    }
    const a = accounts.get(key);
    // Display the most complete representation; the key already collapses zero-
    // padded variants of one account so their figures aggregate once rather than
    // splitting into two suspects (and two lien letters).
    if (String(acctRaw).length > String(a.account_no).length) a.account_no = acctRaw;
    // Bank-attribution provenance (v0.2.0): captured from the first row that
    // carried a resolved beneficiary bank, so lien letters and the data-quality
    // view can footnote how the name was derived and what the source said. A row
    // bearing a VALID IFSC is authoritative, so it upgrades a first-seen
    // attribution that lacked one (and clears a stale NO_IFSC flag).
    const seedValid = VALID_IFSC.test(String(seed.ifsc || '').trim().toUpperCase());
    const curValid = VALID_IFSC.test(String(a.ifsc_code || '').trim().toUpperCase());
    if (seedValid && !curValid) {
      if (seed.bank) a.bank_name = seed.bank;
      a.ifsc_code = seed.ifsc;
      a.bank_source = seed.bankSource || a.bank_source;
      a.bank_flag = seed.bankFlag || null;
      a.raw_bank = seed.rawBank || a.raw_bank;
    } else {
      if (!a.bank_name && seed.bank) a.bank_name = seed.bank;
      if (!a.ifsc_code && seed.ifsc) a.ifsc_code = seed.ifsc;
      if (!a.bank_source && seed.bankSource) a.bank_source = seed.bankSource;
      if (!a.bank_flag && seed.bankFlag) a.bank_flag = seed.bankFlag;
      if (!a.raw_bank && seed.rawBank) a.raw_bank = seed.rawBank;
    }
    return a;
  };
  const touchLast = (a, ms) => {
    if (ms !== null && (a.lastActivityMs === null || ms > a.lastActivityMs)) a.lastActivityMs = ms;
  };

  // ── Pass 1 — inflows (hops), exits, holds; identity + timing ──────────
  for (const t of txns) {
    const ms = toMs(t.transaction_date);
    const amt = num(t.transaction_amount);
    const disp = num(t.disputed_amount);

    if (t.row_kind === ROW_KIND.HOP) {
      const benef = str(t.beneficiary_account);
      if (!benef) continue;
      const a = ensure(benef, {
        bank: str(t.beneficiary_bank), ifsc: str(t.ifsc_code),
        bankSource: str(t.bank_source), bankFlag: str(t.bank_flag), rawBank: str(t.raw_beneficiary_bank),
      });
      const layer = layerOf(t.layer_no);
      a.txn_count += 1;
      a.total_received += amt;
      a.disputed_received += disp;
      if (str(t.beneficiary_name)) a.names.add(str(t.beneficiary_name));
      if (str(t.beneficiary_bank)) a.banks.add(str(t.beneficiary_bank));
      if (str(t.ifsc_code)) a.ifscs.add(str(t.ifsc_code));
      if (str(t.ack_no)) a.acks.add(str(t.ack_no));
      // Count distinct senders by CANONICAL identity, so zero-pad variants of one
      // sender ("X" and "0000X") are one fan-in edge, not two (F9 in-degree). This
      // feeds both the collector in_degree and the mule high-fan-in signal.
      if (str(t.victim_account)) a.senders.add(canonicalAccountKey(t.victim_account));
      if (layer < a.minLayer) a.minLayer = layer;
      if (ms !== null && (a.firstReceiptMs === null || ms < a.firstReceiptMs)) a.firstReceiptMs = ms;
      const hState = str(t.state);
      if (hState) a.homeStates.add(hState);
      touchLast(a, ms);
    } else if (t.row_kind === ROW_KIND.EXIT) {
      const acct = str(t.beneficiary_account) || str(t.victim_account);
      if (!acct) continue;
      const a = ensure(acct, {
        bank: str(t.beneficiary_bank), ifsc: str(t.ifsc_code),
        bankSource: str(t.bank_source), bankFlag: str(t.bank_flag), rawBank: str(t.raw_beneficiary_bank),
      });
      a.total_cashed_out += amt;
      a.disputed_cashed_out += disp;
      a.channels.add(t.cashout_mode === CASHOUT_MODE.POS ? 'POS' : 'ATM');
      if (str(t.ack_no)) a.acks.add(str(t.ack_no));
      if (ms !== null && (a.firstExitMs === null || ms < a.firstExitMs)) a.firstExitMs = ms;
      const cState = str(t.state);
      if (cState) a.cashoutStates.add(cState);
      touchLast(a, ms);
    } else if (t.row_kind === ROW_KIND.HOLD) {
      const acct = str(t.beneficiary_account) || str(t.victim_account);
      if (!acct) continue;
      const a = ensure(acct, {
        bank: str(t.beneficiary_bank), ifsc: str(t.ifsc_code),
        bankSource: str(t.bank_source), bankFlag: str(t.bank_flag), rawBank: str(t.raw_beneficiary_bank),
      });
      a.total_on_hold += amt;
      if (str(t.ack_no)) a.acks.add(str(t.ack_no));
      touchLast(a, ms);
    }
  }

  // ── Pass 2 — onward transfers (the sender side of every hop) ──────────
  // Attribute a hop's amount to its SENDER, but only when that sender is an
  // account we already track (a beneficiary / cash-out / hold holder). A pure
  // layer-0 victim that only ever sends is not a suspect and gets no entry.
  for (const t of txns) {
    if (t.row_kind !== ROW_KIND.HOP) continue;
    const sender = str(t.victim_account);
    const senderKey = canonicalAccountKey(sender);
    if (!sender || !accounts.has(senderKey)) continue;
    const a = accounts.get(senderKey);
    const ms = toMs(t.transaction_date);
    a.onward_forwarded += num(t.transaction_amount);
    a.disputed_forwarded += num(t.disputed_amount); // Feature 4: disputed pushed onward (audit column)
    if (ms !== null && (a.firstForwardMs === null || ms < a.firstForwardMs)) a.firstForwardMs = ms;
    touchLast(a, ms);
  }

  // ── Derived fields ────────────────────────────────────────────────────
  for (const a of accounts.values()) {
    const isTerminal = a.minLayer === Infinity ? true : a.minLayer >= maxLayer;
    // Gross balance still sitting in the account: what came in, minus everything
    // we can prove left (onward transfers, cash exits, frozen funds). This is the
    // CypherSOL formula (Received − Sent − On Hold − Exits).
    const grossBalance = Math.max(
      0,
      a.total_received - a.onward_forwarded - a.total_on_hold - a.total_cashed_out
    );
    // Cap the lien at the DISPUTED (fraud-attributed) inflow. On real files a
    // single account can legitimately receive crores in gross value while only a
    // few thousand rupees are the disputed fraud (e.g. a payment-aggregator
    // settlement account). Liening the gross balance would over-state recoverable
    // funds ~100x; the lien can never exceed the fraud money that entered.
    const lien = Math.min(grossBalance, Math.max(0, a.disputed_received));
    a.gross_balance = round(grossBalance);
    a.is_terminal = isTerminal;
    a.total_forwarded = round(a.onward_forwarded + a.total_cashed_out);
    a.onward_forwarded = round(a.onward_forwarded);
    a.total_cashed_out = round(a.total_cashed_out);
    a.total_on_hold = round(a.total_on_hold);
    a.lien_eligible_amount = round(lien);
    a.disputed_received = round(a.disputed_received);
    a.disputed_forwarded = round(a.disputed_forwarded);
    a.disputed_cashed_out = round(a.disputed_cashed_out);
    a.total_received = round(a.total_received);

    const movedOn = a.total_forwarded;
    a.pass_through_ratio = a.total_received > 0 ? round(movedOn / a.total_received, 4) : 0;

    // First disposition (cash out OR onward forward) for speed + same-day.
    let firstOutMs = null;
    if (a.firstExitMs !== null) firstOutMs = a.firstExitMs;
    if (a.firstForwardMs !== null && (firstOutMs === null || a.firstForwardMs < firstOutMs)) {
      firstOutMs = a.firstForwardMs;
    }
    a.forward_speed_hours =
      a.firstReceiptMs !== null && firstOutMs !== null && firstOutMs >= a.firstReceiptMs
        ? round((firstOutMs - a.firstReceiptMs) / 3_600_000, 2)
        : null;
    a.same_day_in_out = Boolean(
      a.firstReceiptMs !== null && firstOutMs !== null &&
      istDayKey(new Date(a.firstReceiptMs).toISOString()) ===
        istDayKey(new Date(firstOutMs).toISOString())
    );
    a.first_date = a.firstReceiptMs !== null
      ? new Date(a.firstReceiptMs).toISOString()
      : (a.lastActivityMs !== null ? new Date(a.lastActivityMs).toISOString() : null);
    a.last_date = a.lastActivityMs !== null ? new Date(a.lastActivityMs).toISOString() : null;
  }
  return accounts;
}

// ─── Module 3 — mule detection ─────────────────────────────────────────

/**
 * Bonus signal weights layered on top of the six base config weights (Module 8).
 * Sourced from config/mule_weights.json so the scoring is fully config-driven and
 * tunable without code changes; the literals below are fallbacks for older config
 * files that predate these keys.
 */
const MULE_BONUS = Object.freeze({
  bothSheets: num(MULE_WEIGHTS.bothSheets) || 18,        // received via transfer AND cashed out
  multiChannel: num(MULE_WEIGHTS.multiChannel) || 8,     // used more than one cash-out channel (ATM + POS)
  fanIn: num(MULE_WEIGHTS.fanIn) || 8,                   // collects from two or more upstream accounts
  highCashoutRatio: num(MULE_WEIGHTS.highCashoutRatio) || 15, // withdrew as cash ≥ 90% of what it received
  sameDayInOut: num(MULE_WEIGHTS.sameDayInOut) || 17,    // money in and money out on the same calendar day
  // Feature 2 — graduated in-degree (fan-in) signal. `fanIn` above is binary
  // (one flat bonus at ≥ 2 senders); this ADDS points for the DEGREE of fan-in
  // beyond that — `inDegreeCollector` points per distinct sender above the 2nd —
  // so a 10-sender collector outranks a 2-sender one. Fires only at in-degree ≥ 3,
  // leaving every existing ≤2-sender account's score unchanged. Uncapped, as today.
  inDegreeCollector: num(MULE_WEIGHTS.inDegreeCollector) || 6,
});

/**
 * Score every account across the six weighted laundering signals (weights from
 * config/mule_weights.json) PLUS five behavioural bonus signals, and attach a
 * plain-language `suspicion_reasons` list naming exactly which signals fired.
 *
 * The score is intentionally NOT capped at 100: a textbook mule that trips every
 * signal lands above 100 (matching CypherSOL's >100 scores), which keeps the
 * worst offenders visually distinct. Risk bands still key off the 70 / 40
 * thresholds. Base signals:
 *   1. passThrough · 2. cashoutSpeed · 3. txnCount · 4. crossCase ·
 *   5. geoSpread · 6. kycVariance.
 * Bonus signals: appears in both transfer & cash-out sheets, multiple cash-out
 * channels, fan-in from several accounts, high cash-out ratio, same-day in/out.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @param {Map<string, any>} rollup - Output of buildAccountRollup.
 * @param {ReadonlyArray<Record<string, unknown>>} [existingRepeatAccounts=[]]
 *   Cross-case registry rows ({ account_no, appearance_count, ... }).
 * @returns {Array<object>} Sorted by mule_score descending. Each row carries the
 *   scoring inputs, `suspicion_reasons`, channels, cash-out total, and dates.
 */
function muleDetection(txns, rollup, existingRepeatAccounts = []) {
  if (!rollup || typeof rollup.values !== 'function') return [];
  const w = { ...MULE_WEIGHTS };
  /** @type {Map<string, number>} */
  const historyCount = new Map();
  for (const r of existingRepeatAccounts || []) {
    const acct = str(r.account_no);
    if (!acct) continue;
    historyCount.set(acct, num(r.appearance_count) || 0);
  }

  const results = [];
  for (const a of rollup.values()) {
    const reasons = [];

    // 1. Pass-through — full weight at/above the threshold, linear below.
    const passPts = num(w.passThrough) * Math.min(1, a.pass_through_ratio / PASS_THROUGH_FULL);
    if (a.pass_through_ratio >= PASS_THROUGH_FULL) {
      // Honest gross-vs-traced wording. The ratio's numerator is gross onward /
      // cash-out, its denominator is traced hop-inflow, so it can far exceed 100%
      // for commingling conduits. Never surface an absurd ">100%" on a court-facing
      // rationale — describe the behaviour instead. (The signal itself is unchanged;
      // passPts already caps the ratio at 1.0 above.)
      reasons.push(a.pass_through_ratio > 1
        ? 'Pass-through conduit (onward / cash-out gross exceeds traced inflow)'
        : `High pass-through (${Math.round(a.pass_through_ratio * 100)}% of inflow moved on)`);
    }

    // 2. Cashout speed — full if forwarded fast, decaying to zero by 24h.
    let speedPts = 0;
    if (a.forward_speed_hours !== null) {
      if (a.forward_speed_hours <= FAST_FORWARD_HOURS) speedPts = num(w.cashoutSpeed);
      else if (a.forward_speed_hours < SLOW_FORWARD_HOURS) {
        speedPts = num(w.cashoutSpeed) *
          ((SLOW_FORWARD_HOURS - a.forward_speed_hours) / (SLOW_FORWARD_HOURS - FAST_FORWARD_HOURS));
      }
      if (a.forward_speed_hours <= FAST_FORWARD_HOURS) {
        reasons.push(`Funds moved within ${round(a.forward_speed_hours, 1)}h of receipt`);
      }
    }

    // 3. Transaction count.
    const countPts = num(w.txnCount) * Math.min(1, a.txn_count / HIGH_TXN_COUNT);
    if (a.txn_count > 5) reasons.push(`High transaction velocity (${a.txn_count} txns)`);

    // 4. Cross-case — distinct cases in this file plus historical appearances.
    const appearsInCases = Math.max(a.acks.size, historyCount.get(a.account_no) || 0);
    const crossPts = appearsInCases > 1 ? num(w.crossCase) : 0;
    if (appearsInCases > 1) reasons.push(`Appears across ${appearsInCases} cases`);

    // 5. Geographic spread — cashed out in a state other than its home state.
    let geoSpread = false;
    for (const cState of a.cashoutStates) {
      if (a.homeStates.size > 0 && !a.homeStates.has(cState)) { geoSpread = true; break; }
    }
    const geoPts = geoSpread ? num(w.geoSpread) : 0;
    if (geoSpread) reasons.push('Cashed out in a different state than its home state');

    // 6. KYC variance — inconsistent identity attributes across rows.
    const kycVariance = a.names.size > 1 || a.banks.size > 1 || a.ifscs.size > 1;
    const kycPts = kycVariance ? num(w.kycVariance) : 0;
    if (kycVariance) reasons.push('Inconsistent KYC (name / bank / IFSC across rows)');

    // ── Bonus behavioural signals ──────────────────────────────────────
    let bonus = 0;
    const channels = [...a.channels];
    const cashoutRatio = a.total_received > 0 ? a.total_cashed_out / a.total_received : 0;
    if (a.total_received > 0 && a.total_cashed_out > 0) {
      bonus += MULE_BONUS.bothSheets;
      reasons.push('Appears in both transfer & cash-out sheets');
    }
    if (channels.length > 1) {
      bonus += MULE_BONUS.multiChannel;
      reasons.push(`Multiple cash-out channels: ${channels.join(', ')}`);
    }
    if (a.senders.size >= 2) {
      bonus += MULE_BONUS.fanIn;
      reasons.push(`Receives from ${a.senders.size} accounts`);
    }
    // Graduated in-degree (Feature 2): the COUNT of distinct senders (in-degree)
    // fed in as an additive signal — `inDegreeCollector` points per sender beyond
    // the 2nd — so a high-fan-in collector ranks above a minimal one. in-degree
    // here is a.senders.size, the same distinct-sender measure connectivity.js and
    // the cycle/aggregator graph use, so the score and the aggregator table agree.
    const extraSenders = Math.max(0, a.senders.size - 2);
    if (extraSenders > 0) {
      const inDegreePts = MULE_BONUS.inDegreeCollector * extraSenders;
      bonus += inDegreePts;
      reasons.push(`High fan-in collector: in-degree ${a.senders.size} (+${inDegreePts})`);
    }
    if (cashoutRatio >= 0.9) {
      bonus += MULE_BONUS.highCashoutRatio;
      reasons.push(`High cashout ratio (${Math.round(cashoutRatio * 100)}% of received)`);
    }
    if (a.same_day_in_out) {
      bonus += MULE_BONUS.sameDayInOut;
      reasons.push('Same-day receive & cashout/forward');
    }

    const score = Math.max(0, Math.round(
      passPts + speedPts + countPts + crossPts + geoPts + kycPts + bonus
    ));

    results.push({
      account_no: a.account_no,
      bank_name: a.bank_name,
      mule_score: score,
      risk_label: score >= RISK_HIGH ? 'HIGH' : score >= RISK_MEDIUM ? 'MEDIUM' : 'LOW',
      pass_through_ratio: a.pass_through_ratio,
      total_received: a.total_received,
      total_forwarded: a.total_forwarded,
      // Surfaced for the Mule page's gross-vs-traced transparency (F1/F2): the
      // onward-only leg and the traced (disputed) inflow. Read straight from the
      // rollup — neither feeds the score.
      onward_forwarded: a.onward_forwarded,
      disputed_received: a.disputed_received,
      total_cashout: a.total_cashed_out,
      forward_speed_hours: a.forward_speed_hours,
      appears_in_cases: appearsInCases,
      layer_no: Number.isFinite(a.minLayer) ? a.minLayer : null,
      txn_count: a.txn_count,
      channels,
      same_day_in_out: a.same_day_in_out,
      first_date: a.first_date,
      last_date: a.last_date,
      suspicion_reasons: reasons,
    });
  }

  // Deterministic ranking: highest score first, then larger disputed inflow (a
  // bigger mule outranks a smaller one at equal score), then account number — so
  // equal scores never reorder run-to-run (the score is uncapped points, ties
  // are common). See note on the uncapped scale in the function header.
  return results.sort((a, b) =>
    (b.mule_score - a.mule_score) ||
    (num(b.total_received) - num(a.total_received)) ||
    String(a.account_no).localeCompare(String(b.account_no)));
}

// ─── Module 4 — lien calculation ───────────────────────────────────────

/**
 * Recoverable-amount worksheet (Module 3 / BUG 3 fix): one row per account that
 * still presumably holds money, with the lien-eligible balance and a plain-
 * language justification.
 *
 * The lien-eligible figure is the gross balance reconstructed in
 * {@link buildAccountRollup}: received − onward-forwarded − on-hold − cashed-out.
 * Reporting the gross legs in the note keeps the arithmetic transparent and
 * matches the CypherSOL worksheet (Received − Sent − On Hold − Exits).
 *
 * @param {Map<string, any>} rollup - Output of buildAccountRollup.
 * @returns {Array<{
 *   account_no: string, bank_name: string|null, ifsc_code: string|null,
 *   layer_no: number|null, total_received: number, total_forwarded: number,
 *   onward_forwarded: number, total_on_hold: number, total_cashed_out: number,
 *   gross_balance: number, disputed_received: number,
 *   lien_eligible_amount: number, note: string,
 * }>} Only accounts with lien_eligible_amount > 0, sorted by amount desc.
 *   gross_balance and disputed_received are surfaced for the export worksheet so
 *   it can show lien_eligible_amount = min(gross_balance, disputed_received);
 *   both are read straight from the rollup (no recomputation).
 */
function lienCalculation(rollup) {
  const rows = [];
  for (const a of rollup.values()) {
    if (a.lien_eligible_amount <= 0) continue;
    const received = num(a.total_received);
    const onward = num(a.onward_forwarded);
    const hold = num(a.total_on_hold);
    const exits = num(a.total_cashed_out);
    const lien = num(a.lien_eligible_amount);
    // gross_balance (pre-cap residue) and disputed_received (the cap) are read
    // straight from the rollup — never recomputed. lien = max(0, min(gross_balance,
    // disputed_received)). When the gross residue exceeds the disputed inflow the
    // cap bites: the excess is the account's own/clean (non-disputed) funds and is
    // EXCLUDED from the lien. `excluded_reason` (Feature 4) makes that delta
    // reviewable per account; `disputed_forwarded` is surfaced as an audit column.
    const grossBal = a.gross_balance != null
      ? num(a.gross_balance)
      : Math.max(0, received - onward - hold - exits);
    const capExcess = round(grossBal - lien);
    const excludedReason = capExcess > 0.005
      ? `Capped at disputed inflow: gross residue ${formatINR(grossBal)} exceeds disputed inflow ` +
        `${formatINR(num(a.disputed_received))}; ${formatINR(capExcess)} is non-disputed (own/clean) ` +
        `funds and is excluded from the lien.`
      : 'Full gross residue is within the disputed inflow — no cap applied.';
    rows.push({
      account_no: a.account_no,
      bank_name: a.bank_name,
      ifsc_code: a.ifsc_code,
      bank_source: a.bank_source,
      bank_flag: a.bank_flag,
      raw_bank: a.raw_bank,
      layer_no: Number.isFinite(a.minLayer) ? a.minLayer : null,
      total_received: received,
      total_forwarded: num(a.total_forwarded),
      onward_forwarded: onward,
      total_on_hold: hold,
      total_cashed_out: exits,
      gross_balance: grossBal,
      disputed_received: num(a.disputed_received),
      disputed_forwarded: num(a.disputed_forwarded), // Feature 4 audit column
      cap_excess: capExcess,                          // gross_balance − lien (excluded as non-disputed)
      excluded_reason: excludedReason,
      lien_eligible_amount: lien,
      note:
        `Received ${formatINR(received)}; forwarded ${formatINR(onward)} onward, ` +
        `${formatINR(exits)} withdrawn as cash, ${formatINR(hold)} already on hold. ` +
        `${formatINR(lien)} remains unaccounted-for — ` +
        `request lien (subject to available balance at bank).`,
    });
  }
  return rows.sort((a, b) => b.lien_eligible_amount - a.lien_eligible_amount);
}

/**
 * Accounts EXCLUDED from the lien worksheet that nonetheless carry a positive
 * gross residue (received − forwarded − on-hold − exits) — i.e. the disputed-
 * inflow cap floored their lien to zero. Listed (Feature 4) so a reviewer can see
 * every account the cap removed and why; the no-cap "naive" total is exactly
 * Σ lien + Σ (these accounts' gross residue) + Σ cap_excess of the liened rows.
 *
 * @param {Map<string, any>} rollup - Output of buildAccountRollup.
 * @returns {Array<{ account_no: string, bank_name: string|null,
 *   gross_balance: number, disputed_received: number, total_cashed_out: number,
 *   excluded_reason: string }>}
 */
function lienExclusions(rollup) {
  const out = [];
  for (const a of rollup.values()) {
    const grossBal = num(a.gross_balance);
    if (grossBal <= 0.005) continue;            // no residue to recover anyway
    if (num(a.lien_eligible_amount) > 0.005) continue; // it IS on the lien table
    out.push({
      account_no: a.account_no,
      bank_name: a.bank_name,
      ifsc_code: a.ifsc_code,
      gross_balance: round(grossBal),
      disputed_received: num(a.disputed_received),
      total_cashed_out: num(a.total_cashed_out),
      excluded_reason:
        `Excluded from lien: gross residue ${formatINR(grossBal)} but disputed inflow ` +
        `${formatINR(num(a.disputed_received))} — the residue is non-disputed (own/clean) funds.`,
    });
  }
  return out.sort((a, b) => b.gross_balance - a.gross_balance);
}

// ─── Data-quality review (v0.2.0 — bank attribution) ────────────────────

/**
 * Human-readable explanation for a bank-attribution data-quality flag.
 *
 * @param {string} flag    one of the ifscBankResolver FLAGS
 * @param {string} bank    resolved (printed) bank name
 * @param {string|null} raw raw source-file text
 * @returns {string}
 */
function bankFlagMessage(flag, bank, raw) {
  const said = raw ? `"${raw}"` : 'a different value';
  switch (flag) {
    case 'IFSC_TEXT_MISMATCH':
      return `IFSC resolves to ${bank}; source file text said ${said} — letter uses ${bank} (verify).`;
    case 'NO_IFSC':
      return `No IFSC present (wallet / PA / PG account). Name "${bank}" taken from text — confirm the correct nodal entity.`;
    case 'INVALID_IFSC':
      return `IFSC was unparseable. Name "${bank}" taken from text — confirm the correct nodal entity.`;
    case 'UNKNOWN_IFSC_PREFIX':
      return `IFSC prefix not in the bank map; kept text "${bank}". Extend IFSC_BANK_MAP with this prefix.`;
    default:
      return `Bank attribution flagged for review: ${flag}.`;
  }
}

/**
 * List every beneficiary account whose resolved bank carries a data-quality
 * flag (IFSC↔text mismatch, missing/invalid IFSC, or unknown prefix), one row
 * per distinct account. Drives the "Data Quality" panel / sheet so the IO can
 * verify freeze targets the IFSC could not silently confirm.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Canonical transaction rows.
 * @returns {Array<{
 *   account_no: string, ifsc_code: string|null, bank: string,
 *   raw_bank: string|null, bank_source: string|null, bank_flag: string,
 *   message: string,
 * }>}
 */
function dataQuality(txns) {
  /** @type {Map<string, any>} */
  const byAccount = new Map();
  for (const t of txns) {
    const flag = str(t.bank_flag);
    if (!flag) continue;
    const acctRaw = str(t.beneficiary_account) || str(t.victim_account);
    if (!acctRaw) continue;
    const key = canonicalAccountKey(acctRaw);
    const ifsc = str(t.ifsc_code);
    const rowValid = VALID_IFSC.test(String(ifsc || '').trim().toUpperCase());
    const existing = byAccount.get(key);
    // One row per real account. Zero-padded variants collapse onto one key; when
    // two variants disagree, the row bearing a VALID IFSC wins — it is
    // authoritative and its IFSC_TEXT_MISMATCH is the actionable flag, not the
    // duplicate's NO_IFSC. Always keep the most complete account representation.
    if (existing) {
      const exValid = VALID_IFSC.test(String(existing.ifsc_code || '').trim().toUpperCase());
      if (String(acctRaw).length > String(existing.account_no).length) existing.account_no = acctRaw;
      if (!(rowValid && !exValid)) continue; // keep existing unless this row upgrades to a valid IFSC
    }
    const bank = str(t.beneficiary_bank) || 'Unknown';
    const raw = str(t.raw_beneficiary_bank);
    const displayAcct = existing && String(existing.account_no).length > String(acctRaw).length
      ? existing.account_no : acctRaw;
    byAccount.set(key, {
      account_no: displayAcct,
      ifsc_code: ifsc,
      bank,
      raw_bank: raw,
      bank_source: str(t.bank_source),
      bank_flag: flag,
      message: bankFlagMessage(flag, bank, raw),
    });
  }
  // Mismatches first (most actionable), then by account for stable ordering.
  const order = { IFSC_TEXT_MISMATCH: 0, UNKNOWN_IFSC_PREFIX: 1, INVALID_IFSC: 2, NO_IFSC: 3 };
  return [...byAccount.values()].sort((a, b) =>
    (order[a.bank_flag] ?? 9) - (order[b.bank_flag] ?? 9) ||
    String(a.account_no).localeCompare(String(b.account_no)));
}

/**
 * Wallet / payment-gateway / payment-aggregator names. A NO_IFSC row whose
 * bank text matches is structurally IFSC-less (the text IS the entity to
 * serve notice on, per lib/ifscBankResolver). Curated, deterministic list —
 * anything not on it fails toward caution (ACTIONABLE).
 */
const WALLET_PG_PA_RE = new RegExp(
  [
    'paytm', 'phonepe', 'phone pe', 'mobikwik', 'amazon ?pay', 'google ?pay', 'gpay',
    'cred\\b', 'razorpay', 'razor pay', 'cashfree', 'payu', 'pine ?labs', 'bharatpe',
    'freecharge', 'airtel money', 'ola money', 'jio ?money', 'easebuzz', 'ease buzz',
    'whatsapp pay', '\\bwallet\\b', '\\bpg\\b', 'payment gateway', 'payment aggregator',
    // 'slice' was removed 2026-06-12: it false-matched "Slice Small Finance
    // Bank" (a real RBI-licensed bank present in gold case ...170), wrongly
    // downgrading a bank account's NO_IFSC to informational. A false positive
    // here HIDES a freeze-target uncertainty, so the list errs narrow — every
    // pattern is pinned against the gold cases' real bank texts in
    // dataQuality.test.js ("wallet regex matches no real bank text").
  ].join('|'),
  'i'
);

/**
 * Per-case data-quality summary over the {@link dataQuality} rows, with a
 * two-tier severity model and a freeze-target dimension. Also annotates each
 * dqRow in place with `severity` ('informational'|'actionable') and
 * `freeze_target` (boolean) for the drill-in view.
 *
 * ADVISORY ONLY: flags never alter a financial figure — they tell the IO which
 * accounts' bank attribution needs eyes before a lien letter is dispatched.
 *
 * SEVERITY TIERS (flag names are DB-persisted and unchanged — this re-tiers
 * how they are WEIGHTED):
 *   INFORMATIONAL — never drives amber/red:
 *     • IFSC_TEXT_MISMATCH — the IFSC is authoritative, so the inconsistency
 *       is already RESOLVED: the letter carries the IFSC-derived bank and the
 *       source text is preserved for audit ("auto-corrected").
 *     • NO_IFSC where the row is structurally IFSC-less: the account's bank
 *       is already IFSC-confirmed on another row, OR all its flagged rows are
 *       cash-exit/hold channel rows (those sheets carry no IFSC column), OR
 *       the bank text is a known wallet/PG/PA ("expected").
 *   ACTIONABLE — drives severity:
 *     • INVALID_IFSC (malformed), UNKNOWN_IFSC_PREFIX (bank not in map), and
 *     • NO_IFSC on a bank-account-type row — or any NO_IFSC row whose type
 *       cannot be determined (fail toward caution).
 *
 * STATUS (freeze-target scoped — the only red is "about to send a lien letter
 * to a bank that couldn't be confirmed"):
 *   • green — zero actionable flags.
 *   • amber — actionable flags exist, but none on a freeze-target account.
 *   • red   — one or more actionable flags fall on a freeze-target account
 *             (an account in the lien table, i.e. a Section 102 letter target).
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @param {Array<Record<string, unknown>>} dqRows - Output of dataQuality() (annotated in place).
 * @param {ReadonlyArray<{ account_no: string }>} liens - lienCalculation() output (freeze-target set).
 * @returns {{
 *   total_accounts: number, flagged_accounts: number, pct_affected: number,
 *   counts: Record<string, number>,
 *   actionable_accounts: number,
 *   actionable_counts: { INVALID_IFSC: number, UNKNOWN_IFSC_PREFIX: number, NO_IFSC: number },
 *   informational: { auto_corrected: number, expected_no_ifsc: number },
 *   freeze_target_total: number, freeze_target_flags: number,
 *   freeze_target_accounts: string[],
 *   status: 'green'|'amber'|'red',
 * }}
 */
function dataQualitySummary(txns, dqRows, liens = []) {
  // Denominator + per-account row context, keyed exactly the way dataQuality()
  // attributes flags (beneficiary first, victim fallback).
  const allAccounts = new Set();
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const rowsByAccount = new Map();
  for (const t of txns) {
    const acct = str(t.beneficiary_account) || str(t.victim_account);
    if (!acct) continue;
    allAccounts.add(acct);
    if (!rowsByAccount.has(acct)) rowsByAccount.set(acct, []);
    rowsByAccount.get(acct).push(t);
  }

  const lienSet = new Set(liens.map((l) => str(l.account_no)).filter(Boolean));

  const counts = { IFSC_TEXT_MISMATCH: 0, UNKNOWN_IFSC_PREFIX: 0, INVALID_IFSC: 0, NO_IFSC: 0 };
  const actionable_counts = { INVALID_IFSC: 0, UNKNOWN_IFSC_PREFIX: 0, NO_IFSC: 0 };
  let autoCorrected = 0;
  let expectedNoIfsc = 0;
  let actionableAccounts = 0;
  const freezeTargetAccounts = [];

  for (const r of dqRows) {
    if (counts[r.bank_flag] !== undefined) counts[r.bank_flag] += 1;

    let severity = 'actionable';
    if (r.bank_flag === 'IFSC_TEXT_MISMATCH') {
      // The IFSC already won; the letter bank is correct. Resolved, not open.
      severity = 'informational';
      autoCorrected += 1;
    } else if (r.bank_flag === 'NO_IFSC') {
      const acctRows = rowsByAccount.get(str(r.account_no)) || [];
      const ifscConfirmedElsewhere = acctRows.some((t) => str(t.bank_source) === 'IFSC');
      const flagRows = acctRows.filter((t) => str(t.bank_flag) === 'NO_IFSC');
      const allCashOrHold = flagRows.length > 0 &&
        flagRows.every((t) => t.row_kind === ROW_KIND.EXIT || t.row_kind === ROW_KIND.HOLD);
      const walletText = WALLET_PG_PA_RE.test(str(r.raw_bank) || str(r.bank) || '');
      if (ifscConfirmedElsewhere || allCashOrHold || walletText) {
        severity = 'informational';
        expectedNoIfsc += 1;
      }
      // else: a bank-account-type row missing its IFSC, or indeterminate →
      // stays actionable (fail toward caution).
    }
    // INVALID_IFSC / UNKNOWN_IFSC_PREFIX (and any future flag) stay actionable.

    const isFreezeTarget = lienSet.has(str(r.account_no));
    r.severity = severity;
    r.freeze_target = isFreezeTarget;

    if (severity === 'actionable') {
      actionableAccounts += 1;
      if (actionable_counts[r.bank_flag] !== undefined) actionable_counts[r.bank_flag] += 1;
      if (isFreezeTarget) freezeTargetAccounts.push(str(r.account_no));
    }
  }

  const flagged = dqRows.length;
  const total = allAccounts.size;
  const pct = total > 0 ? round((flagged / total) * 100, 1) : 0;

  const status = actionableAccounts === 0
    ? 'green'
    : (freezeTargetAccounts.length > 0 ? 'red' : 'amber');

  return {
    total_accounts: total,
    flagged_accounts: flagged,
    pct_affected: pct,
    counts,
    actionable_accounts: actionableAccounts,
    actionable_counts,
    informational: { auto_corrected: autoCorrected, expected_no_ifsc: expectedNoIfsc },
    freeze_target_total: lienSet.size,
    freeze_target_flags: freezeTargetAccounts.length,
    freeze_target_accounts: freezeTargetAccounts,
    status,
  };
}

// ─── Module 5 — repeat-account detection ───────────────────────────────

/**
 * Accounts that appear under more than one ack_no within this file, merged
 * with the cross-case registry so an account already known from prior reports
 * is flagged even if it appears once here.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @param {ReadonlyArray<Record<string, unknown>>} [existingRepeatAccounts=[]]
 * @returns {Array<{
 *   account_no: string, bank_name: string|null,
 *   cases_in_file: number, in_file_txn_count: number,
 *   known_appearance_count: number, total_appearances: number,
 *   is_known_repeat: boolean,
 * }>} Sorted by total_appearances descending.
 */
function repeatAccountDetection(txns, existingRepeatAccounts = []) {
  /** @type {Map<string, { acks: Set<string>, count: number, bank: string|null }>} */
  const inFile = new Map();
  for (const t of txns) {
    const acct = str(t.beneficiary_account);
    if (!acct) continue;
    if (!inFile.has(acct)) {
      inFile.set(acct, { acks: new Set(), count: 0, bank: str(t.beneficiary_bank) });
    }
    const r = inFile.get(acct);
    r.count += 1;
    const ack = str(t.ack_no);
    if (ack) r.acks.add(ack);
    if (!r.bank && str(t.beneficiary_bank)) r.bank = str(t.beneficiary_bank);
  }

  /** @type {Map<string, number>} */
  const known = new Map();
  for (const r of existingRepeatAccounts || []) {
    const acct = str(r.account_no);
    if (acct) known.set(acct, num(r.appearance_count) || 0);
  }

  const out = [];
  for (const [acct, r] of inFile) {
    const casesInFile = r.acks.size;
    const knownCount = known.get(acct) || 0;
    // Surface if multi-case within this file OR already a known repeat.
    if (casesInFile <= 1 && knownCount <= 1) continue;
    out.push({
      account_no: acct,
      bank_name: r.bank,
      cases_in_file: casesInFile,
      in_file_txn_count: r.count,
      known_appearance_count: knownCount,
      total_appearances: Math.max(casesInFile, knownCount),
      is_known_repeat: knownCount > 1,
    });
  }
  return out.sort((a, b) => b.total_appearances - a.total_appearances);
}

// ─── Module 6 — timeline analysis ──────────────────────────────────────

/**
 * Daily activity, grouped by the IST calendar day of each transaction.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {Array<{
 *   date: string, total_amount: number, transaction_count: number,
 *   layer_breakdown: Record<string, number>,
 * }>} Sorted chronologically.
 */
function timelineAnalysis(txns) {
  /** @type {Map<string, any>} */
  const byDay = new Map();
  for (const t of txns) {
    const day = istDayKey(t.transaction_date);
    if (day === null) continue;
    if (!byDay.has(day)) {
      byDay.set(day, { date: day, total_amount: 0, transaction_count: 0, layers: {} });
    }
    const d = byDay.get(day);
    d.total_amount += num(t.transaction_amount);
    d.transaction_count += 1;
    const layer = layerOf(t.layer_no);
    d.layers[layer] = round((d.layers[layer] || 0) + num(t.transaction_amount));
  }
  return [...byDay.values()]
    .map((d) => ({
      date: d.date,
      total_amount: round(d.total_amount),
      transaction_count: d.transaction_count,
      layer_breakdown: d.layers,
    }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// ─── Module 7 — geography analysis ─────────────────────────────────────

/**
 * Money + cash-out distribution across states, cities, ATMs, and merchants
 * (Module 6). State/city aggregates are driven by cash-exit (ATM/POS/AEPS) rows
 * — that is the geography an officer can act on (CCTV, local police) — and each
 * carries the share of the total cash-out it represents. ATM and merchant
 * hotspots are ranked separately so the dossier can point at specific terminals.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {{
 *   by_state: Array<{ state: string, amount: number, txn_count: number, count: number, cashout_count: number, pct: number }>,
 *   by_city: Array<{ city: string, state: string|null, amount: number, count: number, pct: number }>,
 *   top_atms: Array<{ atm_id: string, location: string|null, txn_count: number, amount: number, account_count: number }>,
 *   top_merchants: Array<{ name: string, type: string, amount: number, txn_count: number }>,
 * }}
 */
function geographyAnalysis(txns) {
  /** @type {Map<string, any>} */
  const byState = new Map();
  /** @type {Map<string, any>} */
  const byCity = new Map();
  /** @type {Map<string, any>} */
  const byAtm = new Map();
  /** @type {Map<string, any>} */
  const byMerchant = new Map();
  let cashoutTotal = 0;

  for (const t of txns) {
    const isCashout = t.row_kind === ROW_KIND.EXIT;
    if (!isCashout) continue;
    const amt = num(t.transaction_amount);
    cashoutTotal += amt;

    const state = str(t.state);
    if (state) {
      if (!byState.has(state)) byState.set(state, { state, amount: 0, count: 0, cashout_count: 0 });
      const s = byState.get(state);
      s.amount += amt; s.count += 1; s.cashout_count += 1;
    }

    const city = str(t.city);
    if (city) {
      const key = `${city}|${state || ''}`;
      if (!byCity.has(key)) byCity.set(key, { city, state, amount: 0, count: 0 });
      const c = byCity.get(key);
      c.amount += amt; c.count += 1;
    }

    const acct = str(t.beneficiary_account) || str(t.victim_account);
    if (t.cashout_mode === CASHOUT_MODE.ATM) {
      const atmId = str(t.atm_id) || 'UNKNOWN_ATM';
      if (!byAtm.has(atmId)) {
        byAtm.set(atmId, { atm_id: atmId, location: str(t.atm_location) || str(t.city), txn_count: 0, amount: 0, accounts: new Set() });
      }
      const a = byAtm.get(atmId);
      a.txn_count += 1; a.amount += amt;
      if (acct) a.accounts.add(acct);
    } else if (t.cashout_mode === CASHOUT_MODE.POS) {
      const name = str(t.atm_location) || str(t.beneficiary_name) || 'UNKNOWN_MERCHANT';
      if (!byMerchant.has(name)) byMerchant.set(name, { name, type: 'Merchant', amount: 0, txn_count: 0 });
      const m = byMerchant.get(name);
      m.amount += amt; m.txn_count += 1;
    }
  }

  const pctOf = (x) => (cashoutTotal > 0 ? round((x / cashoutTotal) * 100, 1) : 0);

  return {
    by_state: [...byState.values()]
      .map((s) => ({ state: s.state, amount: round(s.amount), txn_count: s.count, count: s.count, cashout_count: s.cashout_count, pct: pctOf(s.amount) }))
      .sort((a, b) => b.amount - a.amount),
    by_city: [...byCity.values()]
      .map((c) => ({ city: c.city, state: c.state, amount: round(c.amount), count: c.count, pct: pctOf(c.amount) }))
      .sort((a, b) => b.amount - a.amount),
    top_atms: [...byAtm.values()]
      .map((a) => ({ atm_id: a.atm_id, location: a.location, txn_count: a.txn_count, amount: round(a.amount), account_count: a.accounts.size }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10),
    top_merchants: [...byMerchant.values()]
      .map((m) => ({ ...m, amount: round(m.amount) }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 10),
  };
}

// ─── Module — money-flow network ───────────────────────────────────────

/**
 * Account-to-account money-flow graph (Module 1).
 *
 *   • top_edges      — the heaviest source→destination transfer relationships
 *                      (aggregated across every hop between the pair).
 *   • aggregators    — collector accounts ranked by fan-in (distinct senders),
 *                      with total money in vs out.
 *   • circular_flows — accounts that route money to themselves (self-referential
 *                      rows, e.g. wallet round-trips) — a layering red flag.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @param {Map<string, any>} rollup - Output of buildAccountRollup.
 * @returns {{ top_edges: Array<object>, aggregators: Array<object>,
 *   circular_flows: Array<object>, edge_count: number, collector_count: number,
 *   circular_count: number }} The three arrays are capped at 10 for display; the
 *   `*_count` fields are the true totals of the full sets (collectors = in-degree ≥ 2).
 */
/**
 * Shape the per-layer aggregate gathered in {@link moneyFlowNetwork} into a
 * Sankey-ready { nodes, links } graph: an origin (victim inflow) node, one node
 * per laundering layer, and two terminal sink nodes (cashed out / on hold).
 * Each link carries BOTH the gross and the disputed (fraud-traced) sum, so the
 * page can toggle between the two views without a second backend shape.
 *
 * Honest by construction. Every HOP rupee is a forward band, every EXIT rupee a
 * cash-out sink link, every HOLD rupee an on-hold sink link. Forward bands are
 * consecutive: money received AT layer N is, by the NCRP layering definition,
 * money FROM layer N-1, so each band keys on the row's own (authoritative)
 * layer_no. A gap in the source file's layer numbering folds forward to the
 * nearest lower present layer rather than inventing an empty phantom layer.
 * Backward / cyclic movement (money returning to an earlier account) cannot be
 * drawn in a DAG, so it is surfaced in the Circular Trails / Self-Loops tables —
 * never silently dropped. Inflow per layer ties to layerAnalysis.total_amount.
 *
 * @param {Map<number, {inG:number,inD:number,coG:number,coD:number,hoG:number,hoD:number}>} layerAgg
 * @returns {{nodes:Array,links:Array}|null} null when there is no layer flow.
 */
function buildLayerFlows(layerAgg) {
  if (!layerAgg || layerAgg.size === 0) return null;
  const layers = [...layerAgg.keys()].sort((a, b) => a - b);
  const links = [];
  let prev = 'origin'; // backbone tail: the last node a forward band reached

  for (const L of layers) {
    const r = layerAgg.get(L);
    const id = `L${L}`;
    const hasInflow = r.inG > 0 || r.inD > 0;
    if (hasInflow) {
      links.push({ source: prev, target: id, gross: round(r.inG), disputed: round(r.inD) });
      prev = id;
    }
    // Sinks hang off this layer when it received a hop; otherwise off the last
    // real backbone layer (defensive: an EXIT/HOLD row whose layer never saw a
    // hop — rare — is still attributed and shown, never dropped).
    const sinkSource = hasInflow ? id : prev;
    if (r.coG > 0 || r.coD > 0) {
      links.push({ source: sinkSource, target: 'sink:cashout', gross: round(r.coG), disputed: round(r.coD) });
    }
    if (r.hoG > 0 || r.hoD > 0) {
      links.push({ source: sinkSource, target: 'sink:hold', gross: round(r.hoG), disputed: round(r.hoD) });
    }
  }

  if (links.length === 0) return null;

  // Node list in render order: origin, layers ascending, then sinks. Emit only
  // nodes a link actually references.
  const referenced = new Set();
  for (const l of links) { referenced.add(l.source); referenced.add(l.target); }
  const nodes = [];
  if (referenced.has('origin')) nodes.push({ id: 'origin', kind: 'origin', label: 'Victims' });
  for (const L of layers) {
    const id = `L${L}`;
    if (referenced.has(id)) nodes.push({ id, kind: 'layer', layer: L, label: `Layer ${L}` });
  }
  if (referenced.has('sink:cashout')) nodes.push({ id: 'sink:cashout', kind: 'sink', label: 'Cashed Out' });
  if (referenced.has('sink:hold')) nodes.push({ id: 'sink:hold', kind: 'sink', label: 'On Hold' });

  return { nodes, links };
}

function moneyFlowNetwork(txns, rollup) {
  /** @type {Map<string, any>} */
  const edges = new Map();
  // out_degree / total_out per source account, from the hop edges.
  /** @type {Map<string, { dests: Set<string>, out: number }>} */
  const outBy = new Map();
  /** @type {Map<string, any>} */
  const circular = new Map();
  // Per-layer rollup for the layer-flow Sankey (Phase 1). Gathered in the SAME
  // single pass below — { inflow, cash-out, on-hold } × { gross, disputed }.
  /** @type {Map<number, {inG:number,inD:number,coG:number,coD:number,hoG:number,hoD:number}>} */
  const layerAgg = new Map();
  const bumpLayer = (L) => {
    let r = layerAgg.get(L);
    if (!r) { r = { inG: 0, inD: 0, coG: 0, coD: 0, hoG: 0, hoD: 0 }; layerAgg.set(L, r); }
    return r;
  };

  for (const t of txns) {
    const benef = str(t.beneficiary_account);
    const victim = str(t.victim_account);
    // Canonical account identity (zero-pad collapse): "00000044021519366" and
    // "44021519366" are ONE account. Keying edges, self-loops, and out-degree on
    // these (not the raw forms) stops one account splitting into phantom suspects
    // (F4/F8/F9), and matches buildAccountRollup's account identity.
    const benefKey = canonicalAccountKey(benef);
    const victimKey = canonicalAccountKey(victim);

    // Layer-flow rollup (Phase 1 Sankey): every row contributes here, before the
    // self-loop / edge branches below `continue` out. HOP rows feed the forward
    // band into their destination layer (layerOf(t)); EXIT / HOLD rows feed the
    // per-layer cash-out / on-hold sinks. Mirrors layerAnalysis's row handling, so
    // inflow per layer reconciles with that module's total_amount.
    const lf = layerOf(t.layer_no);
    if (t.row_kind === ROW_KIND.HOP) {
      const r = bumpLayer(lf); r.inG += num(t.transaction_amount); r.inD += num(t.disputed_amount);
    } else if (t.row_kind === ROW_KIND.EXIT) {
      const r = bumpLayer(lf); r.coG += num(t.transaction_amount); r.coD += num(t.disputed_amount);
    } else if (t.row_kind === ROW_KIND.HOLD) {
      const r = bumpLayer(lf); r.hoG += num(t.transaction_amount); r.hoD += num(t.disputed_amount);
    }

    // Self-referential transfer rows (money routed back to the same account,
    // e.g. wallet round-trips). Compared on CANONICAL keys, so a row whose victim
    // and beneficiary are zero-pad variants of ONE account is a self-loop, not a
    // phantom A->B edge (F4). HOP rows qualify too (a hop onto a padding variant of
    // its own sender is still self-referential). EXIT / HOLD rows also carry
    // benef === victim via the parser cross-sheet join, but they are cash-out /
    // freeze dispositions, not circular flow, so the row_kind gate excludes them.
    if ((t.row_kind === ROW_KIND.OTHER || t.row_kind === ROW_KIND.HOP)
        && benef && victim && benefKey === victimKey) {
      let c = circular.get(victimKey);
      if (!c) { c = { account_no: benef, amount: 0, txn_count: 0 }; circular.set(victimKey, c); }
      const disp = benef.length >= victim.length ? benef : victim; // most complete form
      if (disp.length > c.account_no.length) c.account_no = disp;
      c.amount += num(t.transaction_amount); c.txn_count += 1;
      continue;
    }
    if (t.row_kind !== ROW_KIND.HOP || !benef || !victim) continue;

    const key = `${victimKey} ${benefKey}`;
    if (!edges.has(key)) {
      edges.set(key, { source: victim, destination: benef, amount: 0, disputed: 0, txn_count: 0, layers: new Set(), banks: new Set() });
    }
    const e = edges.get(key);
    e.amount += num(t.transaction_amount);     // gross throughput on this edge
    e.disputed += num(t.disputed_amount);       // fraud-traced portion (see F3)
    e.txn_count += 1;
    e.layers.add(layerOf(t.layer_no));
    if (str(t.beneficiary_bank)) e.banks.add(str(t.beneficiary_bank));

    if (!outBy.has(victimKey)) outBy.set(victimKey, { dests: new Set(), out: 0 });
    const o = outBy.get(victimKey);
    o.dests.add(benefKey); o.out += num(t.transaction_amount);
  }

  const topEdgesAll = [...edges.values()]
    .map((e) => ({
      source: e.source,
      destination: e.destination,
      amount: round(e.amount),
      disputed: round(e.disputed),
      txn_count: e.txn_count,
      layers: [...e.layers].sort((a, b) => a - b).join(','),
      banks: [...e.banks].join(', ') || null,
    }))
    .sort((a, b) => b.amount - a.amount);

  // Collectors: accounts with fan-in ≥ 2 (many senders funnelling into one — the
  // classic mule-collector signal). The threshold matches connectivity.js's
  // COLLECTOR_MIN_IN_DEGREE, so the on-screen collector list and the exported
  // dossier's aggregator table agree on what a collector is. A single-sender
  // account is NOT a collector (it used to pad this list at the in ≥ 1 threshold).
  const COLLECTOR_MIN_IN_DEGREE = 2;
  const collectorsAll = [];
  for (const a of rollup.values()) {
    const inDegree = a.senders ? a.senders.size : 0;
    if (inDegree < COLLECTOR_MIN_IN_DEGREE) continue;
    // outBy is keyed by canonical victim identity, so look it up the same way:
    // an account that receives as "0000X" but sends as "X" still matches (F8).
    const out = outBy.get(canonicalAccountKey(a.account_no));
    collectorsAll.push({
      account_no: a.account_no,
      bank: a.bank_name,
      in_degree: inDegree,
      out_degree: out ? out.dests.size : 0,
      total_in: round(a.total_received),
      total_out: round(out ? out.out : 0),
    });
  }
  collectorsAll.sort((a, b) => (b.in_degree - a.in_degree) || (b.total_in - a.total_in));

  const circularAll = [...circular.values()]
    .map((c) => ({ account_no: c.account_no, amount: round(c.amount), txn_count: c.txn_count }))
    .sort((a, b) => b.amount - a.amount);

  // Counts reflect the FULL computed sets (NOT the top-10 display slice), so the
  // page's summary cards report the true totals while the tables below stay
  // capped at 10 (captioned "top 10 of N"). Without these, the cards showed the
  // slice length (always 10), badly under-reporting the real scale.
  return {
    top_edges: topEdgesAll.slice(0, 10),
    aggregators: collectorsAll.slice(0, 10),
    circular_flows: circularAll.slice(0, 10),
    edge_count: edges.size,
    collector_count: collectorsAll.length,
    circular_count: circularAll.length,
    // Bounded layer→layer + disposition aggregate for the Money Flow Sankey
    // (Phase 1). Tens of nodes/links even at 50k txns, so it is safe to persist;
    // the full per-account edge list is NOT persisted (only top_edges above).
    layer_flows: buildLayerFlows(layerAgg),
  };
}

// ─── Module — recovery status ──────────────────────────────────────────

/**
 * Where the victim money ended up (Module 2): cashed out, frozen on hold,
 * refunded, or still recoverable — as amounts and as a share of the headline
 * victim loss, ready to render as a single coloured "fund trail" bar.
 *
 * @param {number} victimLoss - Headline disputed money that entered the network.
 * @param {number} cashedOut  - Σ cash-exit (ATM/POS/AEPS) amounts.
 * @param {number} onHold     - Σ amounts frozen by banks.
 * @param {number} [refunded=0]
 * @returns {object}
 */
function recoveryStatus(victimLoss, cashedOut, onHold, refunded = 0) {
  const base = num(victimLoss) > 0 ? num(victimLoss) : (num(cashedOut) + num(onHold) + num(refunded));
  const recoverable = Math.max(0, base - num(cashedOut) - num(onHold) - num(refunded));
  const pct = (x) => (base > 0 ? round((x / base) * 100, 1) : 0);
  return {
    base_amount: round(base),
    cashed_out: round(cashedOut),
    cashed_out_pct: pct(num(cashedOut)),
    on_hold: round(onHold),
    on_hold_pct: pct(num(onHold)),
    refunded: round(refunded),
    refunded_pct: pct(num(refunded)),
    recoverable: round(recoverable),
    recoverable_pct: pct(recoverable),
    fund_trail_bar: true,
  };
}

// ─── Module — victim accounts (Layer 0) ────────────────────────────────

/**
 * The victims behind the case (Module 4): the distinct sender accounts on the
 * first-layer hops — i.e. the "Account No./ (Wallet/PG/PA) Id" values that fed
 * money into the laundering network — with how much each sent.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {Array<{ account_no: string, txn_count: number, amount_sent: number }>}
 */
function victimAccounts(txns) {
  const hops = txns.filter((t) => t.row_kind === ROW_KIND.HOP);
  if (hops.length === 0) return [];
  const minLayer = hops.reduce((m, t) => Math.min(m, layerOf(t.layer_no)), Infinity);
  /** @type {Map<string, { account_no: string, txn_count: number, amount_sent: number }>} */
  const byVictim = new Map();
  for (const t of hops) {
    if (layerOf(t.layer_no) !== minLayer) continue;
    const v = str(t.victim_account);
    if (!v) continue;
    if (!byVictim.has(v)) byVictim.set(v, { account_no: v, txn_count: 0, amount_sent: 0 });
    const g = byVictim.get(v);
    g.txn_count += 1;
    g.amount_sent += num(t.transaction_amount);
  }
  return [...byVictim.values()]
    .map((g) => ({ ...g, amount_sent: round(g.amount_sent) }))
    .sort((a, b) => b.amount_sent - a.amount_sent);
}

// ─── Module — timeline summary (key dates) ─────────────────────────────

/**
 * Key milestone dates + response-gap metrics (Module 7). "Bank action" is the
 * first time funds were put on hold; "cashout" is the first ATM/POS withdrawal.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {object}
 */
function timelineSummary(txns) {
  let firstFraud = null, firstCashout = null, firstHold = null, lastActivity = null;
  for (const t of txns) {
    const ms = toMs(t.transaction_date);
    if (ms === null) continue;
    if (lastActivity === null || ms > lastActivity) lastActivity = ms;
    if (t.row_kind === ROW_KIND.HOP && (firstFraud === null || ms < firstFraud)) firstFraud = ms;
    if (t.row_kind === ROW_KIND.EXIT && (firstCashout === null || ms < firstCashout)) firstCashout = ms;
    if (t.row_kind === ROW_KIND.HOLD && (firstHold === null || ms < firstHold)) firstHold = ms;
  }
  const dayKey = (ms) => (ms === null ? null : istDayKey(new Date(ms).toISOString()));
  const hoursBetween = (a, b) => (a === null || b === null ? null : round((b - a) / 3_600_000, 1));
  const daysBetween = (a, b) => (a === null || b === null ? null : round((b - a) / 86_400_000, 1));
  return {
    first_fraud_date: dayKey(firstFraud),
    first_cashout_date: dayKey(firstCashout),
    first_bank_action_date: dayKey(firstHold),
    first_refund_date: null,
    timeline_span_days: daysBetween(firstFraud, lastActivity),
    fraud_to_cashout_hours: hoursBetween(firstFraud, firstCashout),
    fraud_to_bank_action_days: daysBetween(firstFraud, firstHold),
    cashout_to_bank_action_days: daysBetween(firstCashout, firstHold),
  };
}

// ─── Module — investigation roadmap ────────────────────────────────────

/**
 * Auto-generated, prioritised action plan (Module 3) derived from the other
 * modules. P0 = act in 24-48h, P1 = within a week, P2 = 2-4 weeks, P3 = routine.
 *
 * @param {{ mules?: Array<any>, liens?: Array<any>, geography?: any, recovery?: any }} ctx
 * @returns {Array<{ priority: string, title: string, description: string, action_type: string }>}
 */
function investigationRoadmap(ctx) {
  const { mules = [], liens = [], geography = {} } = ctx;
  const roadmap = [];

  // P0 — freeze critical-risk mules.
  const critical = mules.filter((m) => m.mule_score >= RISK_HIGH);
  if (critical.length > 0) {
    const names = critical.slice(0, 3)
      .map((m) => `${m.account_no}${m.bank_name ? ` (${m.bank_name})` : ''}`).join(', ');
    roadmap.push({
      priority: 'P0',
      title: `Freeze ${critical.length} critical-risk mule account(s) immediately`,
      description: `Mule score ≥ ${RISK_HIGH}. Includes: ${names}${critical.length > 3 ? ', …' : ''}.`,
      action_type: 'freeze',
    });
  }

  // P0 — lien recovery.
  if (liens.length > 0) {
    const total = liens.reduce((s, l) => s + num(l.lien_eligible_amount), 0);
    const top = liens[0];
    roadmap.push({
      priority: 'P0',
      title: `Pursue lien recovery of ${formatINR(total)} across ${liens.length} account(s)`,
      description: `Top target: ${top.account_no}${top.bank_name ? ` at ${top.bank_name}` : ''} ` +
        `(${formatINR(top.lien_eligible_amount)}).`,
      action_type: 'lien',
    });
  }

  // P1 — KYC + statements for high-velocity collectors.
  const collectors = mules.filter((m) => (m.appears_in_cases > 1) || (m.txn_count >= HIGH_TXN_COUNT));
  if (collectors.length > 0) {
    roadmap.push({
      priority: 'P1',
      title: `Obtain KYC & statements for ${collectors.length} high-activity account(s)`,
      description: 'Accounts that collect from many senders or transact at high velocity — ' +
        'request account-opening forms, registered mobile/email, and full statements.',
      action_type: 'evidence',
    });
  }

  // P2 — cross-reference against the national database.
  if (mules.length > 0) {
    const n = Math.min(mules.length, 10);
    roadmap.push({
      priority: 'P2',
      title: 'Cross-reference suspect accounts against I4C / NCRP database',
      description: `Submit ${n} flagged account(s) for correlation with other cases.`,
      action_type: 'cross_reference',
    });
  }

  // P3 — preserve CCTV at the busiest cash-out points.
  const atms = (geography.top_atms || []).slice(0, 2);
  if (atms.length > 0) {
    const where = atms
      .map((a) => `ATM ${a.atm_id} (${formatINR(a.amount)}, ${a.txn_count} txns)`).join(', ');
    roadmap.push({
      priority: 'P3',
      title: 'Preserve CCTV footage at top ATM locations',
      description: where,
      action_type: 'evidence',
    });
  }

  return roadmap;
}

// ─── Module 8 — key findings ───────────────────────────────────────────

/**
 * Auto-generate 5-10 short, actionable findings for the investigating
 * officer from the other modules' results.
 *
 * @param {{
 *   layers?: Array<any>, cashout?: any, mules?: Array<any>,
 *   liens?: Array<any>, repeats?: Array<any>, geography?: any,
 * }} results
 * @returns {string[]}
 */
function keyFindings(results) {
  const { cashout, mules = [], liens = [], repeats = [], geography } = results;
  const findings = [];

  // 0. Headline victim loss (money that entered the network at the first layer).
  if (results.victim_loss && results.victim_loss > 0) {
    const recov = results.recovery;
    // Percentages are computed live from recovery_status (which reads the single
    // capped cash-out figure), so the split always reconciles to 100% of the loss.
    const tail = recov
      ? ` — ${formatINR(recov.cashed_out)} (${recov.cashed_out_pct}%) already cashed out, ` +
        `${formatINR(recov.on_hold)} (${recov.on_hold_pct}%) on hold, ` +
        `${formatINR(recov.recoverable)} (${recov.recoverable_pct}%) still recoverable.`
      : '.';
    findings.push(`Victim loss of ${formatINR(results.victim_loss)} entered the laundering network${tail}`);
  }

  // 1. Cashout urgency — the confirmed total and its share of the victim loss,
  //    kept SEPARATE from the fastest single extraction. The fastest figure is
  //    one withdrawal's victim-debit-to-cash-out gap; appending it to the total
  //    (the old wording) misread as "the whole sum left in 0.1 hours".
  if (cashout && cashout.total_cashout_amount > 0) {
    const recov = results.recovery;
    const topState = cashout.cashout_by_state[0];
    const where = topState ? ` in ${topState.state}` : '';
    const pctOfLoss = recov && recov.cashed_out_pct != null
      ? ` (${recov.cashed_out_pct}% of the victim loss)`
      : '';
    findings.push(
      `${formatINR(cashout.total_cashout_amount)}${pctOfLoss} already confirmed cashed out` +
      `${where} — immediate action needed.`
    );
    // Fastest SINGLE extraction — a separate fact, only when it exists.
    if (cashout.fastest_cashout_hours !== null && cashout.fastest_cashout_hours !== undefined
      && Number.isFinite(cashout.fastest_cashout_hours)) {
      findings.push(
        `Fastest extraction: a single cash-out occurred just ` +
        `${round(cashout.fastest_cashout_hours, 2)} hours after the victim debit.`
      );
    }
  }

  // 2. Same-day cashouts.
  if (cashout && cashout.same_day_cashouts > 0) {
    findings.push(
      `${cashout.same_day_cashouts} same-day ATM cashout(s) detected — ` +
      `funds withdrawn the day they were received.`
    );
  }

  // 3. ATM hotspot.
  if (cashout && cashout.atm_cashouts.length > 0) {
    const top = cashout.atm_cashouts[0];
    if (top.count > 1) {
      findings.push(
        `ATM ${top.atm_id}${top.atm_location ? ` (${top.atm_location})` : ''} ` +
        `used ${top.count} times for ${formatINR(top.amount)} — likely cashout hub.`
      );
    }
  }

  // 4. High-risk mules, grouped by layer.
  const highs = mules.filter((m) => m.risk_label === 'HIGH');
  if (highs.length > 0) {
    /** @type {Map<number, number>} */
    const byLayer = new Map();
    for (const m of highs) {
      const l = m.layer_no == null ? -1 : m.layer_no;
      byLayer.set(l, (byLayer.get(l) || 0) + 1);
    }
    const [layer, count] = [...byLayer.entries()].sort((a, b) => b[1] - a[1])[0];
    findings.push(
      `${count} high-risk mule account(s)${layer >= 0 ? ` at Layer ${layer}` : ''} — ` +
      `recommend priority lien on these accounts.`
    );
  }

  // 5. Total lien-eligible balance (NOT "recoverable" — this per-account sum can
  // exceed the victim loss as funds traverse layers; the recoverable residual is
  // reported in finding #0 instead).
  if (liens.length > 0) {
    const total = liens.reduce((s, l) => s + num(l.lien_eligible_amount), 0);
    findings.push(
      `Total lien-eligible balance across ${liens.length} flagged account(s): ${formatINR(total)} ` +
      '(may exceed victim loss as funds traverse multiple layers).'
    );
  }

  // 6. Repeat / known-mule accounts.
  if (repeats.length > 0) {
    const known = repeats.filter((r) => r.is_known_repeat).length;
    findings.push(
      `${repeats.length} account(s) span multiple cases` +
      `${known > 0 ? ` (${known} already flagged in prior reports)` : ''} — ` +
      `organised network indicator.`
    );
  }

  // 7. Geographic concentration.
  if (geography && geography.by_state.length > 0) {
    const top = geography.by_state[0];
    findings.push(
      `Highest exposure in ${top.state}: ${formatINR(top.amount)} across ` +
      `${top.count} transaction(s).`
    );
  }

  // 8. Top suspect callout.
  if (mules.length > 0 && mules[0].mule_score >= RISK_MEDIUM) {
    const m = mules[0];
    findings.push(
      `Top suspect account ${m.account_no}${m.bank_name ? ` (${m.bank_name})` : ''} — ` +
      `mule risk score ${m.mule_score}, ${formatINR(m.total_received)} routed through it.`
    );
  }

  return findings.slice(0, 10);
}

// ─── Main entry point ──────────────────────────────────────────────────

/**
 * Run the full analysis pipeline over a report's transactions.
 *
 * Each module is fault-isolated: a thrown error is captured in `result.errors`
 * and the remaining modules still run, so a single bad module degrades the
 * report rather than failing it. The result is therefore always returned,
 * possibly partial.
 *
 * If `options.db` is supplied, the analyzer writes the two derived columns
 * (`same_day_cashout`, `cashout_mode`) back onto each transaction row that
 * carries an `id`, via queries.updateTransactionCashout.
 *
 * @param {number} reportId - The ncrp_reports id this analysis belongs to.
 * @param {ReadonlyArray<Record<string, unknown>>} transactions - Canonical
 *   transaction rows (ideally including `id` for cashout write-back).
 * @param {ReadonlyArray<Record<string, unknown>>} [existingRepeatAccounts=[]]
 *   Cross-case registry rows from the DB.
 * @param {{ db?: import('better-sqlite3').Database }} [options={}]
 * @returns {Promise<{
 *   report_id: number,
 *   generated_at: string,
 *   summary: {
 *     total_transactions: number, total_disputed_amount: number,
 *     total_layers: number, total_accounts: number,
 *     recoverable_residual: number, lien_table_total: number,
 *     fraud_start_date: string|null,
 *   },
 *   layer_analysis: Array<any>,
 *   cashout_analysis: any,
 *   mule_detection: Array<any>,
 *   lien_calculation: Array<any>,
 *   repeat_accounts: Array<any>,
 *   timeline: Array<any>,
 *   geography: any,
 *   key_findings: string[],
 *   transactions_updated: number,
 *   errors: Array<{ module: string, error: string }>,
 * }>}
 *
 * @example
 *   const { analyzeReport } = require('./analyzers/analyzer');
 *   const result = await analyzeReport(reportId, rows, repeats, { db });
 *   //   result.mule_detection[0].risk_label → 'HIGH'
 *   //   result.cashout_analysis.fastest_cashout_hours → 6.0
 */
async function analyzeReport(reportId, transactions, existingRepeatAccounts = [], options = {}) {
  const txns = Array.isArray(transactions) ? transactions : [];
  /** @type {Array<{ module: string, error: string }>} */
  const errors = [];

  /**
   * Run one module, isolating failure.
   * @template T
   * @param {string} name
   * @param {() => T} fn
   * @param {T} fallback
   * @returns {T}
   */
  const runModule = (name, fn, fallback) => {
    try {
      return fn();
    } catch (err) {
      errors.push({ module: name, error: err && err.message ? err.message : String(err) });
      return fallback;
    }
  };

  // Enrichment (cashout classification + same-day) underpins everything else,
  // so it runs first and degrades to the raw rows if it somehow throws.
  const enriched = runModule(
    'enrichTransactions',
    () => enrichTransactions(txns),
    txns.map((t) => ({ ...t, cashout_mode: CASHOUT_MODE.UNKNOWN, same_day_cashout: 0 }))
  );

  // Optional write-back of derived columns. Wrap the whole sweep in a single
  // SQLite transaction: on a 50k-row file this is the difference between one
  // fsync and 50k of them (each bare UPDATE auto-commits otherwise), and was
  // the dominant cost of analysing a large report. better-sqlite3's
  // db.transaction() returns a function that runs the body atomically.
  let transactionsUpdated = 0;
  if (options && options.db) {
    transactionsUpdated = runModule('cashoutWriteback', () => {
      const writeAll = options.db.transaction((rows) => {
        let n = 0;
        for (const t of rows) {
          if (t.id === undefined || t.id === null) continue;
          n += updateTransactionCashout(options.db, t.id, {
            same_day_cashout: t.same_day_cashout,
            cashout_mode: t.cashout_mode,
          });
        }
        return n;
      });
      return writeAll(enriched);
    }, 0);
  }

  // Deduplicate the SAME money re-listed across channel sheets before any
  // analysis (BUG 1). Write-back above already stamped every raw row; analysis
  // runs on the collapsed set so amounts and counts aren't multiplied.
  const deduped = runModule('dedupe', () => dedupeRows(enriched), { rows: enriched, removed: 0 });
  const rows = deduped.rows;
  const duplicateCount = deduped.removed;

  // Shared rollup (mule + lien depend on it). If it fails, those two modules
  // fall back to empty via their own runModule wrappers using an empty Map.
  const rollup = runModule('accountRollup', () => buildAccountRollup(rows), new Map());

  const layers = runModule('layerAnalysis', () => layerAnalysis(rows), []);
  const cashout = runModule('cashoutAnalysis', () => cashoutAnalysis(rows), {
    total_cashout_amount: 0, total_cashout_transactions: 0, atm_cashouts: [],
    same_day_cashouts: 0, cashout_by_state: [], fastest_cashout_hours: null,
  });
  const mules = runModule(
    'muleDetection',
    () => muleDetection(rows, rollup, existingRepeatAccounts),
    []
  );
  const liens = runModule('lienCalculation', () => lienCalculation(rollup), []);
  const lien_excluded = runModule('lienExclusions', () => lienExclusions(rollup), []);
  const data_quality = runModule('dataQuality', () => dataQuality(rows), []);
  const data_quality_summary = runModule(
    'dataQualitySummary',
    () => dataQualitySummary(rows, data_quality, liens),
    {
      total_accounts: 0, flagged_accounts: 0, pct_affected: 0,
      counts: { IFSC_TEXT_MISMATCH: 0, UNKNOWN_IFSC_PREFIX: 0, INVALID_IFSC: 0, NO_IFSC: 0 },
      actionable_accounts: 0,
      actionable_counts: { INVALID_IFSC: 0, UNKNOWN_IFSC_PREFIX: 0, NO_IFSC: 0 },
      informational: { auto_corrected: 0, expected_no_ifsc: 0 },
      freeze_target_total: 0, freeze_target_flags: 0, freeze_target_accounts: [],
      status: 'green',
    }
  );

  // Cash-out figure — single, explicit policy (lib/cashoutPolicy.js). Cap each
  // account's cashed-out at its disputed inflow so fraud proceeds withdrawn can
  // never exceed what the account received as disputed funds; the excess is the
  // account's own/clean money. Replaces the legacy uncapped sum and stops the
  // figure from drifting vs the gold standard.
  const cashoutPolicyResult = runModule('cashoutPolicy', () => {
    const receivedByAccount = new Map();
    const cashedByAccount = new Map();
    for (const [acct, a] of rollup.entries()) {
      receivedByAccount.set(acct, num(a.disputed_received));
      const c = num(a.total_cashed_out);
      if (c > 0) cashedByAccount.set(acct, c);
    }
    return computeCashedOut(receivedByAccount, cashedByAccount, CASHOUT_POLICY);
  }, { total: round(cashout.total_cashout_amount), perAccount: new Map() });

  // Apply the policy to the headline figure, preserving the uncapped sum for
  // audit. atm_cashouts / cashout_by_state remain the raw operational legs.
  // `cappedCashedOut` is the SINGLE SOURCE OF TRUTH for "confirmed cashed out":
  // every consumer (cashout view, recovery status, recoverable residual,
  // summary, PDF, Excel, key findings) reads this one value, so the figure can
  // never disagree between views.
  const cappedCashedOut = round(cashoutPolicyResult.total);
  cashout.total_cashout_amount_uncapped = cashout.total_cashout_amount;
  cashout.total_cashout_amount = cappedCashedOut;
  cashout.cashout_policy = CASHOUT_POLICY;
  const repeats = runModule(
    'repeatAccountDetection',
    () => repeatAccountDetection(rows, existingRepeatAccounts),
    []
  );
  const timeline = runModule('timelineAnalysis', () => timelineAnalysis(rows), []);
  const timeline_summary = runModule('timelineSummary', () => timelineSummary(rows), {});
  const geography = runModule('geographyAnalysis', () => geographyAnalysis(rows), {
    by_state: [], by_city: [], top_atms: [], top_merchants: [],
  });
  const money_flow_network = runModule(
    'moneyFlowNetwork',
    () => moneyFlowNetwork(rows, rollup),
    { top_edges: [], aggregators: [], circular_flows: [] }
  );
  // Circular-flow detection (Feature 1): real simple cycles (length <= 6) in the
  // hop graph — distinct from money_flow_network.circular_flows, which only flags
  // single-account self-loops. detectCycles reuses the shared directed graph.
  // withTotal surfaces the pre-cap count so the Money Flow page (and dossier) can
  // caption the top-10 cycles table "top 10 of N" instead of looking complete.
  const cycleResult = runModule('cycleDetector', () => detectCycles(rows, { withTotal: true }), { cycles: [], total: 0 });
  const circular_flows = cycleResult.cycles;
  const circular_cycle_count = cycleResult.total;
  // Account connectivity / aggregator analysis (Feature 2): per-account in/out
  // degree over the same hop graph, with collectors (in-degree >= 2) ranked.
  const connectivity = runModule(
    'connectivity',
    () => analyzeConnectivity(rows),
    { accounts: [], collectors: [], in_degree_by_account: new Map() }
  );
  // Day-of-week breakdown (Feature 5): dated legs grouped by IST weekday, with an
  // explicit Undated bucket so counts foot to the full leg total.
  const day_of_week = runModule(
    'dayOfWeek',
    () => dayOfWeekBreakdown(rows),
    { weekdays: [], undated: { weekday: 'Undated', txns: 0, totalAmount: 0 } }
  );
  const victim_accounts = runModule('victimAccounts', () => victimAccounts(rows), []);

  // ── Headline money figures (the "show both" model) ────────────────────
  // victim_loss = disputed money entering the network at its first hop layer
  //   (the actual victim loss — file 1 reproduces CypherSOL's ₹10.65L exactly).
  // total_trail_disputed = disputed summed across every leg (a reference figure;
  //   it re-counts the same money as it flows deeper).
  const money = runModule('moneyTotals', () => {
    const hops = rows.filter((t) => t.row_kind === ROW_KIND.HOP);
    const minHopLayer = hops.length
      ? hops.reduce((m, t) => Math.min(m, layerOf(t.layer_no)), Infinity)
      : null;
    const victimLoss = minHopLayer === null ? 0 : hops
      .filter((t) => layerOf(t.layer_no) === minHopLayer)
      .reduce((s, t) => s + num(t.disputed_amount), 0);
    // Raw cash-exit sum (every ATM/POS/AEPS leg) — kept for audit only. The
    // figure every consumer reads is the policy-capped `cappedCashedOut`
    // (CAP_AT_RECEIVED), so recovery math can't exceed disputed inflow.
    const cashedOutRaw = rows
      .filter((t) => t.row_kind === ROW_KIND.EXIT)
      .reduce((s, t) => s + num(t.transaction_amount), 0);
    const onHold = rows
      .filter((t) => t.row_kind === ROW_KIND.HOLD)
      .reduce((s, t) => s + num(t.transaction_amount), 0);
    const trailDisputed = rows.reduce((s, t) => s + num(t.disputed_amount), 0);
    return {
      hopCount: hops.length,
      benefAccounts: new Set(hops.map((t) => str(t.beneficiary_account)).filter(Boolean)).size,
      victimLoss: round(victimLoss),
      cashedOut: cappedCashedOut,          // single source of truth (capped)
      cashedOutRaw: round(cashedOutRaw),   // uncapped, audit only
      onHold: round(onHold),
      trailDisputed: round(trailDisputed),
    };
  }, {
    hopCount: 0, benefAccounts: 0, victimLoss: 0,
    cashedOut: cappedCashedOut, cashedOutRaw: 0, onHold: 0, trailDisputed: 0,
  });

  // ── Reconciliation buckets (headline ⟷ annexure footing) ──────────────
  // The headline counts every parsed leg, but the per-layer table (Annexure A)
  // sums disputed_amount on HOP legs only, and the daily timeline (Annexure G)
  // drops undated rows. Expose the residual buckets so those annexures can foot
  // to the headline explicitly instead of silently dropping rows. Derived from
  // the SAME deduped `rows`/`enriched` the headline + annexures use — never
  // recomputed independently — so the parts provably sum to the headline.
  const reconciliation = runModule('reconciliation', () => {
    let hop = 0, exit = 0, hold = 0, other = 0;
    for (const t of rows) {
      const d = num(t.disputed_amount);
      if (t.row_kind === ROW_KIND.HOP) hop += d;
      else if (t.row_kind === ROW_KIND.EXIT) exit += d;
      else if (t.row_kind === ROW_KIND.HOLD) hold += d;
      else other += d;
    }
    // Raw hop disputed BEFORE de-dup — every "Money Transfer to" leg, including
    // exact-duplicate rows (Feature 3). `dedup_hop_adjustment` is the disputed
    // value carried by the collapsed EXACT-duplicate hop legs (byte-identical on
    // sender/beneficiary/date/amount/disputed/utr; see {@link dedupeRows}), so the
    // reconciliation foots literally: raw_hop − dedup_hop_adjustment + exit + hold
    // + other === headline. (Net hop = raw_hop − dedup_hop_adjustment === the
    // per-layer Disputed column total.) The de-dup gap is a labelled line, never a
    // silent rounding. On gold case 080512 the adjustment is 0 (no exact-duplicate
    // hop leg — the two ₹500 legs differ by timestamp, the ₹409.56 leg is unique).
    let rawHop = 0;
    for (const t of enriched) {
      if (t.row_kind === ROW_KIND.HOP) rawHop += num(t.disputed_amount);
    }
    let undatedCount = 0;
    let undatedAmount = 0;
    for (const t of rows) {
      if (istDayKey(t.transaction_date) !== null) continue;
      undatedCount += 1;
      undatedAmount += num(t.transaction_amount);
    }
    return {
      disputed: {
        raw_hop: round(rawHop),                                   // Money Transfer legs incl. duplicates
        dedup_hop_adjustment: round(round(rawHop) - round(hop)),   // disputed on collapsed duplicate hop legs
        hop: round(hop), exit: round(exit), hold: round(hold), other: round(other),
        // total === hop+exit+hold+other (rounded) === raw_hop − dedup_hop_adjustment + exit + hold + other
        total: money.trailDisputed,
      },
      transactions: {
        dated: rows.length - undatedCount,
        undated: undatedCount,
        undated_amount: round(undatedAmount),
        unique: rows.length,                   // deduped legs (annexure footing)
        duplicates: duplicateCount,            // exact-duplicate rows removed
        raw_legs: enriched.length,             // === headline total_transactions
      },
    };
  }, {
    disputed: { raw_hop: 0, dedup_hop_adjustment: 0, hop: 0, exit: 0, hold: 0, other: 0, total: 0 },
    transactions: {
      dated: 0, undated: 0, undated_amount: 0,
      unique: rows.length, duplicates: duplicateCount, raw_legs: enriched.length,
    },
  });

  const recovery_status = runModule(
    'recoveryStatus',
    () => recoveryStatus(money.victimLoss, money.cashedOut, money.onHold, 0),
    {}
  );
  const investigation_roadmap = runModule(
    'investigationRoadmap',
    () => investigationRoadmap({ mules, liens, geography, recovery: recovery_status }),
    []
  );
  const findings = runModule(
    'keyFindings',
    () => keyFindings({
      layers, cashout, mules, liens, repeats, geography,
      victim_loss: money.victimLoss, recovery: recovery_status,
    }),
    []
  );

  // Summary aggregates.
  const summary = runModule('summary', () => {
    let earliest = null;
    for (const t of rows) {
      if (t.row_kind !== ROW_KIND.HOP) continue;
      const ms = toMs(t.transaction_date);
      if (ms !== null && (earliest === null || ms < earliest)) earliest = ms;
    }
    return {
      total_transactions: enriched.length,        // raw legs (matches the DB ledger)
      unique_transactions: money.hopCount,         // distinct fund-movement hops
      duplicate_count: duplicateCount,
      victim_loss_amount: money.victimLoss,        // headline "Total Fraud"
      total_disputed_amount: money.trailDisputed,  // all-layers sum (reference)
      total_trail_disputed: money.trailDisputed,
      total_layers: layers.length,
      total_accounts: money.benefAccounts,
      // cashed_out: THE single source of truth for confirmed cash-out (capped
      // per the CAP_AT_RECEIVED policy). Every consumer — recovery math, PDF,
      // Excel, key findings — reads this exact value.
      cashed_out: money.cashedOut,
      on_hold: money.onHold,
      refunded: num(recovery_status.refunded),
      // ── Two DISTINCT "recovery" figures — never conflate them ──
      // recoverable_residual: the share of the victim loss not yet cashed out,
      //   frozen, or refunded. DERIVED (never pinned) as
      //   max(0, loss − cashed_out − on_hold − refunded), so it sums with those
      //   three to exactly 100% of the loss (file1 ₹3.81L with the capped figure).
      recoverable_residual: round(Math.max(0,
        money.victimLoss - money.cashedOut - money.onHold - num(recovery_status.refunded))),
      // lien_table_total: Σ per-account lien-eligible balances. CAN exceed the
      //   victim loss because the same rupees are re-counted as they traverse
      //   layers; it drives the Lien worksheet only, never the recovery headline
      //   (file1 ₹4.34L).
      lien_table_total: round(liens.reduce((s, l) => s + num(l.lien_eligible_amount), 0)),
      // Accounts whose bank attribution needs IO review (see data_quality).
      bank_flags_count: data_quality.length,
      fraud_start_date: earliest === null
        ? null
        : dayjs.utc(earliest).add(IST_OFFSET_MINUTES, 'minute').format('YYYY-MM-DD'),
    };
  }, {
    total_transactions: enriched.length, unique_transactions: 0, duplicate_count: duplicateCount,
    victim_loss_amount: 0, total_disputed_amount: 0, total_trail_disputed: 0,
    total_layers: layers.length, total_accounts: 0,
    cashed_out: money.cashedOut, on_hold: money.onHold, refunded: num(recovery_status.refunded),
    recoverable_residual: round(Math.max(0,
      money.victimLoss - money.cashedOut - money.onHold - num(recovery_status.refunded))),
    lien_table_total: round(liens.reduce((s, l) => s + num(l.lien_eligible_amount), 0)),
    bank_flags_count: data_quality.length,
    fraud_start_date: null,
  });

  return {
    report_id: reportId,
    generated_at: new Date().toISOString(),
    summary,
    reconciliation,
    layer_analysis: layers,
    cashout_analysis: cashout,
    mule_detection: mules,
    lien_calculation: liens,
    lien_excluded,
    data_quality,
    data_quality_summary,
    repeat_accounts: repeats,
    timeline,
    timeline_summary,
    geography,
    money_flow_network,
    circular_flows,
    // True count of multi-hop cycles before the top-10 cap (circular_flows is
    // capped); lets the page caption "top 10 of N" honestly. Legacy snapshots
    // lack this field — the frontend falls back to circular_flows.length.
    circular_cycle_count,
    // Connectivity (Feature 2): full per-account in/out-degree table + the ranked
    // collector subset. `aggregators` is the collector list surfaced at the top
    // level for the summary JSON, the Excel "Account Connectivity" sheet, and the
    // PDF "Top Aggregator Accounts" table.
    connectivity: { accounts: connectivity.accounts, collectors: connectivity.collectors },
    aggregators: connectivity.collectors,
    day_of_week,
    recovery_status,
    investigation_roadmap,
    victim_accounts,
    key_findings: findings,
    transactions_updated: transactionsUpdated,
    errors,
  };
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  analyzeReport,
  // Individual modules — exported for unit tests / targeted re-runs.
  layerAnalysis,
  cashoutAnalysis,
  muleDetection,
  lienCalculation,
  lienExclusions,
  repeatAccountDetection,
  timelineAnalysis,
  timelineSummary,
  geographyAnalysis,
  moneyFlowNetwork,
  recoveryStatus,
  victimAccounts,
  investigationRoadmap,
  keyFindings,
  dataQuality,
  dataQualitySummary,
  // Exact-duplicate collapse — the single dedup definition, reused by the
  // payment-modes endpoint so the donut counts the same de-duplicated ledger as
  // every other figure (rather than re-deriving the dedup key in a second place).
  dedupeRows,
  // Helpers exposed for testing; not part of the stable contract.
  _internals: Object.freeze({
    classifyCashoutMode,
    classifyRowKind,
    enrichTransactions,
    dedupeRows,
    buildAccountRollup,
    canonicalAccountKey,
    formatINR,
    istDayKey,
    diffHours,
    CASHOUT_MODE,
    ROW_KIND,
    MULE_WEIGHTS,
    WALLET_PG_PA_RE,
  }),
};
