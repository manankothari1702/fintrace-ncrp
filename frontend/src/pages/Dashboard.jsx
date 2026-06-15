/**
 * Dashboard page.
 *
 * Case overview for one report. Headline metrics use the "show both" money
 * model: a Victim Loss figure (disputed money that entered the network at the
 * first hop) plus the all-layers Total Trail Disputed for reference. Below that:
 * a Recovery Status ("fund trail") bar, key milestone dates, amount-by-layer and
 * payment-mode charts, an auto-generated Investigation Roadmap, the analyzer's
 * key findings, and the top cashout locations. Export buttons stream the PDF
 * dossier and the multi-sheet Excel workbook.
 *
 * The reportId is resolved by {@link useActiveReportId}. While the report is
 * still analysing the page shows an auto-refreshing "Analyzing…" state.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import StatCard from '../components/StatCard.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { SkeletonStats, SkeletonChart, SkeletonTable } from '../components/Skeleton.jsx';
import { formatCrore, formatINR, formatNumber, formatDate } from '../utils/format.js';
import {
  getReport, getTransactions, openReportPdf, openReportExcel,
  friendlyErrorMessage, ApiError,
} from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

// ─── Colour helpers ──────────────────────────────────────────────────────────

function layerColor(index, total) {
  const t = total <= 1 ? 0 : index / (total - 1);
  const from = [31, 58, 110];
  const to = [198, 40, 40];
  const ch = (i) => Math.round(from[i] + (to[i] - from[i]) * t);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

const PAYMENT_MODE_COLORS = {
  ATM: 'var(--danger)',
  UPI: 'var(--brand)',
  IMPS: 'var(--accent)',
  NEFT: 'var(--accent-orange)',
  Others: 'var(--text-muted)',
};

// Recovery-bucket → colour grammar (cashed out is the worst outcome).
const RECOVERY_COLORS = {
  cashed_out: 'var(--danger)',
  on_hold: 'var(--accent-orange)',
  refunded: 'var(--brand)',
  recoverable: 'var(--accent)',
};

// Roadmap priority → colour (P0 most urgent).
const PRIORITY_COLORS = {
  P0: 'var(--danger)',
  P1: 'var(--accent-orange)',
  P2: 'var(--brand)',
  P3: 'var(--text-muted)',
};

function findingIcon(text) {
  const t = text.toLowerCase();
  if (/(lien|recommend|priority|action|recover)/.test(t)) return '🎯';
  if (/(₹|cash|amount|exposure|recoverable|victim)/.test(t)) return '💰';
  return '⚠️';
}

function groupByPaymentMode(rows) {
  const counts = new Map();
  for (const t of rows || []) {
    const mode = (t.payment_mode || 'Others').toUpperCase();
    counts.set(mode, (counts.get(mode) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([mode, count]) => ({ mode, count }))
    .sort((a, b) => b.count - a.count);
}

// ─── Recovery "fund trail" bar ─────────────────────────────────────────────────

function RecoveryBar({ recovery }) {
  if (!recovery || !recovery.base_amount) return null;
  const segments = [
    { key: 'cashed_out', label: 'Cashed Out', amount: recovery.cashed_out, pct: recovery.cashed_out_pct },
    { key: 'on_hold', label: 'On Hold', amount: recovery.on_hold, pct: recovery.on_hold_pct },
    { key: 'refunded', label: 'Refunded', amount: recovery.refunded, pct: recovery.refunded_pct },
    { key: 'recoverable', label: 'Recoverable', amount: recovery.recoverable, pct: recovery.recoverable_pct },
  ].filter((s) => s.pct > 0);

  return (
    <div className="card card-pad" style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Fund Trail — Recovery Status</h3>
      <p className="subtitle" style={{ marginBottom: 14 }}>
        Where the {formatINR(recovery.base_amount)} of victim funds ended up.
      </p>
      <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
        {segments.map((s) => (
          <div
            key={s.key}
            title={`${s.label}: ${formatINR(s.amount)} (${s.pct}%)`}
            style={{
              width: `${s.pct}%`, background: RECOVERY_COLORS[s.key],
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: '#fff', fontSize: 11, fontWeight: 700, minWidth: s.pct > 6 ? 'auto' : 0,
            }}
          >
            {s.pct >= 8 ? `${s.pct}%` : ''}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
        {segments.map((s) => (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: RECOVERY_COLORS[s.key], display: 'inline-block' }} />
            <span style={{ fontWeight: 600 }}>{s.label}</span>
            <span style={{ color: 'var(--text-muted)' }}>{formatINR(s.amount)} ({s.pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Data Quality status card (v0.2.0) ────────────────────────────────────────

// Actionable flag → short officer-facing chip label.
const DQ_ACTIONABLE_LABELS = [
  ['INVALID_IFSC', 'Invalid IFSC'],
  ['UNKNOWN_IFSC_PREFIX', 'Unknown IFSC prefix'],
  ['NO_IFSC', 'Bank row missing IFSC'],
];

const DQ_STATUS_COLORS = {
  green: 'var(--accent)',
  amber: 'var(--accent-orange)',
  red: 'var(--danger)',
};

/**
 * Always-visible rigor signal with a freeze-target-scoped severity model:
 *   green — zero actionable flags (auto-corrected mismatches and expected
 *           wallet/cash no-IFSC rows are informational, shown separately).
 *   amber — actionable flags exist, but none on a lien-table account.
 *   red   — an actionable flag falls on a freeze-target account: a lien
 *           letter is about to go to a bank that couldn't be confirmed.
 * Flags are advisory metadata only — they never alter financial totals.
 * Clicking drills into the affected accounts on the Data Quality page.
 */
