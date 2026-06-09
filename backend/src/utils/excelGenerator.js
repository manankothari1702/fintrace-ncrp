'use strict';

/**
 * FinTrace NCRP — multi-sheet Excel (.xlsx) export.
 *
 * Builds an officer-facing workbook from a report's analysis bundle using
 * SheetJS (already a backend dependency). One sheet per investigative view, so
 * the whole case can be handed to a prosecutor or a bank as a single file:
 *
 *   1. Summary            — headline figures + recovery breakdown.
 *   2. Layer Breakdown    — per-layer hop counts, amounts, fan-out, top banks.
 *   3. Lien Calculation   — recoverable balance per account (the worksheet a
 *                           bank acts on).
 *   4. Suspected Mules    — scored accounts with their suspicion reasons.
 *   5. Transactions       — the full raw ledger (every parsed leg).
 *   6. Money Flow Network — heaviest account→account edges + collectors.
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
    ['Recovery status', 'Amount [Rs.]', '% of victim loss'],
    ['Cashed out (ATM/POS)', num(recovery.cashed_out), num(recovery.cashed_out_pct)],
    ['On hold (frozen)', num(recovery.on_hold), num(recovery.on_hold_pct)],
    ['Refunded', num(recovery.refunded), num(recovery.refunded_pct)],
    ['Recoverable (lien-eligible)', num(recovery.recoverable), num(recovery.recoverable_pct)],
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
  addSheet(wb, 'Lien Calculation', [
    ['Account No.', 'Bank', 'IFSC', 'Layer', 'Received [Rs.]', 'Forwarded [Rs.]', 'On Hold [Rs.]', 'Cashed Out [Rs.]', 'Lien Eligible [Rs.]', 'Status'],
    ...lienRows.map((l) => [
      l.account_no, l.bank_name || '', l.ifsc_code || '',
      l.layer_no == null ? '' : `L${l.layer_no}`,
      num(l.total_received), num(l.onward_forwarded ?? l.total_forwarded),
      num(l.total_on_hold), num(l.total_cashed_out),
      num(l.lien_eligible_amount ?? l.lien_amount), l.lien_status || 'pending',
    ]),
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

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { generateReportExcel };
