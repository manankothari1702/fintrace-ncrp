'use strict';

/**
 * FinTrace NCRP — multi-sheet Excel (.xlsx) export.
 *
 * Builds an officer-facing workbook from a report's analysis bundle using
 * SheetJS (already a backend dependency). One sheet per investigative view, so
 * the whole case can be handed to a prosecutor or a bank as a single file:
 *
 *    1. Summary                  — headline figures + recovery breakdown.
 *    2. Layer Breakdown          — per-layer hop counts, amounts, fan-out.
 *    3. Lien Calculation         — recoverable balance per account.
 *    4. Suspected Mules          — scored accounts with suspicion reasons.
 *    5. Transactions             — the full raw ledger (every parsed leg).
 *    6. Money Flow Network       — heaviest account→account edges + collectors.
 *    7. Victim Accounts (Layer 0)— the victims and what each lost.
 *    8. ATM Exit Details         — ATM withdrawal hotspots.
 *    9. POS Exit Details         — POS / merchant cash-outs.
 *   10. Daily Volume             — transfers vs cash-outs per day.
 *   11. Hourly Pattern           — transaction activity by hour of day.
 *   12. Bank Rankings            — per-bank received / sent / on-hold / lien.
 *   13. Data Quality             — accounts whose bank attribution needs review.
 *   14. Geographic Hotspots      — cash-out by state + top merchants.
 *   15. Glossary                 — plain-language definitions of every term.
 *
 * Returns a Buffer the route streams as an attachment. Amounts are written as
 * real numbers (not pre-formatted strings) so the recipient can sort/sum in
 * Excel; the column headers name the unit.
 *
 * @module backend/src/utils/excelGenerator
 */

const XLSX = require('xlsx');

/** @param {unknown} v */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** ISO instant → "DD Mon YYYY HH:mm" (UTC, deterministic) or ''. @param {unknown} iso */
function fmtDate(iso) {
  if (iso === null || iso === undefined || iso === '') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getUTCDate())} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

/** ISO instant → "YYYY-MM-DD" calendar day (UTC), or '' for unparseable. @param {unknown} iso */
function isoDay(iso) {
  if (iso === null || iso === undefined || iso === '') return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  return d.toISOString().slice(0, 10);
}

/**
 * Append an array-of-arrays sheet, auto-sizing columns to the widest cell.
 * @param {XLSX.WorkBook} wb
 * @param {string} name - Sheet name (Excel caps at 31 chars).
 * @param {Array<Array<unknown>>} aoa
 */
function addSheet(wb, name, aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const widths = [];
  for (const row of aoa) {
    row.forEach((cell, i) => {
      const len = String(cell ?? '').length;
      if (!widths[i] || len > widths[i]) widths[i] = len;
    });
  }
  ws['!cols'] = widths.map((w) => ({ wch: Math.min(60, Math.max(8, w + 2)) }));
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
}

/**
 * Build the .xlsx workbook for one report.
 *
 * @param {{
 *   report?: Record<string, unknown>,
 *   analysis?: Record<string, unknown>,
 *   liens?: Array<Record<string, unknown>>,
 *   transactions?: Array<Record<string, unknown>>,
 *   ack_no?: string|null,
 *   complaint_date?: string|null,
 * }} bundle
 * @returns {Buffer} The encoded .xlsx file.
 */
