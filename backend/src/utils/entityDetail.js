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

// The analyzer's own row-kind classifier (HOP vs EXIT/HOLD/OTHER disposition).
// Reused — same precedent as the payment-modes endpoint reusing dedupeRows —
// so the edge drill counts exactly the rows the money-flow network counted,
// rather than re-deriving the hop predicate in a second place.
const { _internals: analyzerInternals } = require('../analyzers/analyzer');
const { classifyRowKind, ROW_KIND } = analyzerInternals;

// Entity types the routes accept (A: account; B: atm/merchant/cashflag;
// C: layer/edge/bank/timelineDay/transaction).
const ENTITY_TYPES = Object.freeze([
  'account', 'atm', 'merchant', 'cashflag',
  'layer', 'edge', 'bank', 'timelineDay', 'transaction',
]);

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

// ─── atm / merchant (exit terminal) ──────────────────────────────────

const TERMINAL_SEARCHABLE = Object.freeze([
  'account', 'channel', 'location', 'city', 'state', 'atm_id', 'date',
]);

const CASH_CHANNELS = Object.freeze(['ATM', 'POS', 'AEPS']);

/** Map one cash-exit channel transaction to a terminal-modal detail row. */
function terminalRow(t, channel) {
  return {
    id: t.id,
    date: t.date ?? null,
    channel,
    account: t.account ?? null,
    amount: numOrNull(t.amount),
    disputed: numOrNull(t.disputed),
    atm_id: t.atm_id ?? null,
    location: t.location ?? null,
    city: t.city ?? null,
    state: t.state ?? null,
    same_day: !!t.same_day,
  };
}

/** Chronological sort (undated rows last), stable by ledger id. */
function byDateThenId(a, b) {
  if (a.date == null && b.date == null) return (a.id || 0) - (b.id || 0);
  if (a.date == null) return 1;
  if (b.date == null) return -1;
  return a.date < b.date ? -1 : a.date > b.date ? 1 : (a.id || 0) - (b.id || 0);
}

/**
 * ATM / merchant drill-down: every cash-exit leg at one terminal id, gathered
 * across ALL channels — the Dashboard's "Top Cashout Locations" spans ATM, POS
 * and AEPS, while the Cash/Exit tabs split by channel; gathering across
 * channels makes the modal reconcile with both (verified: per-terminal sums
 * over channel.transactions equal top_points AND cashout_analysis.atm_cashouts
 * on both gold cases). The placeholder id "UNKNOWN_ATM" (the cashout table's
 * bucket for legs with no terminal id) matches blank/absent atm_id rows.
 *
 * The rows ARE the analysis snapshot's own channel transaction arrays — the
 * exact rows the Cash/Exit page renders — so the roll-up chips (sums over
 * those rows) equal the page's figures by construction.
 */
