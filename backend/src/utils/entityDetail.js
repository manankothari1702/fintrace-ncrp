'use strict';

/**
 * FinTrace NCRP — entity drill-down detail builders (Row Drill-Down Modal).
 *
 * Given { entityType, params } the adapter for that type returns the payload
 * behind the shared <DetailModal>: identifying context, summary roll-ups, the
 * detail rows, and the searchable-field list the client filter uses.
 *
 * DESIGN CONTRACT (non-negotiable for this module):
 *   • READ-ONLY. Every adapter only queries/aggregates data that was already
 *     parsed and analysed. Nothing here introduces a new computed metric or a
 *     second way of deriving a number that exists elsewhere:
 *       – Per-entity money roll-ups are read AS-IS from the analysis snapshot
 *         (mule_detection / lien_calculation / victim_accounts / layer_analysis
 *         / cash_exit_analysis / money_flow_network / timeline). When an entity
 *         has no entry there, the roll-up is null — never recomputed.
 *       – Detail rows are the ledger rows themselves. Account rows follow the
 *         Transactions-page convention (RAW ledger incl. ⧉-flagged exact
 *         duplicates); analysis-derived sets (edge / timelineDay / layer) use
 *         the deduplicated ledger (is_duplicate = 0) because the analyzer
 *         computed those figures on the deduped trail — verified against both
 *         gold cases (…145 / …170), where timeline day counts/amounts match
 *         is_duplicate = 0 exactly and raw only where no duplicates exist.
 *   • Search semantics are defined ONCE here (`filterRows`) and returned to the
 *     client (`searchable`), so the modal's client-side filter and the Excel
 *     export's server-side filter can never disagree on which rows match.
 *
 * @module backend/src/utils/entityDetail
 */

// Entity types the routes accept. Grows per phase (A: account; B: atm/merchant/
// flagged; C: layer/edge/bank/timelineDay/transaction).
const ENTITY_TYPES = Object.freeze(['account']);

/**
 * Canonical account key — mirrors the analyzer's canonicalAccountKey and the
 * renderer's canonAcct: all-digit account numbers have leading zeros stripped
 * so "0000X" and "X" resolve to the same entity. Non-numeric ids are trimmed
 * only. Matching, not display: rows keep their original stored strings.
 *
 * @param {unknown} v
 * @returns {string}
 */
function canonAcct(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
}

/** @param {unknown} v @returns {number|null} */
function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Case-insensitive substring filter over an entity's searchable fields — THE
 * definition of "matching" for both the modal (client re-implements the same
 * rule over the same `searchable` list) and the Excel export (applied here).
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {string[]} searchable - Field names eligible for matching.
 * @param {string|null|undefined} search
 * @returns {Array<Record<string, unknown>>}
 */
function filterRows(rows, searchable, search) {
  const q = String(search == null ? '' : search).trim().toLowerCase();
  if (q === '') return rows;
  return rows.filter((row) => searchable.some((f) => {
    const v = row[f];
    return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
  }));
}

// ─── account ─────────────────────────────────────────────────────────

// Fields the account modal's search box matches (and the placeholder lists).
const ACCOUNT_SEARCHABLE = Object.freeze([
  'counterparty', 'counterparty_name', 'bank', 'ifsc', 'utr', 'mode',
  'location', 'city', 'state', 'date',
]);

/**
 * Map one ledger row to an account-modal detail row. `direction` is relative
 * to the drilled account: 'in' when it is the beneficiary, 'out' when it is
 * the sender (victim_account column) — one row can never be both (self-loops
 * A→A are shown as 'in', the beneficiary perspective).
 *
 * @param {Record<string, unknown>} t - ncrp_transactions row.
 * @param {string} canonId - canonical key of the drilled account.
 */
function accountRow(t, canonId) {
  const isIn = canonAcct(t.beneficiary_account) === canonId;
  return {
    id: t.id,
    date: t.transaction_date,
    direction: isIn ? 'in' : 'out',
    counterparty: isIn ? (t.victim_account ?? null) : (t.beneficiary_account ?? null),
    counterparty_name: isIn ? null : (t.beneficiary_name ?? null),
    bank: t.beneficiary_bank ?? null,
    ifsc: t.ifsc_code ?? null,
    amount: numOrNull(t.transaction_amount),
    disputed: numOrNull(t.disputed_amount),
    mode: t.payment_mode ?? null,
    layer: t.layer_no ?? null,
    utr: t.utr_no ?? null,
    atm_id: t.atm_id ?? null,
    location: t.atm_location ?? null,
    city: t.city ?? null,
    state: t.state ?? null,
    same_day: !!t.same_day_cashout,
    is_duplicate: !!t.is_duplicate,
  };
}

/**
 * Account drill-down: the full two-way RAW ledger for one account (every leg
 * where it is sender or receiver, chronological, duplicates ⧉-flagged), plus
 * the per-account roll-ups the analysis already computed.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: number }} report
 * @param {Record<string, any>|null} analysis
 * @param {{ id?: unknown }} params - `id` = the account number as displayed.
 */
