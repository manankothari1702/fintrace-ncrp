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
 * Annotate every transaction with its computed `cashout_mode` and
 * `same_day_cashout` (FR-11 + FR-12) on a shallow copy, leaving the inputs
 * untouched.
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
    return { ...t, cashout_mode: cashoutMode, same_day_cashout: sameDay };
  });
}

// ─── Module 1 — layer analysis ─────────────────────────────────────────

/**
 * Per-layer aggregates plus the average time funds dwell before being
 * forwarded to the next layer.
 *
 * Forward-time model: for each beneficiary account in layer N, take the
 * earliest moment it received funds in layer N, and the earliest transaction
 * in layer N+1 sharing the same ack_no; the positive hour gap between them is
 * that account's forward time. The layer's `avg_forward_time_hours` is the
 * mean of those gaps. Layers with no measurable forward (e.g. the terminal
 * layer) report null.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {Array<{
 *   layer_no: number, account_count: number, total_amount: number,
 *   disputed_amount: number, cashout_count: number,
 *   avg_forward_time_hours: number|null, unique_banks: number,
 * }>} Sorted ascending by layer_no.
 */
function layerAnalysis(txns) {
  /** @type {Map<number, any>} */
  const byLayer = new Map();
  // earliest[`${ack}|${layer}`] = min ms — for cross-layer forward timing.
  /** @type {Map<string, number>} */
  const earliestAckLayer = new Map();
  // account → { layer → earliest receipt ms } and set of acks it touches.
  /** @type {Map<string, { receipt: Map<number, number>, acks: Set<string> }>} */
  const acct = new Map();

  for (const t of txns) {
    const layer = layerOf(t.layer_no);
    const ms = toMs(t.transaction_date);
    const ackKey = str(t.ack_no) || '∅';

    if (ms !== null) {
      const k = `${ackKey}|${layer}`;
      const prev = earliestAckLayer.get(k);
      if (prev === undefined || ms < prev) earliestAckLayer.set(k, ms);
    }

    if (!byLayer.has(layer)) {
      byLayer.set(layer, {
        layer_no: layer,
        accounts: new Set(),
        banks: new Set(),
        total_amount: 0,
        disputed_amount: 0,
        cashout_count: 0,
      });
    }
    const g = byLayer.get(layer);
    const benef = str(t.beneficiary_account);
    if (benef) g.accounts.add(benef);
    const bank = str(t.beneficiary_bank);
    if (bank) g.banks.add(bank);
    g.total_amount += num(t.transaction_amount);
    g.disputed_amount += num(t.disputed_amount);
    if (t.cashout_mode === CASHOUT_MODE.ATM) g.cashout_count += 1;

    if (benef && ms !== null) {
      if (!acct.has(benef)) acct.set(benef, { receipt: new Map(), acks: new Set() });
      const a = acct.get(benef);
      a.acks.add(ackKey);
      const prevR = a.receipt.get(layer);
      if (prevR === undefined || ms < prevR) a.receipt.set(layer, ms);
    }
  }

  return [...byLayer.values()]
    .sort((a, b) => a.layer_no - b.layer_no)
    .map((g) => {
      // Average forward time for accounts that received in this layer.
      const diffs = [];
      for (const [account, info] of acct) {
        const receiptMs = info.receipt.get(g.layer_no);
        if (receiptMs === undefined) continue;
        let nextMs;
        for (const ack of info.acks) {
          const cand = earliestAckLayer.get(`${ack}|${g.layer_no + 1}`);
          if (cand !== undefined && (nextMs === undefined || cand < nextMs)) {
            nextMs = cand;
          }
        }
        if (nextMs !== undefined && nextMs >= receiptMs) {
          diffs.push((nextMs - receiptMs) / 3_600_000);
        }
      }
      const avg = diffs.length
        ? round(diffs.reduce((s, d) => s + d, 0) / diffs.length, 2)
        : null;
      return {
        layer_no: g.layer_no,
        account_count: g.accounts.size,
        total_amount: round(g.total_amount),
        disputed_amount: round(g.disputed_amount),
        cashout_count: g.cashout_count,
        avg_forward_time_hours: avg,
        unique_banks: g.banks.size,
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
 * Build a per-beneficiary-account rollup used by both mule scoring and lien
 * calculation, so the two modules agree on `total_received` / `total_forwarded`.
 *
 * Money model (single-case trail; intermediate senders are NOT recorded, so
 * onward bank-to-bank transfers out of an account are not directly observable):
 *   • total_received   = Σ inbound transaction_amount for the account.
 *   • total_cashed_out = Σ inbound withdrawn via ATM/POS here — the only funds
 *     we can *prove* left the recoverable banking system.
 *   • total_forwarded  = total_cashed_out. "Forwarded" here means "confirmed
 *     gone as cash". Onward transfers are deliberately NOT deducted: that money
 *     is still in the banking system and is recoverable by lien at whichever
 *     downstream account now holds it, so each account is held accountable for
 *     everything it received that was not converted to cash.
 *   • lien_eligible_amount = total_received − total_cashed_out (≥ 0): the
 *     disputed inflow not yet confirmed withdrawn, i.e. what a lien request can
 *     still target (the bank confirms the true balance separately).
 *   • pass_through_ratio (mule signal, NOT used for lien): the share of inflow
 *     that moved on — cash withdrawn, plus, for non-terminal accounts, the
 *     remainder presumed pushed deeper. ~1.0 marks a classic "money in, money
 *     straight out" mule; low values mark accounts where funds came to rest.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {Map<string, any>}
 */
function buildAccountRollup(txns) {
  const maxLayer = txns.reduce((m, t) => {
    const l = layerOf(t.layer_no);
    return l > m ? l : m;
  }, 0);

  /** @type {Map<string, any>} */
  const accounts = new Map();
  for (const t of txns) {
    const acct = str(t.beneficiary_account);
    if (!acct) continue;
    if (!accounts.has(acct)) {
      accounts.set(acct, {
        account_no: acct,
        bank_name: str(t.beneficiary_bank),
        ifsc_code: str(t.ifsc_code),
        names: new Set(),
        banks: new Set(),
        ifscs: new Set(),
        acks: new Set(),
        minLayer: Infinity,
        txn_count: 0,
        total_received: 0,
        total_cashed_out: 0,
        disputed_received: 0,
        disputed_cashed_out: 0,
        firstReceiptMs: null,
        firstExitMs: null,
        cashoutStates: new Set(),
        homeStates: new Set(),
      });
    }
    const a = accounts.get(acct);
    const layer = layerOf(t.layer_no);
    const amt = num(t.transaction_amount);
    const ms = toMs(t.transaction_date);

    a.txn_count += 1;
    a.total_received += amt;
    a.disputed_received += num(t.disputed_amount);
    if (str(t.beneficiary_name)) a.names.add(str(t.beneficiary_name));
    if (str(t.beneficiary_bank)) a.banks.add(str(t.beneficiary_bank));
    if (str(t.ifsc_code)) a.ifscs.add(str(t.ifsc_code));
    if (str(t.ack_no)) a.acks.add(str(t.ack_no));
    if (layer < a.minLayer) a.minLayer = layer;

    if (ms !== null && (a.firstReceiptMs === null || ms < a.firstReceiptMs)) {
      a.firstReceiptMs = ms;
    }

    if (CASH_EXIT_MODES.has(t.cashout_mode)) {
      a.total_cashed_out += amt;
      a.disputed_cashed_out += num(t.disputed_amount);
      if (ms !== null && (a.firstExitMs === null || ms < a.firstExitMs)) {
        a.firstExitMs = ms;
      }
      const cState = str(t.state);
      if (cState) a.cashoutStates.add(cState);
    } else {
      const hState = str(t.state);
      if (hState) a.homeStates.add(hState);
    }
  }

  for (const a of accounts.values()) {
    const isTerminal = a.minLayer >= maxLayer;
    const nonCashout = Math.max(0, a.total_received - a.total_cashed_out);
    // Lien target = the DISPUTED (fraud-attributed) inflow not confirmed
    // withdrawn as cash — NOT the gross transaction value. Each NCRP row carries
    // a gross transaction_amount that can dwarf its disputed slice (e.g. a
    // ₹40,00,000 transfer with only ₹500 disputed), so a transaction-based lien
    // over-states recoverable funds by orders of magnitude (~100x on real
    // files). Computed per unique account_no from the disputed_amount column.
    // Onward transfers are recoverable downstream, so they are not deducted.
    const disputedLien = Math.max(0, a.disputed_received - a.disputed_cashed_out);
    a.is_terminal = isTerminal;
    a.total_forwarded = round(a.total_cashed_out);
    a.lien_eligible_amount = round(disputedLien);
    a.disputed_received = round(a.disputed_received);
    a.disputed_cashed_out = round(a.disputed_cashed_out);
    a.total_received = round(a.total_received);
    a.total_cashed_out = round(a.total_cashed_out);
    // Mule pass-through: cash withdrawn + (non-terminal) remainder moved deeper.
    const movedOn = a.total_cashed_out + (isTerminal ? 0 : nonCashout);
    a.pass_through_ratio = a.total_received > 0
      ? round(movedOn / a.total_received, 4)
      : 0;
    a.forward_speed_hours =
      a.firstReceiptMs !== null && a.firstExitMs !== null && a.firstExitMs >= a.firstReceiptMs
        ? round((a.firstExitMs - a.firstReceiptMs) / 3_600_000, 2)
        : null;
  }
  return accounts;
}

// ─── Module 3 — mule detection ─────────────────────────────────────────

/**
 * Score every beneficiary account 0-100 across six weighted signals (weights
 * loaded from config/mule_weights.json):
 *   1. passThrough   — high forwarded/received ratio.
 *   2. cashoutSpeed  — funds left within a few hours of arriving.
 *   3. txnCount      — high transaction volume.
 *   4. crossCase     — appears across multiple cases (this file + history).
 *   5. geoSpread     — cashed out in a different state than its home/bank state.
 *   6. kycVariance   — inconsistent name / bank / IFSC across rows.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @param {Map<string, any>} rollup - Output of buildAccountRollup.
 * @param {ReadonlyArray<Record<string, unknown>>} [existingRepeatAccounts=[]]
 *   Cross-case registry rows ({ account_no, appearance_count, ... }).
 * @returns {Array<{
 *   account_no: string, bank_name: string|null, mule_score: number,
 *   pass_through_ratio: number, total_received: number, total_forwarded: number,
 *   forward_speed_hours: number|null, appears_in_cases: number,
 *   layer_no: number, risk_label: 'HIGH'|'MEDIUM'|'LOW',
 * }>} Sorted by mule_score descending.
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
    // 1. Pass-through — full weight at/above the threshold, linear below.
    const passPts = num(w.passThrough) *
      Math.min(1, a.pass_through_ratio / PASS_THROUGH_FULL);

    // 2. Cashout speed — full if forwarded fast, decaying to zero by 24h.
    let speedPts = 0;
    if (a.forward_speed_hours !== null) {
      if (a.forward_speed_hours <= FAST_FORWARD_HOURS) {
        speedPts = num(w.cashoutSpeed);
      } else if (a.forward_speed_hours < SLOW_FORWARD_HOURS) {
        const frac =
          (SLOW_FORWARD_HOURS - a.forward_speed_hours) /
          (SLOW_FORWARD_HOURS - FAST_FORWARD_HOURS);
        speedPts = num(w.cashoutSpeed) * frac;
      }
    }

    // 3. Transaction count.
    const countPts = num(w.txnCount) *
      Math.min(1, a.txn_count / HIGH_TXN_COUNT);

    // 4. Cross-case — distinct cases in this file plus historical appearances.
    const appearsInCases = Math.max(
      a.acks.size,
      (historyCount.get(a.account_no) || 0)
    );
    const crossPts = appearsInCases > 1 ? num(w.crossCase) : 0;

    // 5. Geographic spread — cashed out in a state other than its home state.
    let geoSpread = false;
    for (const cState of a.cashoutStates) {
      if (a.homeStates.size > 0 && !a.homeStates.has(cState)) {
        geoSpread = true;
        break;
      }
    }
    const geoPts = geoSpread ? num(w.geoSpread) : 0;

    // 6. KYC variance — inconsistent identity attributes across rows.
    const kycVariance = a.names.size > 1 || a.banks.size > 1 || a.ifscs.size > 1;
    const kycPts = kycVariance ? num(w.kycVariance) : 0;

    const score = Math.max(0, Math.min(100, Math.round(
      passPts + speedPts + countPts + crossPts + geoPts + kycPts
    )));

    results.push({
      account_no: a.account_no,
      bank_name: a.bank_name,
      mule_score: score,
      pass_through_ratio: a.pass_through_ratio,
      total_received: a.total_received,
      total_forwarded: a.total_forwarded,
      forward_speed_hours: a.forward_speed_hours,
      appears_in_cases: appearsInCases,
      layer_no: Number.isFinite(a.minLayer) ? a.minLayer : null,
      risk_label: score >= RISK_HIGH ? 'HIGH' : score >= RISK_MEDIUM ? 'MEDIUM' : 'LOW',
    });
  }

  return results.sort((a, b) => b.mule_score - a.mule_score);
}

// ─── Module 4 — lien calculation ───────────────────────────────────────

/**
 * Recoverable-amount worksheet: for each account still presumed to hold
 * disputed funds (received minus everything that provably left), one row with
 * the lien-eligible amount and a plain-language justification.
 *
 * @param {Map<string, any>} rollup - Output of buildAccountRollup.
 * @returns {Array<{
 *   account_no: string, bank_name: string|null, ifsc_code: string|null,
 *   layer_no: number|null, total_received: number, total_forwarded: number,
 *   lien_eligible_amount: number, note: string,
 * }>} Only accounts with lien_eligible_amount > 0, sorted by amount desc.
 */
function lienCalculation(rollup) {
  const rows = [];
  for (const a of rollup.values()) {
    if (a.lien_eligible_amount <= 0) continue;
    // Report the disputed (fraud-attributed) figures so the note arithmetic is
    // coherent with the disputed-based lien_eligible_amount. Fall back to the
    // gross totals when a caller hands a rollup without the disputed fields.
    const received = num(a.disputed_received != null ? a.disputed_received : a.total_received);
    const cashed = num(a.disputed_cashed_out != null ? a.disputed_cashed_out : a.total_forwarded);
    rows.push({
      account_no: a.account_no,
      bank_name: a.bank_name,
      ifsc_code: a.ifsc_code,
      layer_no: Number.isFinite(a.minLayer) ? a.minLayer : null,
      total_received: received,
      total_forwarded: cashed,
      lien_eligible_amount: a.lien_eligible_amount,
      note:
        `${formatINR(received)} of disputed funds received; ` +
        `${formatINR(cashed)} confirmed withdrawn as cash. ` +
        `${formatINR(a.lien_eligible_amount)} not yet confirmed withdrawn — ` +
        `request lien (subject to available balance at bank).`,
    });
  }
  return rows.sort((a, b) => b.lien_eligible_amount - a.lien_eligible_amount);
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
 * Money + transaction + cashout distribution across states and cities.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched transactions.
 * @returns {{
 *   by_state: Array<{ state: string, amount: number, count: number, cashout_count: number }>,
 *   by_city: Array<{ city: string, state: string|null, amount: number, count: number }>,
 * }}
 */
function geographyAnalysis(txns) {
  /** @type {Map<string, any>} */
  const byState = new Map();
  /** @type {Map<string, any>} */
  const byCity = new Map();

  for (const t of txns) {
    const amt = num(t.transaction_amount);
    const isCashout = CASH_EXIT_MODES.has(t.cashout_mode);

    const state = str(t.state);
    if (state) {
      if (!byState.has(state)) {
        byState.set(state, { state, amount: 0, count: 0, cashout_count: 0 });
      }
      const s = byState.get(state);
      s.amount += amt;
      s.count += 1;
      if (isCashout) s.cashout_count += 1;
    }

    const city = str(t.city);
    if (city) {
      const key = `${city}|${state || ''}`;
      if (!byCity.has(key)) {
        byCity.set(key, { city, state, amount: 0, count: 0 });
      }
      const c = byCity.get(key);
      c.amount += amt;
      c.count += 1;
    }
  }

  return {
    by_state: [...byState.values()]
      .map((s) => ({ ...s, amount: round(s.amount) }))
      .sort((a, b) => b.amount - a.amount),
    by_city: [...byCity.values()]
      .map((c) => ({ ...c, amount: round(c.amount) }))
      .sort((a, b) => b.amount - a.amount),
  };
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

  // 1. Cashout urgency.
  if (cashout && cashout.total_cashout_amount > 0) {
    const topState = cashout.cashout_by_state[0];
    const where = topState ? ` in ${topState.state}` : '';
    const speed =
      cashout.fastest_cashout_hours !== null && cashout.fastest_cashout_hours !== undefined
        ? ` within ${round(cashout.fastest_cashout_hours, 1)} hours`
        : '';
    findings.push(
      `${formatINR(cashout.total_cashout_amount)} already cashed out` +
      `${where}${speed} — immediate action needed.`
    );
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

  // 5. Total recoverable.
  if (liens.length > 0) {
    const total = liens.reduce((s, l) => s + num(l.lien_eligible_amount), 0);
    findings.push(
      `Total recoverable amount across ${liens.length} account(s): ${formatINR(total)}.`
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
      `mule score ${m.mule_score}/100, ${formatINR(m.total_received)} routed through it.`
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

  // Optional write-back of derived columns.
  let transactionsUpdated = 0;
  if (options && options.db) {
    transactionsUpdated = runModule('cashoutWriteback', () => {
      let n = 0;
      for (const t of enriched) {
        if (t.id === undefined || t.id === null) continue;
        n += updateTransactionCashout(options.db, t.id, {
          same_day_cashout: t.same_day_cashout,
          cashout_mode: t.cashout_mode,
        });
      }
      return n;
    }, 0);
  }

  // Shared rollup (mule + lien depend on it). If it fails, those two modules
  // fall back to empty via their own runModule wrappers using an empty Map.
  const rollup = runModule('accountRollup', () => buildAccountRollup(enriched), new Map());

  const layers = runModule('layerAnalysis', () => layerAnalysis(enriched), []);
  const cashout = runModule('cashoutAnalysis', () => cashoutAnalysis(enriched), {
    total_cashout_amount: 0, total_cashout_transactions: 0, atm_cashouts: [],
    same_day_cashouts: 0, cashout_by_state: [], fastest_cashout_hours: null,
  });
  const mules = runModule(
    'muleDetection',
    () => muleDetection(enriched, rollup, existingRepeatAccounts),
    []
  );
  const liens = runModule('lienCalculation', () => lienCalculation(rollup), []);
  const repeats = runModule(
    'repeatAccountDetection',
    () => repeatAccountDetection(enriched, existingRepeatAccounts),
    []
  );
  const timeline = runModule('timelineAnalysis', () => timelineAnalysis(enriched), []);
  const geography = runModule('geographyAnalysis', () => geographyAnalysis(enriched), {
    by_state: [], by_city: [],
  });
  const findings = runModule(
    'keyFindings',
    () => keyFindings({ layers, cashout, mules, liens, repeats, geography }),
    []
  );

  // Summary aggregates (independent of the modules above).
  const summary = runModule('summary', () => {
    const totalDisputed = enriched.reduce((s, t) => s + num(t.disputed_amount), 0);
    const accounts = new Set();
    let earliest = null;
    for (const t of enriched) {
      const acct = str(t.beneficiary_account);
      if (acct) accounts.add(acct);
      const ms = toMs(t.transaction_date);
      if (ms !== null && (earliest === null || ms < earliest)) earliest = ms;
    }
    return {
      total_transactions: enriched.length,
      total_disputed_amount: round(totalDisputed),
      total_layers: layers.length,
      total_accounts: accounts.size,
      fraud_start_date: earliest === null
        ? null
        : dayjs.utc(earliest).add(IST_OFFSET_MINUTES, 'minute').format('YYYY-MM-DD'),
    };
  }, {
    total_transactions: enriched.length, total_disputed_amount: 0,
    total_layers: layers.length, total_accounts: 0, fraud_start_date: null,
  });

  return {
    report_id: reportId,
    generated_at: new Date().toISOString(),
    summary,
    layer_analysis: layers,
    cashout_analysis: cashout,
    mule_detection: mules,
    lien_calculation: liens,
    repeat_accounts: repeats,
    timeline,
    geography,
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
  repeatAccountDetection,
  timelineAnalysis,
  geographyAnalysis,
  keyFindings,
  // Helpers exposed for testing; not part of the stable contract.
  _internals: Object.freeze({
    classifyCashoutMode,
    enrichTransactions,
    buildAccountRollup,
    formatINR,
    istDayKey,
    diffHours,
    CASHOUT_MODE,
    MULE_WEIGHTS,
  }),
};