function buildTerminalDetail(db, report, analysis, params, entityType) {
  const terminalId = String(params.id == null ? '' : params.id).trim();
  if (terminalId === '') {
    const err = new Error('Terminal id is required (query param "id").');
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  const isUnknownBucket = terminalId === 'UNKNOWN_ATM';
  const channels = (analysis && analysis.cash_exit_analysis
    && analysis.cash_exit_analysis.channels) || {};

  const rows = [];
  for (const ch of CASH_CHANNELS) {
    for (const t of (channels[ch] && channels[ch].transactions) || []) {
      const tid = t.atm_id == null ? '' : String(t.atm_id).trim();
      const match = isUnknownBucket ? tid === '' : tid === terminalId;
      if (match) rows.push(terminalRow(t, ch));
    }
  }
  rows.sort(byDateThenId);

  const total = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const disputed = rows.reduce((s, r) => s + (r.disputed || 0), 0);
  const accounts = new Set(rows.map((r) => r.account).filter((a) => a != null && a !== ''));
  const channelsPresent = [...new Set(rows.map((r) => r.channel))];
  const location = (rows.find((r) => r.location) || {}).location || null;
  const firstDated = rows.find((r) => r.date != null) || null;
  const lastDated = [...rows].reverse().find((r) => r.date != null) || null;

  return {
    entity_type: entityType,
    entity_id: terminalId,
    context: {
      location,
      channels: channelsPresent,
      is_unknown_bucket: isUnknownBucket,
    },
    summary: {
      total_amount: Math.round(total * 100) / 100,
      total_disputed: Math.round(disputed * 100) / 100,
      txn_count: rows.length,
      unique_accounts: accounts.size,
      first_seen: firstDated ? firstDated.date : null,
      last_seen: lastDated ? lastDated.date : null,
      row_count: rows.length,
    },
    notes: [],
    rows,
    searchable: [...TERMINAL_SEARCHABLE],
  };
}

// ─── cashflag (behavioural flag card → pre-filtered set) ─────────────

const CASHFLAG_SEARCHABLE = Object.freeze([
  'account', 'location', 'city', 'state', 'atm_id', 'why', 'date',
]);

/**
 * Flag-card drill-down: the cash-exit transactions behind one behavioural
 * flag (rapid withdrawals / multi-ATM / suspicious merchant), each carrying
 * its instance's "why flagged" line — the same txn_ids → why mapping the
 * Cash/Exit page and generateCashExitExcel's view scope already use.
 */
function buildCashFlagDetail(db, report, analysis, params) {
  const channelKey = String(params.channel == null ? '' : params.channel).trim().toUpperCase();
  const flagKey = String(params.flag == null ? '' : params.flag).trim();
  if (!CASH_CHANNELS.includes(channelKey)) {
    const err = new Error(`channel must be one of: ${CASH_CHANNELS.join(', ')}.`);
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  if (flagKey === '') {
    const err = new Error('flag key is required (query param "flag").');
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  const channel = ((analysis && analysis.cash_exit_analysis
    && analysis.cash_exit_analysis.channels) || {})[channelKey] || {};
  const flag = (channel.flags || []).find((f) => f.key === flagKey);
  if (!flag) {
    const err = new Error(`Unknown flag "${flagKey}" for channel ${channelKey}.`);
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const whyById = new Map();
  for (const inst of flag.instances || []) {
    for (const id of inst.txn_ids || []) whyById.set(id, inst.why || flag.label);
  }
  const rows = (channel.transactions || [])
    .filter((t) => whyById.has(t.id))
    .map((t) => ({ ...terminalRow(t, channelKey), why: whyById.get(t.id) }));
  rows.sort(byDateThenId);

  const instances = flag.instances || [];
  const accounts = new Set(
    instances.map((i) => i.account).filter((a) => a != null && a !== '')
  );
  const instanceTotal = instances.reduce((s, i) => s + (Number(i.total_amount) || 0), 0);
  const firstDated = rows.find((r) => r.date != null) || null;
  const lastDated = [...rows].reverse().find((r) => r.date != null) || null;

  return {
    entity_type: 'cashflag',
    entity_id: `${channelKey}:${flagKey}`,
    context: {
      channel: channelKey,
      flag_key: flagKey,
      flag_label: flag.label || flagKey,
    },
    summary: {
      instance_count: numOrNull(flag.count) ?? instances.length,
      flagged_txn_count: rows.length,
      total_amount: Math.round(instanceTotal * 100) / 100,
      unique_accounts: accounts.size,
      first_seen: firstDated ? firstDated.date : null,
      last_seen: lastDated ? lastDated.date : null,
      row_count: rows.length,
    },
    // The per-instance "why" lines double as the modal's notes band.
    notes: instances.map((i) => i.why).filter(Boolean),
    rows,
    searchable: [...CASHFLAG_SEARCHABLE],
  };
}

// ─── layer ───────────────────────────────────────────────────────────

const LAYER_SEARCHABLE = Object.freeze(['account_no', 'bank_name', 'risk_label']);

/**
 * Layer drill-down: the scored accounts at one hop (the same mule_detection
 * subset the Layers page lists under each layer card, highest score first),
 * with the layer's own aggregates from layer_analysis as the roll-ups.
 */
function buildLayerDetail(db, report, analysis, params) {
  const raw = String(params.id == null ? '' : params.id).trim();
  if (!/^\d{1,2}$/.test(raw)) {
    const err = new Error('Layer id must be an integer 0–50 (query param "id").');
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  const layerNo = Number(raw);
  const a = analysis || {};
  const layer = (Array.isArray(a.layer_analysis) ? a.layer_analysis : [])
    .find((l) => l.layer_no === layerNo) || null;

  const rows = (Array.isArray(a.mule_detection) ? a.mule_detection : [])
    .filter((m) => m.layer_no === layerNo)
    .map((m) => ({
      id: m.account_no,
      account_no: m.account_no,
      bank_name: m.bank_name ?? null,
      total_received: numOrNull(m.total_received),
      disputed_received: numOrNull(m.disputed_received),
      total_cashout: numOrNull(m.total_cashout),
      mule_score: numOrNull(m.mule_score),
      risk_label: m.risk_label ?? null,
      txn_count: numOrNull(m.txn_count),
    }))
    .sort((x, y) => (y.mule_score || 0) - (x.mule_score || 0));

  // The hop's account_count can exceed the scored list: an account is scored
  // once, under the layer of its FIRST traced appearance, while the hop count
  // counts every distinct account the hop touches (verified on gold …145:
  // hop-3 touches 4 accounts, one of which is scored under layer 2).
  const notes = [];
  const layerAccountCount = layer ? numOrNull(layer.account_count) : null;
  if (layerAccountCount != null && rows.length !== layerAccountCount) {
    notes.push(
      `${rows.length} scored account(s) are attributed to this layer; the hop touches `
      + `${layerAccountCount} distinct account(s) in total — accounts first traced at an `
      + 'earlier layer are listed under that layer.'
    );
  }

  return {
    entity_type: 'layer',
    entity_id: String(layerNo),
    context: {
      layer_no: layerNo,
      fan_out_ratio: layer ? numOrNull(layer.fan_out_ratio) : null,
      fan_out_high: layer ? !!layer.fan_out_high : false,
      avg_forward_time_hours: layer ? numOrNull(layer.avg_forward_time_hours) : null,
    },
    summary: {
      txn_count: layer ? numOrNull(layer.txn_count) : null,
      account_count: layer ? numOrNull(layer.account_count) : null,
      bank_count: layer ? numOrNull(layer.bank_count ?? layer.unique_banks) : null,
      total_amount: layer ? numOrNull(layer.total_amount) : null,
      total_disputed: layer ? numOrNull(layer.disputed_amount) : null,
      cashout_count: layer ? numOrNull(layer.cashout_count) : null,
      row_count: rows.length,
    },
    notes,
    rows,
    searchable: [...LAYER_SEARCHABLE],
  };
}

// ─── edge (sender → receiver) ────────────────────────────────────────

const EDGE_SEARCHABLE = Object.freeze([
  'bank', 'ifsc', 'utr', 'mode', 'location', 'city', 'state', 'date',
]);

/**
 * Edge drill-down: the transactions that make up one sender→receiver edge.
 * Two-part basis, both the analyzer's own: DEDUPLICATED (is_duplicate = 0)
 * AND HOP rows only (classifyRowKind — the money-flow network is built over
 * fund movements between distinct accounts; ATM/POS/HOLD dispositions that
 * happen to name the same pair are NOT part of the edge). Only these rows sum
 * to the edge's gross/disputed figures on the Money Flow page. Roll-ups are
 * read from the top_edges entry when the edge is in the displayed top-10;
 * otherwise they are the sums over the same rows (identical basis by
 * construction).
 */
function buildEdgeDetail(db, report, analysis, params) {
  const from = String(params.from == null ? '' : params.from).trim();
  const to = String(params.to == null ? '' : params.to).trim();
  if (from === '' || to === '') {
    const err = new Error('Edge requires "from" and "to" account query params.');
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  const canonFrom = canonAcct(from);
  const canonTo = canonAcct(to);

  const all = db.prepare(
    'SELECT * FROM ncrp_transactions WHERE report_id = ? AND is_duplicate = 0 ORDER BY transaction_date ASC, id ASC'
  ).all(report.id);
  const rows = all
    .filter((t) => classifyRowKind(t) === ROW_KIND.HOP
      && canonAcct(t.victim_account) === canonFrom
      && canonAcct(t.beneficiary_account) === canonTo)
    .map((t) => ({
      id: t.id,
      date: t.transaction_date,
      amount: numOrNull(t.transaction_amount),
      disputed: numOrNull(t.disputed_amount),
      mode: t.payment_mode ?? null,
      layer: t.layer_no ?? null,
      utr: t.utr_no ?? null,
      bank: t.beneficiary_bank ?? null,
      ifsc: t.ifsc_code ?? null,
      atm_id: t.atm_id ?? null,
      location: t.atm_location ?? null,
      city: t.city ?? null,
      state: t.state ?? null,
      same_day: !!t.same_day_cashout,
    }));

  const net = (analysis && analysis.money_flow_network) || {};
  const edge = (net.top_edges || []).find(
    (e) => canonAcct(e.source) === canonFrom && canonAcct(e.destination) === canonTo
  ) || null;
  const sum = rows.reduce((s, r) => s + (r.amount || 0), 0);
  const disputedSum = rows.reduce((s, r) => s + (r.disputed || 0), 0);
  const firstDated = rows.find((r) => r.date != null) || null;
  const lastDated = [...rows].reverse().find((r) => r.date != null) || null;

  return {
    entity_type: 'edge',
    entity_id: `${from} → ${to}`,
    context: {
      from,
      to,
      layers: edge ? edge.layers : [...new Set(rows.map((r) => r.layer).filter((l) => l != null))].join(', '),
      banks: edge ? edge.banks : null,
    },
    summary: {
      txn_count: edge ? numOrNull(edge.txn_count) : rows.length,
      total_amount: edge ? numOrNull(edge.amount) : Math.round(sum * 100) / 100,
      total_disputed: edge ? numOrNull(edge.disputed) : Math.round(disputedSum * 100) / 100,
      first_seen: firstDated ? firstDated.date : null,
      last_seen: lastDated ? lastDated.date : null,
      row_count: rows.length,
    },
    notes: [],
    rows,
    searchable: [...EDGE_SEARCHABLE],
  };
}

// ─── bank ────────────────────────────────────────────────────────────

const BANK_SEARCHABLE = Object.freeze([
  'account', 'name', 'ifsc', 'utr', 'mode', 'city', 'state', 'date',
]);

/**
 * Bank drill-down: every RAW ledger leg whose beneficiary sits at that bank —
 * exactly what the Transactions page shows when filtered by the same bank
 * (its ?bank= filter matches beneficiary_bank verbatim), duplicates kept and
 * ⧉-flagged. Roll-ups are facet-style counts of the same rows (row count,
 * distinct accounts, layers touched) — no per-bank money figure exists in the
 * analysis, so none is invented; the modal footer sums the visible rows.
 */
function buildBankDetail(db, report, analysis, params) {
  const bankName = String(params.id == null ? '' : params.id).trim();
  if (bankName === '') {
    const err = new Error('Bank name is required (query param "id").');
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  const legs = db.prepare(`
    SELECT * FROM ncrp_transactions
     WHERE report_id = ? AND beneficiary_bank = ?
     ORDER BY transaction_date ASC, id ASC
  `).all(report.id, bankName);
  const rows = legs.map((t) => ({
    id: t.id,
    date: t.transaction_date,
    account: t.beneficiary_account ?? null,
    name: t.beneficiary_name ?? null,
    ifsc: t.ifsc_code ?? null,
    amount: numOrNull(t.transaction_amount),
    disputed: numOrNull(t.disputed_amount),
    mode: t.payment_mode ?? null,
    layer: t.layer_no ?? null,
    utr: t.utr_no ?? null,
    city: t.city ?? null,
    state: t.state ?? null,
    same_day: !!t.same_day_cashout,
    is_duplicate: !!t.is_duplicate,
  }));

  const accounts = new Set(rows.map((r) => r.account).filter((a) => a != null && a !== ''));
  const layers = [...new Set(rows.map((r) => r.layer).filter((l) => l != null))].sort((a, b) => a - b);
  const firstDated = rows.find((r) => r.date != null) || null;
  const lastDated = [...rows].reverse().find((r) => r.date != null) || null;

  return {
    entity_type: 'bank',
    entity_id: bankName,
    context: {
      layers_touched: layers,
    },
    summary: {
      row_count: rows.length,
      unique_accounts: accounts.size,
      layer_count: layers.length,
      duplicate_count: rows.reduce((s, r) => s + (r.is_duplicate ? 1 : 0), 0),
      first_seen: firstDated ? firstDated.date : null,
      last_seen: lastDated ? lastDated.date : null,
    },
    notes: [],
    rows,
    searchable: [...BANK_SEARCHABLE],
  };
}

// ─── timelineDay ─────────────────────────────────────────────────────

const TIMELINE_DAY_SEARCHABLE = Object.freeze([
  'from_account', 'to_account', 'bank', 'ifsc', 'utr', 'mode', 'date',
]);

/**
 * Timeline-day drill-down: the transactions on one calendar day (UTC day of
 * the stored instant — the analyzer's own bucketing). DEDUPLICATED basis
 * (is_duplicate = 0): verified against both gold cases, the timeline's
 * per-day count/amount equal the deduped rows exactly. Roll-ups read from
 * the analysis timeline entry itself.
 */
function buildTimelineDayDetail(db, report, analysis, params) {
  const day = String(params.date == null ? '' : params.date).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const err = new Error('date must be YYYY-MM-DD (query param "date").');
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  const legs = db.prepare(`
    SELECT * FROM ncrp_transactions
     WHERE report_id = ? AND is_duplicate = 0 AND substr(transaction_date, 1, 10) = ?
     ORDER BY transaction_date ASC, id ASC
  `).all(report.id, day);
  const rows = legs.map((t) => ({
    id: t.id,
    date: t.transaction_date,
    from_account: t.victim_account ?? null,
    to_account: t.beneficiary_account ?? null,
    bank: t.beneficiary_bank ?? null,
    ifsc: t.ifsc_code ?? null,
    amount: numOrNull(t.transaction_amount),
    disputed: numOrNull(t.disputed_amount),
    mode: t.payment_mode ?? null,
    layer: t.layer_no ?? null,
    utr: t.utr_no ?? null,
    same_day: !!t.same_day_cashout,
  }));

  const entry = ((analysis && analysis.timeline) || []).find((d) => d.date === day) || null;

  return {
    entity_type: 'timelineDay',
    entity_id: day,
    context: {
      layers_active: entry ? Object.keys(entry.layer_breakdown || {}) : [],
    },
    summary: {
      txn_count: entry ? numOrNull(entry.transaction_count) : rows.length,
      total_amount: entry ? numOrNull(entry.total_amount) : null,
      cashout_count: entry ? numOrNull(entry.cashouts) : null,
      row_count: rows.length,
    },
    notes: [],
    rows,
    searchable: [...TIMELINE_DAY_SEARCHABLE],
  };
}

// ─── transaction (single ledger row, fully expanded) ─────────────────

const TRANSACTION_SEARCHABLE = Object.freeze(['field', 'value']);

/** Field order + labels + render kinds for the single-transaction view. */
const TXN_FIELDS = Object.freeze([
  ['ack_no', 'Acknowledgement No', 'text'],
  ['complaint_date', 'Complaint Date', 'date'],
  ['transaction_date', 'Transaction Date', 'date'],
  ['victim_account', 'Victim / Sender Account', 'account'],
  ['victim_bank', 'Victim Bank', 'text'],
  ['beneficiary_account', 'Beneficiary Account', 'account'],
  ['beneficiary_name', 'Beneficiary Name', 'text'],
  ['beneficiary_bank', 'Beneficiary Bank (IFSC-resolved)', 'text'],
  ['raw_beneficiary_bank', 'Beneficiary Bank (source text)', 'text'],
  ['bank_source', 'Bank Attribution Source', 'text'],
  ['bank_flag', 'Bank Attribution Flag', 'text'],
  ['ifsc_code', 'IFSC', 'text'],
  ['transaction_amount', 'Transaction Amount', 'money'],
  ['disputed_amount', 'Disputed Amount', 'money'],
  ['utr_no', 'UTR / Reference No', 'text'],
  ['payment_mode', 'Payment Mode', 'text'],
  ['layer_no', 'Layer', 'text'],
  ['atm_id', 'ATM / Terminal Id', 'text'],
  ['atm_location', 'ATM / Terminal Location', 'text'],
  ['city', 'City', 'text'],
  ['state', 'State', 'text'],
  ['same_day_cashout', 'Same-day Cashout', 'bool'],
  ['cashout_mode', 'Cashout Mode', 'text'],
  ['is_duplicate', 'Exact Duplicate (excluded from totals)', 'bool'],
  ['remarks', 'Remarks', 'text'],
]);

/**
 * Single-transaction drill-down: every stored field of one ledger row as
 * Field/Value pairs (raw values — exact paise preserved), plus report-level
 * provenance (source file SHA-256). No roll-up chips (spec §5).
 */
function buildTransactionDetail(db, report, analysis, params) {
  const raw = String(params.id == null ? '' : params.id).trim();
  if (!/^\d+$/.test(raw)) {
    const err = new Error('Transaction id must be a positive integer (query param "id").');
    err.code = 'VALIDATION_FAILED';
    throw err;
  }
  const txn = db.prepare(
    'SELECT * FROM ncrp_transactions WHERE report_id = ? AND id = ? LIMIT 1'
  ).get(report.id, Number(raw));
  if (!txn) {
    const err = new Error(`No transaction ${raw} in this report.`);
    err.code = 'VALIDATION_FAILED';
    throw err;
  }

  const rows = TXN_FIELDS
    .map(([key, label, kind]) => ({
      id: key,
      field: label,
      value: txn[key] ?? null,
      kind,
    }))
    .filter((r) => r.value !== null && r.value !== '');
  // Report-level provenance (there is no per-row sheet column; the source-file
  // hash is the evidentiary anchor for every row of this report).
  if (report.source_sha256) {
    rows.push({ id: 'source_sha256', field: 'Source File SHA-256', value: report.source_sha256, kind: 'text' });
  }

  return {
    entity_type: 'transaction',
    entity_id: raw,
    context: {
      payment_mode: txn.payment_mode ?? null,
      layer_no: txn.layer_no ?? null,
      is_duplicate: !!txn.is_duplicate,
    },
    summary: { row_count: rows.length },
    notes: [],
    rows,
    searchable: [...TRANSACTION_SEARCHABLE],
  };
}

// ─── Dispatch ────────────────────────────────────────────────────────

const BUILDERS = Object.freeze({
  account: buildAccountDetail,
  atm: (db, report, analysis, params) => buildTerminalDetail(db, report, analysis, params, 'atm'),
  merchant: (db, report, analysis, params) => buildTerminalDetail(db, report, analysis, params, 'merchant'),
  cashflag: buildCashFlagDetail,
  layer: buildLayerDetail,
  edge: buildEdgeDetail,
  bank: buildBankDetail,
  timelineDay: buildTimelineDayDetail,
  transaction: buildTransactionDetail,
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
