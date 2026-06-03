/**
 * Dashboard page.
 *
 * Case overview for one report: four headline StatCards, two charts (amount by
 * layer + payment-mode split), the analyzer's key findings, and a cashout
 * summary table.
 *
 * The reportId is resolved by {@link useActiveReportId}: the URL (`?reportId=`)
 * wins, falling back to the shared/persisted active report.
 *
 * Loads getReport(id); when the report is still analysing it shows an
 * auto-refreshing "Analyzing…" state. The payment-mode pie is derived
 * client-side from a page of getTransactions (the analyzer emits no such split).
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
import { formatCrore, formatINR, formatNumber } from '../utils/format.js';
import { getReport, getTransactions, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

// ─── Colour helpers ──────────────────────────────────────────────────────────

// Interpolate brand navy → danger red across the layers (Layer 0 = blue,
// final layer = red), matching the spec's "blue to red" gradient.
function layerColor(index, total) {
  const t = total <= 1 ? 0 : index / (total - 1);
  const from = [31, 58, 110];   // --brand  #1F3A6E
  const to = [198, 40, 40];     // --danger #C62828
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

// Pick an icon for a finding based on its wording.
function findingIcon(text) {
  const t = text.toLowerCase();
  if (/(lien|recommend|priority|action|recover)/.test(t)) return '🎯';
  if (/(₹|cash|amount|exposure|recoverable)/.test(t)) return '💰';
  return '⚠️';
}

// The analyzer does not emit a payment-mode breakdown, so the pie is derived
// client-side by grouping a page of transactions by payment_mode.
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

export default function Dashboard() {
  const reportId = useActiveReportId();

  const [report, setReport] = useState(null);
  const [paymentSplit, setPaymentSplit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

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
          // Derive the payment-mode pie from a page of transactions.
          try {
            const txns = await getTransactions(reportId, { limit: 500 });
            if (!cancelled) setPaymentSplit(groupByPaymentMode(txns.data));
          } catch (_e) { /* pie is non-critical; leave it empty on failure */ }
        } else if (r.analysis_status !== 'error') {
          // Still pending / processing — auto-refresh until it settles.
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

  // Analysis failed server-side.
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

  // Still analysing — show progress and auto-refresh (the effect re-polls).
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

  const totalLayers = analysis?.summary?.total_layers ?? report.total_layers;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Dashboard</h1>
        <p className="subtitle">{report.original_filename} · case overview &amp; recommended actions</p>
      </header>

      {/* Row 1 — headline metrics */}
      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard title="Total Disputed" value={formatCrore(report.total_disputed_amount)} subtitle={`${formatNumber(report.total_transactions)} transactions`} icon="💸" color="var(--danger)" />
        <StatCard title="Layers in Trail" value={totalLayers} subtitle="laundering hops" icon="🔢" color="var(--brand)" />
        <StatCard title="Mule Accounts" value={formatNumber(analysis?.mule_detection?.length || 0)} subtitle="flagged accounts" icon="🎯" color="var(--accent-orange)" />
        <StatCard title="Lien Eligible" value={formatCrore(lienEligibleTotal)} subtitle="recoverable" icon="💰" color="var(--accent)" />
      </div>

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

      {/* Row 3 — key findings */}
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

      {/* Row 4 — cashout summary */}
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