function generateReportExcel(bundle = {}) {
  const {
    report = {}, analysis = {}, liens = [], transactions = [],
  } = bundle;
  const summary = analysis.summary || {};
  const recovery = analysis.recovery_status || {};
  const tl = analysis.timeline_summary || {};
  const wb = XLSX.utils.book_new();

  // ── 1. Summary ────────────────────────────────────────────────────────
  addSheet(wb, 'Summary', [
    ['FinTrace NCRP — Case Summary'],
    [],
    ['Acknowledgement No.', bundle.ack_no || report.original_filename || ''],
    ['Report generated', fmtDate(analysis.generated_at || new Date(0).toISOString())],
    ['Fraud trail start', summary.fraud_start_date || ''],
    [],
    ['Metric', 'Value'],
    ['Victim loss (Layer-1 disputed) [Rs.]', num(summary.victim_loss_amount)],
    ['Total trail disputed (all layers) [Rs.]', num(summary.total_disputed_amount)],
    ['Unique fund-movement transactions', num(summary.unique_transactions)],
    ['Raw ledger rows', num(summary.total_transactions)],
    ['Duplicate rows collapsed', num(summary.duplicate_count)],
    ['Layers in trail', num(summary.total_layers)],
    ['Distinct beneficiary accounts', num(summary.total_accounts)],
    [],
    // Recovery breakdown — these four sum to 100% of the victim loss. The
    // "Recoverable (residual)" row is the victim loss minus the other three; it
    // is NOT the per-account lien sum (that lives on the Lien Calculation sheet).
    // Amounts read the single source of truth on the summary (capped cash-out);
    // percentages come from recovery_status, which is derived from the same value.
    ['Recovery status', 'Amount [Rs.]', '% of victim loss'],
    ['Cashed out (ATM/POS)', num(summary.cashed_out ?? recovery.cashed_out), num(recovery.cashed_out_pct)],
    ['On hold (frozen)', num(summary.on_hold ?? recovery.on_hold), num(recovery.on_hold_pct)],
    ['Refunded', num(summary.refunded ?? recovery.refunded), num(recovery.refunded_pct)],
    ['Recoverable (residual)', num(summary.recoverable_residual ?? recovery.recoverable), num(recovery.recoverable_pct)],
    [],
    ['Key dates', ''],
    ['First fraud', tl.first_fraud_date || ''],
    ['First cashout', tl.first_cashout_date || ''],
    ['First bank action (hold)', tl.first_bank_action_date || ''],
    ['Timeline span (days)', tl.timeline_span_days ?? ''],
  ]);

  // ── 2. Layer Breakdown ──────────────────────────────────────────────────
  const layers = analysis.layer_analysis || [];
  addSheet(wb, 'Layer Breakdown', [
    ['Layer', 'Transactions', 'Accounts', 'Banks', 'Total Amount [Rs.]', 'Disputed [Rs.]', 'Cashouts', 'Fan-out Ratio', 'Avg Fwd (hrs)', 'Top Banks'],
    ...layers.map((l) => [
      l.layer_no, num(l.txn_count), num(l.account_count), num(l.bank_count ?? l.unique_banks),
      num(l.total_amount), num(l.disputed_amount), num(l.cashout_count),
      l.fan_out_ratio == null ? '' : num(l.fan_out_ratio),
      l.avg_forward_time_hours == null ? '' : num(l.avg_forward_time_hours),
      (l.top_banks || []).join('; '),
    ]),
  ]);

  // ── 3. Lien Calculation ──────────────────────────────────────────────────
  const lienRows = (liens && liens.length) ? liens : (analysis.lien_calculation || []);
  const lienTableTotal = num(summary.lien_table_total)
    || lienRows.reduce((s, l) => s + num(l.lien_eligible_amount ?? l.lien_amount), 0);
  addSheet(wb, 'Lien Calculation', [
    ['Account No.', 'Bank', 'IFSC', 'Layer', 'Received [Rs.]', 'Forwarded [Rs.]', 'On Hold [Rs.]', 'Cashed Out [Rs.]', 'Lien Eligible [Rs.]', 'Status'],
    ...lienRows.map((l) => [
      l.account_no, l.bank_name || '', l.ifsc_code || '',
      l.layer_no == null ? '' : `L${l.layer_no}`,
      num(l.total_received), num(l.onward_forwarded ?? l.total_forwarded),
      num(l.total_on_hold), num(l.total_cashed_out),
      num(l.lien_eligible_amount ?? l.lien_amount), l.lien_status || 'pending',
    ]),
    [],
    // Lien-eligible total (NOT the recovery residual on the Summary sheet).
    ['Total lien-eligible balance across flagged accounts', '', '', '', '', '', '', '', lienTableTotal, ''],
    ['(may exceed victim loss as funds traverse multiple layers)'],
  ]);

  // ── 4. Suspected Mules ───────────────────────────────────────────────────
  const mules = analysis.mule_detection || [];
  addSheet(wb, 'Suspected Mules', [
    ['Account No.', 'Bank', 'Layer', 'Mule Score', 'Risk', 'Received [Rs.]', 'Forwarded [Rs.]', 'Cashed Out [Rs.]', 'Txns', 'Channels', 'Same-day In/Out', 'Suspicion Reasons'],
    ...mules.map((m) => [
      m.account_no, m.bank_name || '', m.layer_no == null ? '' : `L${m.layer_no}`,
      num(m.mule_score), m.risk_label || '',
      num(m.total_received), num(m.total_forwarded), num(m.total_cashout),
      num(m.txn_count), (m.channels || []).join(', '),
      m.same_day_in_out ? 'Yes' : 'No', (m.suspicion_reasons || []).join('; '),
    ]),
  ]);

  // ── 5. Transactions (raw ledger) ──────────────────────────────────────────
  addSheet(wb, 'Transactions', [
    ['Date', 'Layer', 'Victim/Sender A/c', 'Beneficiary A/c', 'Beneficiary Bank', 'Amount [Rs.]', 'Disputed [Rs.]', 'Mode', 'UTR', 'ATM/POS ID', 'State'],
    ...(transactions || []).map((t) => [
      fmtDate(t.transaction_date), t.layer_no,
      t.victim_account || '', t.beneficiary_account || '', t.beneficiary_bank || '',
      num(t.transaction_amount), num(t.disputed_amount), t.payment_mode || '',
      t.utr_no || '', t.atm_id || '', t.state || '',
    ]),
  ]);

  // ── 6. Money Flow Network ────────────────────────────────────────────────
  const mf = analysis.money_flow_network || {};
  const edges = mf.top_edges || [];
  const aggs = mf.aggregators || [];
  addSheet(wb, 'Money Flow Network', [
    ['TOP EDGES (source -> destination)'],
    ['Source A/c', 'Destination A/c', 'Amount [Rs.]', 'Txns', 'Layers', 'Banks'],
    ...edges.map((e) => [e.source, e.destination, num(e.amount), num(e.txn_count), e.layers || '', e.banks || '']),
    [],
    ['AGGREGATOR / COLLECTOR ACCOUNTS'],
    ['Account No.', 'Bank', 'In-degree', 'Out-degree', 'Total In [Rs.]', 'Total Out [Rs.]'],
    ...aggs.map((a) => [a.account_no, a.bank || '', num(a.in_degree), num(a.out_degree), num(a.total_in), num(a.total_out)]),
  ]);

  // ── 7. Victim Accounts (Layer 0) ─────────────────────────────────────────
  // The victims and what each sent into the fraud network. Prefer the analysis
  // snapshot; fall back to aggregating Layer-1 victim_account legs from the
  // raw ledger for reports analysed before victim_accounts existed.
  let victimRows = Array.isArray(analysis.victim_accounts) ? analysis.victim_accounts : [];
  if (victimRows.length === 0) {
    const vmap = new Map();
    for (const t of transactions) {
      if (num(t.layer_no) === 1 && t.victim_account) {
        const k = String(t.victim_account);
        if (!vmap.has(k)) vmap.set(k, { account_no: k, txn_count: 0, amount_sent: 0 });
        const e = vmap.get(k);
        e.txn_count += 1;
        e.amount_sent += num(t.transaction_amount);
      }
    }
    victimRows = [...vmap.values()].sort((a, b) => b.amount_sent - a.amount_sent);
  }
  addSheet(wb, 'Victim Accounts (Layer 0)', [
    ['Account No.', 'Transactions', 'Amount Sent [Rs.]'],
    ...victimRows.map((v) => [v.account_no, num(v.txn_count), num(v.amount_sent)]),
  ]);

  // ── 8. ATM Exit Details ───────────────────────────────────────────────────
  const geo = analysis.geography || {};
  const cashAnalysis = analysis.cashout_analysis || {};
  // City/State aren't carried on top_atms; enrich from the cashout analysis
  // (matched on ATM id) when those columns were present in the NCRP export.
  const atmLoc = new Map();
  for (const ac of (cashAnalysis.atm_cashouts || [])) {
    atmLoc.set(String(ac.atm_id), { city: ac.city, state: ac.state });
  }
  const topAtms = Array.isArray(geo.top_atms) ? geo.top_atms : [];
  addSheet(wb, 'ATM Exit Details', [
    ['ATM ID', 'Location', 'City', 'State', 'Amount [Rs.]', 'Txns', 'Accounts'],
    ...topAtms.map((a) => {
      const loc = atmLoc.get(String(a.atm_id)) || {};
      return [a.atm_id || '', a.location || '', loc.city || '', loc.state || '',
        num(a.amount), num(a.txn_count), num(a.account_count)];
    }),
  ]);

  // ── 9. POS Exit Details ───────────────────────────────────────────────────
  // POS cash-outs straight from the ledger. The merchant name and terminal id
  // live in the atm_location / atm_id columns for POS legs.
  const posRows = (transactions || [])
    .filter((t) => String(t.payment_mode || '').toUpperCase() === 'POS');
  addSheet(wb, 'POS Exit Details', [
    ['Date', 'Account', 'Bank', 'Amount [Rs.]', 'Merchant', 'Terminal ID'],
    ...posRows.map((t) => [
      fmtDate(t.transaction_date), t.beneficiary_account || '', t.beneficiary_bank || '',
      num(t.transaction_amount), t.atm_location || '', t.atm_id || '',
    ]),
  ]);

  // ── 10. Daily Volume ──────────────────────────────────────────────────────
  // Per calendar day, split into onward transfers vs cash exits. Cash exits are
  // the ATM/POS channels; everything else is treated as an onward transfer/hop.
  const isCashout = (t) => {
    const pm = String(t.payment_mode || '').toUpperCase();
    return pm === 'ATM' || pm === 'POS';
  };
  const dayMap = new Map();
  for (const t of (transactions || [])) {
    const day = isoDay(t.transaction_date);
    if (!day) continue;
    if (!dayMap.has(day)) dayMap.set(day, { date: day, tc: 0, ta: 0, cc: 0, ca: 0 });
    const e = dayMap.get(day);
    const amt = num(t.transaction_amount);
    if (isCashout(t)) { e.cc += 1; e.ca += amt; } else { e.tc += 1; e.ta += amt; }
  }
  const dayRows = [...dayMap.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
  addSheet(wb, 'Daily Volume', [
    ['Date', 'Transfer Count', 'Transfer Amount [Rs.]', 'Cashout Count', 'Cashout Amount [Rs.]'],
    ...dayRows.map((d) => [d.date, d.tc, num(d.ta), d.cc, num(d.ca)]),
  ]);

  // ── 11. Hourly Pattern ────────────────────────────────────────────────────
  // Activity by hour of day (00–23). Date-only legs bucket into hour 00.
  const hours = Array.from({ length: 24 }, (_, h) => ({ h, count: 0, amount: 0 }));
  for (const t of (transactions || [])) {
    const d = new Date(t.transaction_date);
    if (Number.isNaN(d.getTime())) continue;
    const h = d.getUTCHours();
    hours[h].count += 1;
    hours[h].amount += num(t.transaction_amount);
  }
  addSheet(wb, 'Hourly Pattern', [
    ['Hour', 'Transaction Count', 'Total Amount [Rs.]'],
    ...hours.map((x) => [`${String(x.h).padStart(2, '0')}:00`, x.count, num(x.amount)]),
  ]);

  // ── 12. Bank Rankings ─────────────────────────────────────────────────────
  // Per-bank totals aggregated from the per-account lien calculation (which
  // carries the received / forwarded / on-hold / lien figures), with the raw
  // transaction count joined in by beneficiary bank.
  const lienCalc = Array.isArray(analysis.lien_calculation) ? analysis.lien_calculation : [];
  const bankMap = new Map();
  const ensureBank = (name) => {
    if (!bankMap.has(name)) {
      bankMap.set(name, { bank: name, accounts: 0, received: 0, sent: 0, on_hold: 0, lien: 0, txns: 0 });
    }
    return bankMap.get(name);
  };
  for (const l of lienCalc) {
    const b = ensureBank(l.bank_name || 'Unknown');
    b.accounts += 1;
    b.received += num(l.total_received);
    b.sent += num(l.onward_forwarded ?? l.total_forwarded);
    b.on_hold += num(l.total_on_hold);
    b.lien += num(l.lien_eligible_amount ?? l.lien_amount);
  }
  for (const t of (transactions || [])) {
    if (t.beneficiary_bank && bankMap.has(t.beneficiary_bank)) {
      bankMap.get(t.beneficiary_bank).txns += 1;
    }
  }
  const bankRows = [...bankMap.values()].sort((a, b) => b.received - a.received);
  addSheet(wb, 'Bank Rankings', [
    ['Bank', 'Accounts', 'Total Received [Rs.]', 'Total Sent [Rs.]', 'On Hold [Rs.]', 'Lien [Rs.]', 'Txns'],
    ...bankRows.map((b) => [
      b.bank, b.accounts, num(b.received), num(b.sent), num(b.on_hold), num(b.lien), b.txns,
    ]),
  ]);

  // ── 13. Data Quality (bank attribution) ───────────────────────────────────
  // Every account whose bank could not be silently confirmed from a clean IFSC:
  // the letter uses the IFSC-derived name; the source-file text is shown for the
  // IO to verify. Amounts are unaffected — only the bank attribution is flagged.
  const dq = Array.isArray(analysis.data_quality) ? analysis.data_quality : [];
  addSheet(wb, 'Data Quality', [
    ['BANK ATTRIBUTION — ACCOUNTS NEEDING REVIEW'],
    [`${dq.length} account(s) flagged. The bank on each lien letter is IFSC-authoritative.`],
    [],
    ['Account No.', 'Resolved Bank (on letter)', 'IFSC', 'Source', 'Flag', 'Source-file Text', 'Reviewer Note'],
    ...dq.map((d) => [
      d.account_no || '',
      d.bank || '',
      d.ifsc_code || '',
      d.bank_source || '',
      d.bank_flag || '',
      d.raw_bank || '(blank)',
      d.message || '',
    ]),
  ]);

  // ── 14. Geographic Hotspots ───────────────────────────────────────────────
  const byState = Array.isArray(geo.by_state) ? geo.by_state : [];
  const merchants = Array.isArray(geo.top_merchants) ? geo.top_merchants : [];
  addSheet(wb, 'Geographic Hotspots', [
    ['CASHOUT BY STATE'],
    ['State', 'Amount [Rs.]', 'Txns', 'Share %'],
    ...byState.map((s) => [s.state || '', num(s.amount), num(s.txn_count ?? s.count), num(s.pct)]),
    [],
    ['TOP MERCHANTS (POS)'],
    ['Merchant', 'Type', 'Amount [Rs.]', 'Txns'],
    ...merchants.map((m) => [m.name || '', m.type || 'Merchant', num(m.amount), num(m.txn_count)]),
  ]);

  // ── 14. Glossary ──────────────────────────────────────────────────────────
  addSheet(wb, 'Glossary', [
    ['Term', 'Definition'],
    ['Victim Loss (Layer 1)', 'Disputed money that left the victim(s) and entered the fraud network at the first hop. This is the actual amount stolen.'],
    ['Total Trail Disputed', 'Disputed amount summed across every layer. The same rupees are re-counted at each hop, so this exceeds the victim loss and is a reach metric, not a loss figure.'],
    ['Layer', 'Distance (in hops) from the victim. Layer 1 receives directly from the victim; each further layer is one transfer further out toward cash-out.'],
    ['Disputed Amount', 'The portion of a transaction flagged as fraud proceeds (as reported in the NCRP complaint), as opposed to the gross transaction amount.'],
    ['Lien Amount', 'Funds still recoverable in an account: money received but not yet forwarded onward, withdrawn as cash, or already on hold. Subject to the actual balance confirmed by the bank.'],
    ['On Hold', 'Amount a bank has already frozen / marked under hold for an account.'],
    ['Cashed Out', 'Disputed funds withdrawn from the network as cash via ATM or POS — generally unrecoverable.'],
    ['Mule Score', 'Mule Risk Score — an additive weighted indicator (layer position, fan-in, velocity, same-day cashout, amount routed) used to rank and prioritise accounts within this case. Not a percentage or probability; it has no fixed maximum and a textbook mule can exceed 100. Bands: >=70 HIGH, 40-69 MEDIUM, <40 LOW.'],
    ['Risk Label', 'Band derived from the mule risk score: HIGH (>= 70), MEDIUM (40-69), or LOW (< 40). HIGH accounts are priority targets for lien and KYC requests.'],
    ['Fan-out Ratio', 'How widely funds spread at a layer — distinct destination accounts relative to source accounts. High fan-out signals deliberate layering.'],
    ['Aggregator / Collector', 'An account that gathers funds from many senders (high in-degree) before forwarding — a hub in the money-flow network.'],
    ['Same-day In/Out', 'An account that received and forwarded funds on the same calendar day — a classic pass-through mule behaviour.'],
    ['ATM / POS Exit', 'Points where money left the banking system as cash: ATM withdrawals and POS (merchant terminal) transactions.'],
    ['AEPS', 'Aadhaar Enabled Payment System — a cash-out channel using Aadhaar-authenticated withdrawals at banking agents.'],
    ['UTR', 'Unique Transaction Reference — the bank-issued identifier for a fund transfer, used to trace a specific leg.'],
    ['IFSC', 'Indian Financial System Code — identifies the specific bank branch holding an account.'],
    ['ACK No.', 'NCRP acknowledgement number — the complaint reference this dossier is built from.'],
  ]);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { generateReportExcel };