function buildAccountDetail(db, report, analysis, params) {
  const accountId = String(params.id == null ? '' : params.id).trim();
  if (accountId === '') {
    const err = new Error('Account id is required (query param "id").');
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  const canonId = canonAcct(accountId);

  // Canonical matching needs a JS pass (leading-zero variants of the same
  // account appear across sheets); the full-ledger scan is the same access
  // pattern /payment-modes already uses.
  const all = db.prepare(
    'SELECT * FROM ncrp_transactions WHERE report_id = ? ORDER BY transaction_date ASC, id ASC'
  ).all(report.id);
  const legs = all.filter(
    (t) => canonAcct(t.victim_account) === canonId || canonAcct(t.beneficiary_account) === canonId
  );
  const rows = legs.map((t) => accountRow(t, canonId));

  // Roll-ups: read AS-IS from the analysis snapshot (see module contract).
  const a = analysis || {};
  const findByAccount = (list) => (Array.isArray(list)
    ? list.find((e) => canonAcct(e.account_no) === canonId) || null
    : null);
  const mule = findByAccount(a.mule_detection);
  const lien = findByAccount(a.lien_calculation);
  const victim = findByAccount(a.victim_accounts);
  const aggregator = findByAccount(a.aggregator_analysis && a.aggregator_analysis.accounts);

  // Bank/IFSC context: first attributed beneficiary row (same lookup the lien
  // route uses); fall back to any leg's beneficiary bank when the account only
  // appears as a sender.
  const bankLeg = legs.find((t) => canonAcct(t.beneficiary_account) === canonId && t.beneficiary_bank)
    || null;
  const bank = (mule && mule.bank_name) || (lien && lien.bank_name)
    || (bankLeg && bankLeg.beneficiary_bank) || null;
  const ifsc = (lien && lien.ifsc_code) || (bankLeg && bankLeg.ifsc_code) || null;

  // First/last seen are facts of the row set itself (rows are date-ASC; undated
  // rows sort first in SQLite, so scan for the first non-null date).
  const firstDated = rows.find((r) => r.date != null) || null;
  const lastDated = [...rows].reverse().find((r) => r.date != null) || null;

  return {
    entity_type: 'account',
    entity_id: accountId,
    context: {
      bank,
      ifsc,
      layer_no: (mule && mule.layer_no) ?? (lien && lien.layer_no) ?? null,
      mule_score: mule ? mule.mule_score : null,
      risk_label: mule ? mule.risk_label : null,
      aggregator: aggregator
        ? { distinct_senders: aggregator.distinct_senders, severity: aggregator.severity }
        : null,
      is_victim: !!victim,
    },
    summary: {
      // Gross/traced/forwarded/cashed-out: the Mule Accounts page's own figures.
      total_received: mule ? numOrNull(mule.total_received) : null,
      disputed_received: mule ? numOrNull(mule.disputed_received) : null,
      onward_forwarded: mule ? numOrNull(mule.onward_forwarded) : null,
      total_cashout: mule ? numOrNull(mule.total_cashout) : null,
      // On-hold + freezable balance: the Lien Tracker's own figures.
      total_on_hold: lien ? numOrNull(lien.total_on_hold) : null,
      lien_eligible_amount: lien ? numOrNull(lien.lien_eligible_amount) : null,
      // Victim-side outflow (layer-0 senders, not scored as mules).
      amount_sent: victim ? numOrNull(victim.amount_sent) : null,
      first_seen: firstDated ? firstDated.date : null,
      last_seen: lastDated ? lastDated.date : null,
      row_count: rows.length,
      duplicate_count: rows.reduce((s, r) => s + (r.is_duplicate ? 1 : 0), 0),
    },
    notes: mule && Array.isArray(mule.suspicion_reasons) ? mule.suspicion_reasons : [],
    rows,
    searchable: [...ACCOUNT_SEARCHABLE],
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────

const BUILDERS = Object.freeze({
  account: buildAccountDetail,
});

/**
 * Build the drill-down payload for one entity.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {{ id: number }} report - ncrp_reports row.
 * @param {Record<string, any>|null} analysis - parsed analysis_json (or null).
 * @param {string} type - one of {@link ENTITY_TYPES}.
 * @param {Record<string, unknown>} params - type-specific identifier params.
 * @throws {Error & { code: string }} VALIDATION_FAILED on bad/missing params.
 */
function buildEntityDetail(db, report, analysis, type, params) {
  const builder = BUILDERS[type];
  if (!builder) {
    const err = new Error(`Unknown entity type "${type}".`);
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  return builder(db, report, analysis, params || {});
}

module.exports = {
  ENTITY_TYPES,
  buildEntityDetail,
  filterRows,
  canonAcct,
};
