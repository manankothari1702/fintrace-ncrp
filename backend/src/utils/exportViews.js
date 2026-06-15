'use strict';

/**
 * Writer-side presentation views shared by the PDF dossier and the XLSX
 * workbook. PRESENTATION ONLY — nothing here feeds back into the analyzer or
 * changes any money figure; it re-scopes and reconciles values the analyzer
 * already produced.
 *
 * Why this exists: the analyzer's `cashout_mode` deliberately buckets every
 * leg that carries a terminal id in `atm_id` as ATM (POS legs carry their
 * terminal id in the same column), because same-day-cashout detection and the
 * gold-standard figures depend on that classification. For *display*, however,
 * an officer must see POS merchant cash-outs under POS — never inside the ATM
 * withdrawal table. The raw ledger's `payment_mode` column is the ground truth
 * for that split, so these helpers scope the analyzer's terminal aggregates by
 * payment mode and compute the gross-vs-confirmed reconciliation both exports
 * print next to their cash-out breakdowns.
 *
 * @module backend/src/utils/exportViews
 */

/** @param {unknown} v */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** @param {unknown} v */
function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** Round to 2 decimals (money display). @param {number} v */
function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/** True when the raw leg is a POS cash-out. @param {Record<string, unknown>} t */
function isPosLeg(t) {
  return (str(t.payment_mode) || '').toUpperCase() === 'POS';
}

/** True when the raw leg is an ATM/AEPS cash-out by payment mode. @param {Record<string, unknown>} t */
function isAtmLeg(t) {
  const mode = (str(t.payment_mode) || '').toUpperCase();
  return mode.includes('ATM') || mode.includes('AEPS');
}

/**
 * The raw POS legs of the ledger (the rows the "POS Exit Details" sheet lists).
 * @param {ReadonlyArray<Record<string, unknown>>} transactions
 */
function posExitRows(transactions) {
  return (transactions || []).filter(isPosLeg);
}

/**
 * POS merchant cash-outs aggregated by (merchant, terminal). Merchant name and
 * terminal id live in the `atm_location` / `atm_id` columns for POS legs.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} transactions - Raw ledger.
 * @returns {Array<{ name: string, terminal_id: string, type: string,
 *   amount: number, txn_count: number }>} Sorted by amount descending.
 */
function posMerchantAggregates(transactions) {
  /** @type {Map<string, any>} */
  const byMerchant = new Map();
  for (const t of posExitRows(transactions)) {
    const name = str(t.atm_location) || str(t.beneficiary_name) || 'UNKNOWN_MERCHANT';
    const terminal = str(t.atm_id) || '—';
    const key = `${name}|${terminal}`;
    if (!byMerchant.has(key)) {
      byMerchant.set(key, { name, terminal_id: terminal, type: 'Merchant', amount: 0, txn_count: 0 });
    }
    const m = byMerchant.get(key);
    m.amount += num(t.transaction_amount);
    m.txn_count += 1;
  }
  return [...byMerchant.values()]
    .map((m) => ({ ...m, amount: round2(m.amount) }))
    .sort((a, b) => b.amount - a.amount);
}

/**
 * Scope the analyzer's per-terminal cash-out aggregates to ATM withdrawals
 * only, dropping terminals that the raw ledger shows are POS merchant
 * terminals. A terminal id seen on BOTH ATM and POS legs (never observed in
 * real NCRP files) is kept on the ATM side so no withdrawal disappears.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} atmCashouts -
 *   `analysis.cashout_analysis.atm_cashouts` (post-dedup terminal aggregates).
 * @param {ReadonlyArray<Record<string, unknown>>} transactions - Raw ledger.
 * @returns {Array<Record<string, unknown>>} The ATM-only subset, order kept.
 */
function atmOnlyCashouts(atmCashouts, transactions) {
  const posIds = new Set();
  const atmIds = new Set();
  for (const t of (transactions || [])) {
    const id = str(t.atm_id);
    if (!id) continue;
    if (isPosLeg(t)) posIds.add(id);
    else if (isAtmLeg(t)) atmIds.add(id);
  }
  return (atmCashouts || []).filter((a) => {
    const id = str(a.atm_id);
    if (!id) return true;
    return !(posIds.has(id) && !atmIds.has(id));
  });
}

/**
 * Distinct accounts that used a terminal, from the raw ledger (the analyzer's
 * terminal aggregates don't carry an account count).
 *
 * @param {ReadonlyArray<Record<string, unknown>>} transactions
 * @returns {Map<string, number>} atm_id -> distinct account count.
 */
function accountCountByTerminal(transactions) {
  /** @type {Map<string, Set<string>>} */
  const sets = new Map();
  for (const t of (transactions || [])) {
    const id = str(t.atm_id);
    if (!id) continue;
    const acct = str(t.beneficiary_account) || str(t.victim_account);
    if (!acct) continue;
    if (!sets.has(id)) sets.set(id, new Set());
    sets.get(id).add(acct);
  }
  return new Map([...sets.entries()].map(([id, s]) => [id, s.size]));
}

/**
 * The gross-vs-confirmed cash-out reconciliation both exports print, so a
 * reader who sums the ATM/POS detail tables sees exactly why that gross
 * differs from the confirmed headline:
 *
 *   gross shown − duplicates included − cap excess = confirmed headline
 *
 * The detail tables show post-dedup figures, so `dup_amount_shown` is normally
 * 0 (the `dup_rows_collapsed` ledger rows were removed before analysis); it
 * goes positive only if a detail table ever lists raw rows that the analyzer
 * collapsed. `cap_excess` is the per-account excess over disputed inflow
 * (uncapped − capped), straight from the analyzer's two figures.
 *
 * @param {{ summary?: Record<string, unknown>, cashout?: Record<string, unknown> }} analysisViews
 * @param {number} grossShown - Sum of the amounts the detail tables display.
 * @param {number} rowsShown - Transaction rows the detail tables represent.
 * @returns {{ gross_shown: number, rows_shown: number, dup_rows_collapsed: number,
 *   dup_amount_shown: number, cap_excess: number, confirmed: number }}
 */
function cashoutReconciliation({ summary = {}, cashout = {} }, grossShown, rowsShown) {
  const confirmed = num(summary.cashed_out ?? cashout.total_cashout_amount);
  const uncapped = cashout.total_cashout_amount_uncapped != null
    ? num(cashout.total_cashout_amount_uncapped)
    : num(grossShown);
  return {
    gross_shown: round2(num(grossShown)),
    rows_shown: num(rowsShown),
    dup_rows_collapsed: num(summary.duplicate_count),
    dup_amount_shown: round2(Math.max(0, num(grossShown) - uncapped)),
    cap_excess: round2(uncapped - confirmed),
    confirmed: round2(confirmed),
  };
}

module.exports = {
  posExitRows,
  posMerchantAggregates,
  atmOnlyCashouts,
  accountCountByTerminal,
  cashoutReconciliation,
};