function DataQualityCard({ analysis, reportId }) {
  let dq = analysis?.data_quality_summary;
  const legacy = !dq || dq.actionable_accounts === undefined;
  if (legacy) {
    // Reports analysed before the severity model: derive a coarse fallback
    // from the row list. Severity can't be reconstructed, so any flag → amber.
    const rows = analysis?.data_quality || [];
    dq = {
      flagged_accounts: rows.length,
      actionable_accounts: rows.length,
      actionable_counts: {},
      informational: { auto_corrected: 0, expected_no_ifsc: 0 },
      freeze_target_total: null,
      freeze_target_flags: null,
      status: rows.length === 0 ? 'green' : 'amber',
    };
  }

  const color = DQ_STATUS_COLORS[dq.status] || DQ_STATUS_COLORS.amber;
  const icon = dq.status === 'green' ? '✅' : dq.status === 'red' ? '⛔' : '🔎';

  let headline;
  let detail;
  if (dq.status === 'green') {
    headline = dq.freeze_target_total
      ? `Data quality: clean — all ${formatNumber(dq.freeze_target_total)} freeze-target banks confirmed from IFSC`
      : 'Data quality: clean — no actionable flags';
    detail = 'Every lien letter targets a bank confirmed from its IFSC.';
  } else if (dq.status === 'red') {
    headline = `${formatNumber(dq.freeze_target_flags)} freeze-target bank(s) could not be confirmed from IFSC — verify before issuing lien letters.`;
    detail = 'These accounts are in the lien table, but their bank rests on unverified source text. Figures are unaffected.';
  } else {
    headline = legacy
      ? `${formatNumber(dq.flagged_accounts)} account(s) need bank verification — figures unaffected.`
      : `${formatNumber(dq.actionable_accounts)} account(s) need bank verification (none are freeze targets) — figures unaffected.`;
    detail = 'No lien-table account is affected; review when convenient.';
  }

  const info = dq.informational || {};
  const infoParts = [];
  if (info.auto_corrected > 0) {
    infoParts.push(`${formatNumber(info.auto_corrected)} bank names auto-corrected from IFSC (source text disagreed)`);
  }
  if (info.expected_no_ifsc > 0) {
    infoParts.push(`${formatNumber(info.expected_no_ifsc)} wallet/cash rows without IFSC (expected)`);
  }

  const chips = DQ_ACTIONABLE_LABELS.filter(([key]) => (dq.actionable_counts?.[key] || 0) > 0);

  return (
    <Link
      to={`/data-quality${reportId ? `?reportId=${reportId}` : ''}`}
      className="card card-pad"
      aria-label="Open data quality details"
      style={{
        display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20,
        borderLeft: `4px solid ${color}`,
        textDecoration: 'none', color: 'inherit', cursor: 'pointer',
      }}
    >
      <span style={{ fontSize: 24 }} aria-hidden="true">{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ color }}>{headline}</strong>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{detail}</div>
        {chips.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {chips.map(([key, label]) => (
              <span
                key={key}
                style={{
                  fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 999,
                  background: 'var(--brand-light)', color: 'var(--text)', border: '1px solid var(--border)',
                }}
              >
                {label}: {formatNumber(dq.actionable_counts[key])}
              </span>
            ))}
          </div>
        )}
        {infoParts.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            ✓ {infoParts.join(' · ')}
          </div>
        )}
      </div>
      <span className="btn btn-sm btn-primary" style={{ flexShrink: 0 }}>
        {dq.status === 'green' ? 'Details →' : 'Review →'}
      </span>
    </Link>
  );
}

// ─── Milestone date card ───────────────────────────────────────────────────────

function DateCard({ label, date, icon, color }) {
  return (
    <div className="stat-card" style={{ borderLeftColor: color }}>
      <div className="stat-head">
        <span className="stat-title">{label}</span>
        <span className="stat-icon" aria-hidden="true">{icon}</span>
      </div>
      <div className="stat-value" style={{ color, fontSize: 20 }}>{date ? formatDate(date) : '—'}</div>
    </div>
  );
}

