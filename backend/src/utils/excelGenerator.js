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
 *    7. Circular Flows           — accounts that route money back to themselves.
 *    8. Account Connectivity     — per-account in/out-degree + ranked collectors.
 *    9. Victim Accounts (Layer 0)— the victims and what each lost.
 *   10. ATM Exit Details         — ATM withdrawal hotspots.
 *   11. POS Exit Details         — POS / merchant cash-outs.
 *   12. Daily Volume             — transfers vs cash-outs per day.
 *   13. Hourly Pattern           — transaction activity by hour of day.
 *   14. Day of Week              — activity by day of the week.
 *   15. Bank Rankings            — per-bank received / sent / on-hold / lien.
 *   16. Data Quality             — accounts whose bank attribution needs review.
 *   17. Parse Audit              — parse warnings, suspected duplicates, old txns.
 *   18. Geographic Hotspots      — cash-out by state + top merchants.
 *   19. Glossary                 — plain-language definitions of every term.
 *
 * Returns a Buffer the route streams as an attachment. Amounts are written as
 * real numbers (not pre-formatted strings) so the recipient can sort/sum in
 * Excel; the column headers name the unit.
 *
 * @module backend/src/utils/excelGenerator
 */

const XLSX = require('xlsx');
const {
  posExitRows, posMerchantAggregates, atmOnlyCashouts,
  accountCountByTerminal, cashoutReconciliation,
} = require('./exportViews');

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
  // Feature 3 — disputed reconciliation footer: the per-layer Disputed column
  // foots to the headline via an explicit, labelled chain (raw hop − duplicate
  // hop legs + EXIT + OTHER + HOLD = headline). Mirrors the PDF Annexure A block.
  const dRec = (analysis.reconciliation && analysis.reconciliation.disputed) || {};
  const layerReconBlock = [];
  if (dRec.total != null) {
    layerReconBlock.push([]);
    layerReconBlock.push(['DISPUTED RECONCILIATION TO HEADLINE TOTAL TRAIL DISPUTED']);
    if (num(dRec.dedup_hop_adjustment) > 0.005) {
      layerReconBlock.push(['Raw hop disputed (Money Transfer legs, incl. duplicates) [Rs.]', num(dRec.raw_hop)]);
      layerReconBlock.push(['Less duplicate hop legs collapsed before analysis [Rs.]', -num(dRec.dedup_hop_adjustment)]);
      layerReconBlock.push(['Net hop disputed (= sum of per-layer Disputed above) [Rs.]', num(dRec.hop)]);
    } else {
      layerReconBlock.push(['Hop disputed (= sum of per-layer Disputed above) [Rs.]', num(dRec.hop)]);
    }
    layerReconBlock.push(['Add cash-out legs (EXIT) [Rs.]', num(dRec.exit)]);
    layerReconBlock.push(['Add other legs (OTHER) [Rs.]', num(dRec.other)]);
    if (num(dRec.hold) > 0) layerReconBlock.push(['Add frozen / HOLD legs [Rs.]', num(dRec.hold)]);
    layerReconBlock.push(['Total Trail Disputed (headline) [Rs.]', num(dRec.total)]);
  }
  addSheet(wb, 'Layer Breakdown', [
    ['Layer', 'Transactions', 'Accounts', 'Banks', 'Total Amount [Rs.]', 'Disputed [Rs.]', 'Cashouts', 'Fan-out Ratio', 'Avg Fwd (hrs)', 'Top Banks'],
    ...layers.map((l) => [
      l.layer_no, num(l.txn_count), num(l.account_count), num(l.bank_count ?? l.unique_banks),
      num(l.total_amount), num(l.disputed_amount), num(l.cashout_count),
      l.fan_out_ratio == null ? '' : num(l.fan_out_ratio),
      l.avg_forward_time_hours == null ? '' : num(l.avg_forward_time_hours),
      (l.top_banks || []).join('; '),
    ]),
    ...layerReconBlock,
  ]);

  // ── 3. Lien Calculation ──────────────────────────────────────────────────
  // The persisted lien_records rows carry only the lien amount + status — the
  // derivation columns (layer, received, forwarded, on hold, cashed out) live
  // on the analyzer's lien_calculation snapshot. Join the two by account so the
  // worksheet shows HOW each lien figure was derived; the per-row Lien Eligible
  // values and the total are read as-is, never recomputed.
  const lienRows = (liens && liens.length) ? liens : (analysis.lien_calculation || []);
  const lienDetailByAcct = new Map(
    (analysis.lien_calculation || []).map((l) => [String(l.account_no), l]));
  const lienTableTotal = num(summary.lien_table_total)
    || lienRows.reduce((s, l) => s + num(l.lien_eligible_amount ?? l.lien_amount), 0);
  // Feature 4 — per-account audit columns + the exact formula and exclusion rule,
  // so a reviewer can reconstruct the lien total line-by-line. The Lien Eligible
  // values and the total are read as-is, never recomputed here.
  const lienExcluded = Array.isArray(analysis.lien_excluded) ? analysis.lien_excluded : [];
  const grossSumNoCap = lienRows.reduce((s, l) => {
    const d = lienDetailByAcct.get(String(l.account_no)) || {};
    const gb = (l.gross_balance ?? d.gross_balance);
    return s + (gb != null ? num(gb) : num(l.lien_eligible_amount ?? l.lien_amount));
  }, 0) + lienExcluded.reduce((s, e) => s + num(e.gross_balance), 0);
  // The first 12 columns (0..11) are unchanged; the Feature-4 audit columns
  // 'Disputed Fwd [Rs.]' and 'Cap / Exclusion Reason' are APPENDED (indices 12-13)
  // so existing column-index consumers keep working. Lien Eligible stays at 10.
  addSheet(wb, 'Lien Calculation', [
    ['Account No.', 'Bank', 'IFSC', 'Layer', 'Received [Rs.]', 'Forwarded [Rs.]', 'On Hold [Rs.]', 'Cashed Out [Rs.]', 'Gross Balance [Rs.]', 'Disputed Inflow [Rs.]', 'Lien Eligible [Rs.]', 'Status', 'Disputed Fwd [Rs.]', 'Cap / Exclusion Reason'],
    ...lienRows.map((l) => {
      const d = lienDetailByAcct.get(String(l.account_no)) || {};
      const layer = l.layer_no ?? d.layer_no;
      const received = num(l.total_received ?? d.total_received);
      const forwarded = num(l.onward_forwarded ?? l.total_forwarded ?? d.onward_forwarded);
      const dispFwd = num(l.disputed_forwarded ?? d.disputed_forwarded);
      const onHold = num(l.total_on_hold ?? d.total_on_hold);
      const cashedOut = num(l.total_cashed_out ?? d.total_cashed_out);
      const lienEligible = num(l.lien_eligible_amount ?? l.lien_amount);
      // Gross balance (pre-cap residue) and the disputed-inflow cap are read from
      // the analyzer rollup, never recomputed. gross_balance falls back to the
      // component subtraction for legacy rows; the disputed cap falls back to the
      // value that keeps min(gross, cap) === lien for rows analysed before the
      // field existed, so the worksheet always reconciles.
      const grossBalance = (l.gross_balance ?? d.gross_balance) != null
        ? num(l.gross_balance ?? d.gross_balance)
        : Math.max(0, received - forwarded - onHold - cashedOut);
      const disputedInflow = (l.disputed_received ?? d.disputed_received) != null
        ? num(l.disputed_received ?? d.disputed_received)
        : (lienEligible < grossBalance ? lienEligible : grossBalance);
      const reason = l.excluded_reason ?? d.excluded_reason
        ?? (grossBalance - lienEligible > 0.005 ? 'Capped at disputed inflow.' : 'No cap applied.');
      return [
        l.account_no, l.bank_name || '', l.ifsc_code || '',
        layer == null ? '' : `L${layer}`,
        received, forwarded, onHold, cashedOut,
        grossBalance, disputedInflow,
        lienEligible, l.lien_status || 'pending',
        dispFwd, reason,
      ];
    }),
    [],
    // Lien-eligible total (NOT the recovery residual on the Summary sheet). Total
    // sits under the 'Lien Eligible [Rs.]' column (index 10).
    ['Total lien-eligible balance across flagged accounts', '', '', '', '', '', '', '', '', '', lienTableTotal, '', '', ''],
    ['(may exceed victim loss as funds traverse multiple layers)'],
    // Original analyzer formula footnote (kept verbatim).
    ['Formula: Gross Balance = max(0, Received - Forwarded - On Hold - Cashed Out).'],
    ['Lien Eligible = min(Gross Balance, Disputed Inflow): recoverable funds are capped at the account\'s disputed (fraud-attributed) inflow and floored at zero, since lien cannot exceed the fraud money that entered.'],
    [],
    // Feature 4 — exact reproducible formula + exclusion rule + no-cap comparison.
    ['FORMULA (exact, per account):'],
    ['   Gross Balance = max(0, Received - Forwarded - On Hold - Cashed Out [exits]).'],
    ['   Lien Eligible = max(0, min(Gross Balance, Disputed Inflow)).'],
    ['EXCLUSION RULE: the lien is capped at the account\'s DISPUTED (fraud-attributed) inflow; any gross residue above it is the account\'s own/clean funds and is excluded. Money received via OTHER settlement legs, sub-Rs.500 legs, or wallet/PA/PG ids without a resolvable IFSC carries no disputed-hop inflow, so it does not raise the cap. The "Cap / Exclusion Reason" column states the per-account effect.'],
    [`NO-CAP COMPARISON: summing Gross Balance across all residue-bearing accounts (no disputed cap) gives the naive recoverable Rs. ${grossSumNoCap.toFixed(2)}; the disputed-inflow cap reduces it to the Lien Eligible total Rs. ${num(lienTableTotal).toFixed(2)} above.`],
    // Accounts the cap removed entirely (gross residue > 0 but lien = 0).
    ...(lienExcluded.length > 0 ? [
      [],
      ['ACCOUNTS EXCLUDED BY THE DISPUTED-INFLOW CAP (gross residue > 0 but lien = 0)'],
      ['Account No.', 'Bank', 'Gross Balance [Rs.]', 'Disputed Inflow [Rs.]', 'Cashed Out [Rs.]', 'Reason'],
      ...lienExcluded.map((e) => [
        e.account_no, e.bank_name || '', num(e.gross_balance), num(e.disputed_received),
        num(e.total_cashed_out), e.excluded_reason || '',
      ]),
    ] : [
      [],
      ['No residue-bearing account was excluded by the disputed-inflow cap (every account with a gross residue carries a lien).'],
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

  // ── 6b. Circular Flows (layering loops) ──────────────────────────────────
  // Simple directed cycles (length <= 6) in the hop graph: money that returns to
  // an account it already passed through. "Min Loop Amount" is the thinnest edge
  // around the loop — the most that could actually have circulated. Banks are the
  // parser's IFSC-resolved names.
  const cycles = Array.isArray(analysis.circular_flows) ? analysis.circular_flows : [];
  addSheet(wb, 'Circular Flows', [
    ['CIRCULAR FLOWS (layering loops, cycle length <= 6)'],
    ['Cycle (account loop)', 'Length', 'Min Loop Amount [Rs.]', 'Txns', 'Banks (IFSC-resolved)'],
    ...cycles.map((c) => [
      (c.path || []).join(' -> ') + ((c.path && c.path.length) ? ` -> ${c.path[0]}` : ''),
      num(c.length), num(c.amount), num(c.txns), (c.banks || []).join('; '),
    ]),
    ...(cycles.length === 0 ? [['No circular flows detected in the trail.']] : []),
  ]);

  // ── 6c. Account Connectivity (in-degree / aggregator analysis) ────────────
  // Per-account fan-in / fan-out over the hop graph; collectors (in-degree >= 2)
  // sort to the top. Banks are the parser's IFSC-resolved names.
  const conn = analysis.connectivity || {};
  const connAccounts = Array.isArray(conn.accounts) ? conn.accounts : [];
  addSheet(wb, 'Account Connectivity', [
    ['ACCOUNT CONNECTIVITY — IN-DEGREE / AGGREGATOR ANALYSIS'],
    ['In-degree = distinct senders into the account; out-degree = distinct receivers. Collectors (in-degree >= 2) are listed first.'],
    [],
    ['Account No.', 'Bank (IFSC-resolved)', 'In-degree', 'Out-degree', 'Total In [Rs.]', 'Total Out [Rs.]', 'Collector'],
    ...connAccounts.map((a) => [
      a.account_no, a.bank || '', num(a.in_degree), num(a.out_degree),
      num(a.total_in), num(a.total_out), a.is_collector ? 'Yes' : 'No',
    ]),
    ...(connAccounts.length === 0 ? [['No account-to-account edges were derived for this case.']] : []),
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

  // ── 8 + 9. ATM / POS Exit Details ────────────────────────────────────────
  // The two sheets are scoped strictly by the ledger's payment mode: ATM
  // withdrawals only on the ATM sheet, POS merchant cash-outs only on the POS
  // sheet — no terminal or transaction appears on both. (The analyzer's
  // terminal aggregates bucket POS legs under ATM because POS legs carry their
  // terminal id in the atm_id column; that classification is load-bearing for
  // same-day-cashout detection, so the split happens here, at display time.)
  const geo = analysis.geography || {};
  const cashAnalysis = analysis.cashout_analysis || {};
  const atmTerminals = atmOnlyCashouts(cashAnalysis.atm_cashouts || [], transactions);
  const acctsByTerminal = accountCountByTerminal(transactions);
  const posRows = posExitRows(transactions);

  // Gross-vs-confirmed reconciliation, printed on both sheets so a reader who
  // sums the details sees exactly why the headline differs.
  const atmShownAmount = atmTerminals.reduce((s, a) => s + num(a.amount), 0);
  const atmShownTxns = atmTerminals.reduce((s, a) => s + num(a.count), 0);
  const posShownAmount = posRows.reduce((s, t) => s + num(t.transaction_amount), 0);
  const recon = cashoutReconciliation(
    { summary, cashout: cashAnalysis },
    atmShownAmount + posShownAmount, atmShownTxns + posRows.length);
  // The detail sheets show POST-dedup figures, so the gross is normally already
  // net of the collapsed duplicates (dup_amount_shown ≈ 0). Surface the explicit
  // "Less duplicate rows" line only when it carries real value; otherwise note
  // the duplicates were collapsed beforehand — never a contradictory "Rs. 0.00
  // duplicate rows" line against a non-zero collapsed-row count.
  const hasDupValue = num(recon.dup_amount_shown) > 0.005;
  const reconBlock = [
    [],
    ['CASH-OUT RECONCILIATION (ATM + POS sheets)'],
    ['Gross withdrawals shown [Rs.]', recon.gross_shown,
      `${recon.rows_shown} rows across the ATM and POS sheets`
      + (recon.dup_rows_collapsed > 0 && !hasDupValue
        ? `; already net of ${recon.dup_rows_collapsed} exact-duplicate row(s) collapsed before analysis`
        : '')],
  ];
  if (hasDupValue) {
    reconBlock.push(['Less duplicate rows included above [Rs.]', recon.dup_amount_shown,
      `${recon.dup_rows_collapsed} duplicate ledger row(s) were collapsed during analysis`]);
  }
  reconBlock.push(['Less excess over disputed inflow per account (cap) [Rs.]', recon.cap_excess,
    'amounts above an account\'s disputed inflow are its own/clean funds']);
  reconBlock.push(['Confirmed cashed out (headline) [Rs.]', recon.confirmed,
    hasDupValue ? 'gross - duplicates - cap = confirmed' : 'gross - cap = confirmed']);

  addSheet(wb, 'ATM Exit Details', [
    ['ATM ID', 'Location', 'City', 'State', 'Gross Amount [Rs.]', 'Txns', 'Accounts'],
    ...atmTerminals.map((a) => [
      a.atm_id || '', a.atm_location || a.location || '', a.city || '', a.state || '',
      num(a.amount), num(a.count ?? a.txn_count),
      num(acctsByTerminal.get(String(a.atm_id)) ?? a.account_count),
    ]),
    ...reconBlock,
  ]);

  // POS cash-outs straight from the ledger. The merchant name and terminal id
  // live in the atm_location / atm_id columns for POS legs.
  addSheet(wb, 'POS Exit Details', [
    ['Date', 'Account', 'Bank', 'Gross Amount [Rs.]', 'Merchant', 'Terminal ID'],
    ...posRows.map((t) => [
      fmtDate(t.transaction_date), t.beneficiary_account || '', t.beneficiary_bank || '',
      num(t.transaction_amount), t.atm_location || '', t.atm_id || '',
    ]),
    ...reconBlock,
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

  // ── 11b. Day of Week (IST) ────────────────────────────────────────────────
  // Feature 5 — dated legs grouped by IST weekday, plus an explicit Undated bucket
  // so the counts foot to the full deduped leg total.
  const dow = analysis.day_of_week || { weekdays: [], undated: { txns: 0, totalAmount: 0 } };
  const dowWeekdays = Array.isArray(dow.weekdays) ? dow.weekdays : [];
  addSheet(wb, 'Day of Week', [
    ['DAY-OF-WEEK ACTIVITY (IST calendar day of each leg)'],
    ['Weekday', 'Transactions', 'Total Amount [Rs.]'],
    ...dowWeekdays.map((w) => [w.weekday, num(w.txns), num(w.totalAmount)]),
    ['Undated', num(dow.undated && dow.undated.txns), num(dow.undated && dow.undated.totalAmount)],
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
  const oldTxns = Array.isArray(analysis.old_transactions) ? analysis.old_transactions : [];
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
    // Old transactions (>6 months): parsed and stored, but excluded from every
    // financial figure. Listed here for the record.
    ...(oldTxns.length > 0 ? [
      [],
      ['OLD TRANSACTIONS (EXCLUDED FROM CALCULATIONS)'],
      [`${oldTxns.length} transaction(s) predate the 6-month NCRP window — informational only.`],
      ['Account No.', 'Bank', 'Layer', 'Amount [Rs.]', 'Remarks'],
      ...oldTxns.map((o) => [
        o.account_no || '',
        o.bank || '',
        num(o.layer_no),
        num(o.transaction_amount),
        o.remarks || '',
      ]),
    ] : []),
  ]);

  // ── 13b. Parse Audit (self-healing parser) ────────────────────────────────
  // Sheets/columns the parser resolved by name similarity rather than an exact
  // match, plus informational columns that were absent. Records how the source
  // file was READ — it never changes a computed amount.
  const pw = Array.isArray(analysis.parse_warnings) ? analysis.parse_warnings : [];
  const pwType = (code) => (
    code === 'FUZZY_SHEET_MATCH' ? 'Sheet (fuzzy)'
      : code === 'FUZZY_COLUMN_MATCH' ? 'Column (fuzzy)'
        : 'Column missing');
  addSheet(wb, 'Parse Audit', [
    ['PARSER SELF-HEALING AUDIT'],
    [pw.length === 0
      ? 'No parser warnings — every sheet and column name matched exactly.'
      : `${pw.length} item(s). "Fuzzy" = resolved by name similarity (confidence shown); ` +
        '"missing" = informational column absent (degraded gracefully). ' +
        'Interpretation provenance only — financial amounts are unaffected.'],
    [],
    ...(pw.length > 0 ? [
      ['Type', 'Sheet', 'Source Name', 'Interpreted As', 'Confidence %', 'Note'],
      ...pw.map((w) => [
        pwType(w.code),
        w.sheet || '',
        w.matchedFrom || '(missing)',
        w.matchedTo || '',
        w.confidence == null ? '' : Math.round(w.confidence * 100),
        w.message || '',
      ]),
    ] : []),
  ]);

  // ── 14. Geographic Hotspots ───────────────────────────────────────────────
  // Merchants: prefer the analyzer's view, but derive from the ledger's POS
  // legs when it is empty (POS legs that carry a terminal id are bucketed as
  // ATM by the analyzer, leaving top_merchants blank — see sheets 8/9).
  const byState = Array.isArray(geo.by_state) ? geo.by_state : [];
  const merchants = (transactions && transactions.length)
    ? posMerchantAggregates(transactions)
    : (Array.isArray(geo.top_merchants) ? geo.top_merchants : []);
  addSheet(wb, 'Geographic Hotspots', [
    ['CASHOUT BY STATE'],
    ['State', 'Amount [Rs.]', 'Txns', 'Share %'],
    ...byState.map((s) => [s.state || '', num(s.amount), num(s.txn_count ?? s.count), num(s.pct)]),
    [],
    ['TOP MERCHANTS (POS)'],
    ['Merchant', 'Type', 'Gross Amount [Rs.]', 'Txns'],
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

/**
 * Build the Cash/Exit Channel workbook (Features 4 & 5). Reuses the same
 * `addSheet` infra as {@link generateReportExcel} — no separate Excel writer.
 *
 * Two scopes:
 *   • 'full'  — Overview + one sheet per present channel + Behavioural Flags +
 *               Top Exit Points + Top Cities (the whole-page breakdown workbook).
 *   • 'view'  — a single sheet of one channel's transactions, optionally filtered
 *               to a flag's instances with a "Why flagged" column (the current view).
 *
 * All figures are read as-is from the cached cash_exit_analysis snapshot; nothing
 * is recomputed here.
 *
 * @param {{ summary?: object, channels?: Record<string, object> }} cashExit
 * @param {{ scope?: 'full'|'view', channel?: string, flag?: string,
 *   caseRef?: string, generatedAt?: string }} [opts]
 * @returns {Buffer} The encoded .xlsx file.
 */
function generateCashExitExcel(cashExit = {}, opts = {}) {
  const summary = cashExit.summary || {};
  const channels = cashExit.channels || {};
  const order = ['ATM', 'POS', 'AEPS'];
  const present = Array.isArray(summary.channels_present) ? summary.channels_present : [];
  const wb = XLSX.utils.book_new();

  const txnHeader = (ch) => (ch === 'POS'
    ? ['Date', 'Account', 'Amount [Rs.]', 'Disputed [Rs.]', 'Terminal/MID', 'Merchant', 'City', 'State', 'Same-day']
    : ['Date', 'Account', 'Amount [Rs.]', 'Disputed [Rs.]', 'ATM ID', 'Location', 'City', 'State', 'Same-day']);
  const txnRow = (t) => [
    fmtDate(t.date), t.account, num(t.amount), num(t.disputed),
    t.atm_id || '', t.location || '', t.city || '', t.state || '', t.same_day ? 'YES' : '',
  ];

  if (opts.scope === 'view') {
    const ch = opts.channel && channels[opts.channel] ? opts.channel : (present[0] || 'ATM');
    const c = channels[ch] || { transactions: [], flags: [] };
    let rows = c.transactions || [];
    let why = null;
    let title = `${ch} transactions`;
    if (opts.flag) {
      const flag = (c.flags || []).find((f) => f.key === opts.flag);
      if (flag) {
        why = new Map();
        for (const inst of flag.instances || []) {
          for (const id of inst.txn_ids || []) why.set(id, inst.why);
        }
        rows = rows.filter((t) => why.has(t.id));
        title = `${ch} — ${flag.label}`;
      }
    }
    const header = why ? [...txnHeader(ch), 'Why flagged'] : txnHeader(ch);
    addSheet(wb, title.slice(0, 31), [
      [`FinTrace NCRP — Cash/Exit (${title})`],
      ['Case', opts.caseRef || ''],
      ['Generated', fmtDate(opts.generatedAt || new Date(0).toISOString())],
      [],
      header,
      ...rows.map((t) => (why ? [...txnRow(t), why.get(t.id) || ''] : txnRow(t))),
    ]);
    return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  }

  // ── scope 'full' — overview + per-channel + flags + top points/cities ──────
  addSheet(wb, 'Cash-Exit Overview', [
    ['FinTrace NCRP — Cash / Exit Channel breakdown'],
    ['Case', opts.caseRef || ''],
    ['Generated', fmtDate(opts.generatedAt || new Date(0).toISOString())],
    [],
    ['Metric', 'Value'],
    ['Total cashed out (confirmed) [Rs.]', num(summary.total_cashed_out)],
    ['Gross withdrawn (all legs) [Rs.]', num(summary.total_withdrawn_gross)],
    ['Withdrawals (cash-exit transactions)', num(summary.total_withdrawals)],
    ['Unique exit points', num(summary.unique_exit_points)],
    ['Risk flags', num(summary.risk_flag_count)],
    ['Channels present', present.join(', ')],
    [],
    ['Channel', 'Transactions', 'Amount [Rs.]', 'Disputed [Rs.]', 'Unique Points', 'Flags'],
    ...order.map((ch) => {
      const c = channels[ch] || {};
      const flagCount = (c.flags || []).reduce((s, f) => s + num(f.count), 0);
      return [ch, num(c.count), num(c.amount), num(c.disputed), num(c.unique_points), flagCount];
    }),
  ]);

  for (const ch of order) {
    const c = channels[ch];
    if (!c || !c.count) continue;
    addSheet(wb, `${ch} Transactions`, [
      txnHeader(ch),
      ...(c.transactions || []).map(txnRow),
    ]);
  }

  const flagRows = [];
  for (const ch of order) {
    for (const f of (channels[ch]?.flags || [])) {
      for (const inst of (f.instances || [])) {
        flagRows.push([
          ch, f.label, inst.account || inst.merchant || inst.terminal || '',
          num(inst.count), num(inst.total_amount), inst.why || '',
        ]);
      }
    }
  }
  addSheet(wb, 'Behavioural Flags', [
    ['Channel', 'Flag', 'Account / Merchant', 'Count', 'Total [Rs.]', 'Why flagged'],
    ...(flagRows.length ? flagRows : [['—', 'No behavioural flags fired', '', '', '', '']]),
  ]);

  const pointRows = [];
  const cityRows = [];
  for (const ch of order) {
    const c = channels[ch];
    if (!c || !c.count) continue;
    for (const p of (c.top_points || [])) {
      pointRows.push([ch, p.terminal || '', p.location || '', num(p.txn_count), num(p.account_count), num(p.amount)]);
    }
    for (const ct of (c.top_cities || [])) {
      cityRows.push([ch, ct.city || '', num(ct.count), num(ct.amount)]);
    }
  }
  addSheet(wb, 'Top Exit Points', [
    ['Channel', 'ATM/Terminal', 'Location/Merchant', 'Txns', 'Accounts', 'Amount [Rs.]'],
    ...(pointRows.length ? pointRows : [['—', '', '', '', '', '']]),
  ]);
  addSheet(wb, 'Top Cities', [
    ['Channel', 'City', 'Txns', 'Amount [Rs.]'],
    ...(cityRows.length ? cityRows : [['—', '', '', '']]),
  ]);

  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { generateReportExcel, generateCashExitExcel };