export default function Dashboard() {
  const reportId = useActiveReportId();

  const [report, setReport] = useState(null);
  const [paymentSplit, setPaymentSplit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Export feedback: which button is busy ('pdf' | 'excel' | null) + last error.
  const [exporting, setExporting] = useState(null);
  const [exportError, setExportError] = useState(null);

  async function handleExport(kind) {
    setExportError(null);
    setExporting(kind);
    try {
      if (kind === 'pdf') await openReportPdf(report.id);
      else await openReportExcel(report.id);
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    async function load() {
      try {
        const r = await getReport(reportId);
        if (cancelled) return;
        setReport(r);
        setError(null);
        setLoading(false);

        if (r.analysis_status === 'complete') {
          try {
            const txns = await getTransactions(reportId, { limit: 500 });
            if (!cancelled) setPaymentSplit(groupByPaymentMode(txns.data));
          } catch (_e) { /* pie is non-critical */ }
        } else if (r.analysis_status !== 'error') {
          timer = setTimeout(load, 2000);
        }
      } catch (err) {
        if (!cancelled) { setError(err); setLoading(false); }
      }
    }

    setLoading(true);
    setError(null);
    load();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [reportId]);

  const analysis = report?.analysis_json;
  const summary = analysis?.summary;
  const recovery = analysis?.recovery_status;
  const timelineSummary = analysis?.timeline_summary;
  const roadmap = analysis?.investigation_roadmap || [];

  const lienEligibleTotal = useMemo(
    () => (analysis?.lien_calculation || []).reduce((s, l) => s + (l.lien_eligible_amount || 0), 0),
    [analysis],
  );

  const layerChartData = useMemo(
    () => (analysis?.layer_analysis || []).map((l) => ({
      name: `Layer ${l.layer_no}`,
      amount: l.total_amount,
    })),
    [analysis],
  );

  const paymentChartData = useMemo(
    () => paymentSplit.map((p) => ({ name: p.mode, value: p.count })),
    [paymentSplit],
  );

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Dashboard</h1>
          <p className="subtitle">Loading case overview…</p>
        </header>
        <SkeletonStats count={4} />
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', marginBottom: 20 }}>
          <SkeletonChart />
          <SkeletonChart />
        </div>
        <SkeletonTable rows={5} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Dashboard</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load the report"
          message={error.code === 'NO_REPORT'
            ? 'No report is selected. Upload a file or pick one from Previous Reports.'
            : friendlyErrorMessage(error)}
        />
        <div style={{ marginTop: 16 }}>
          <Link className="btn btn-primary" to="/upload">← Go to Upload</Link>
        </div>
      </div>
    );
  }

  if (report.analysis_status === 'error') {
    return (
      <div className="page">
        <header className="page-header"><h1>Dashboard</h1></header>
        <ErrorAlert
          title="Analysis failed for this report"
          message="The background analysis did not complete. Re-upload the file or contact MINT support."
        />
        <div style={{ marginTop: 16 }}>
          <Link className="btn btn-primary" to="/upload">← Go to Upload</Link>
        </div>
      </div>
    );
  }

  if (report.analysis_status !== 'complete') {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Dashboard</h1>
          <p className="subtitle">{report.original_filename}</p>
        </header>
        <LoadingSpinner block label="Analyzing… this report is still being processed. The page refreshes automatically." />
      </div>
    );
  }

  const totalLayers = summary?.total_layers ?? report.total_layers;
  const victimLoss = summary?.victim_loss_amount ?? report.total_disputed_amount;
  const trailDisputed = summary?.total_trail_disputed ?? summary?.total_disputed_amount ?? report.total_disputed_amount;
  const uniqueTxns = summary?.unique_transactions ?? report.total_transactions;

  return (
    <div className="page">
      <header className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>Dashboard</h1>
          <p className="subtitle">{report.original_filename} · case overview &amp; recommended actions</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => handleExport('excel')}
            disabled={exporting !== null}
          >
            {exporting === 'excel' ? '… Exporting' : '⬇ Export Excel'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => handleExport('pdf')}
            disabled={exporting !== null}
          >
            {exporting === 'pdf' ? '… Exporting' : '⬇ Export PDF'}
          </button>
        </div>
      </header>

      {exportError && (
        <div style={{ marginBottom: 16 }}>
          <ErrorAlert
            error={exportError}
            title="Export failed"
            message={friendlyErrorMessage(exportError)}
          />
        </div>
      )}

      {/* Data Quality status card (v0.2.0) — always visible near the top as a
          rigor signal: green = every bank attribution verified from its IFSC,
          amber = some accounts need IO review, red = pervasively poor source
          data. Advisory only — flags never alter financial totals. Clicking
          drills into the affected accounts. */}
      <DataQualityCard analysis={analysis} reportId={reportId} />

      {/* Row 1 — headline metrics (Victim Loss is the actual loss; Trail Disputed re-counts the same money across hops). */}
      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard
          title="Victim Loss (Total Fraud)"
          value={formatCrore(victimLoss)}
          subtitle={`Trail disputed ${formatCrore(trailDisputed)} · ${formatNumber(uniqueTxns)} transactions`}
          icon="💸"
          color="var(--danger)"
        />
        <StatCard title="Layers in Trail" value={totalLayers} subtitle="laundering hops" icon="🔢" color="var(--brand)" />
        <StatCard title="Mule Accounts" value={formatNumber(analysis?.mule_detection?.length || 0)} subtitle="flagged accounts" icon="🎯" color="var(--accent-orange)" />
        <StatCard title="Lien Eligible" value={formatCrore(lienEligibleTotal)} subtitle="recoverable balance" icon="💰" color="var(--accent)" />
      </div>

      {/* Recovery / fund-trail bar */}
      <RecoveryBar recovery={recovery} />

      {/* Milestone dates */}
      {timelineSummary && (
        <div className="grid grid-stats" style={{ marginBottom: 20 }}>
          <DateCard label="First Fraud" date={timelineSummary.first_fraud_date} icon="🚨" color="var(--danger)" />
          <DateCard label="First Cashout" date={timelineSummary.first_cashout_date} icon="🏧" color="var(--accent-orange)" />
          <DateCard label="First Bank Action" date={timelineSummary.first_bank_action_date} icon="🏦" color="var(--brand)" />
          <DateCard label="First Refund" date={timelineSummary.first_refund_date} icon="↩️" color="var(--accent)" />
        </div>
      )}

      {/* Row 2 — charts */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', marginBottom: 20 }}>
        <div className="card card-pad">
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Amount by Layer</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={layerChartData} margin={{ top: 8, right: 8, left: 8, bottom: 4 }}>
              <XAxis dataKey="name" tick={{ fontSize: 12 }} />
              <YAxis tickFormatter={(v) => formatCrore(v)} tick={{ fontSize: 12 }} width={64} />
              <Tooltip formatter={(v) => formatINR(v)} cursor={{ fill: 'rgba(31,58,110,0.06)' }} />
              <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                {layerChartData.map((_, i) => (
                  <Cell key={i} fill={layerColor(i, layerChartData.length)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card card-pad">
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Payment Mode Distribution</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={paymentChartData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(e) => e.name}>
                {paymentChartData.map((entry, i) => (
                  <Cell key={i} fill={PAYMENT_MODE_COLORS[entry.name] || 'var(--text-muted)'} />
                ))}
              </Pie>
              <Tooltip formatter={(v, n) => [`${formatNumber(v)} txns`, n]} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Investigation roadmap */}
      {roadmap.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Investigation Roadmap</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {roadmap.map((item, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', gap: 12, alignItems: 'flex-start',
                  padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  borderLeft: `4px solid ${PRIORITY_COLORS[item.priority] || 'var(--text-muted)'}`,
                }}
              >
                <span style={{
                  flexShrink: 0, fontWeight: 800, fontSize: 12, color: '#fff',
                  background: PRIORITY_COLORS[item.priority] || 'var(--text-muted)',
                  borderRadius: 4, padding: '2px 8px',
                }}>{item.priority}</span>
                <div>
                  <div style={{ fontWeight: 700 }}>{item.title}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 2 }}>{item.description}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key findings */}
      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Key Findings &amp; Recommended Actions</h3>
        {(analysis?.key_findings || []).length === 0 ? (
          <div className="empty-state">No findings generated for this report.</div>
        ) : (
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {analysis.key_findings.map((finding, i) => (
              <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 16, lineHeight: 1.4 }} aria-hidden="true">{findingIcon(finding)}</span>
                <span>{finding}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Top cashout locations */}
      <div className="card card-pad">
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Top Cashout Locations</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ATM ID</th>
                <th>Location</th>
                <th>State</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ textAlign: 'right' }}>Withdrawals</th>
              </tr>
            </thead>
            <tbody>
              {(analysis?.cashout_analysis?.atm_cashouts || []).length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">No ATM or POS cashouts were detected in this trail — funds may still be sitting in beneficiary accounts (check the Lien Tracker).</div>
                  </td>
                </tr>
              ) : (
                (analysis?.cashout_analysis?.atm_cashouts || []).map((a) => (
                  <tr key={a.atm_id}>
                    <td>{a.atm_id || '—'}</td>
                    <td>{a.atm_location || '—'}</td>
                    <td>{a.state || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatINR(a.amount)}</td>
                    <td style={{ textAlign: 'right' }}>{formatNumber(a.count)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
