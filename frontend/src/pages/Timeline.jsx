/**
 * Money Movement Timeline page.
 *
 * A ComposedChart overlays cumulative amount (area) on daily transaction count
 * (bars), with reference-line markers for the fraud start, first cashout, and
 * latest transaction. Below it, a date-wise table; up top, the "fraud response
 * gap" — days between the fraud start and when the report was uploaded.
 *
 * Loads getReport(id) (for case dates + cashout totals) and getTimeline(id)
 * (date, total_amount, transaction_count, layer_breakdown) in parallel.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import StatCard from '../components/StatCard.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { SkeletonStats, SkeletonChart, SkeletonTable } from '../components/Skeleton.jsx';
import { formatCrore, formatINR, formatDate, formatNumber } from '../utils/format.js';
import { getReport, getTimeline, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

// "15 Jan" short label for the axis.
function dayMonth(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return formatDate(d).split(' ').slice(0, 2).join(' ');
}

function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round(ms / 86400000));
}

export default function Timeline() {
  const reportId = useActiveReportId();

  const [timeline, setTimeline] = useState([]);
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    Promise.all([getReport(reportId), getTimeline(reportId)])
      .then(([r, tl]) => { if (!cancelled) { setReport(r); setTimeline(tl); } })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [reportId]);

  const analysis = report?.analysis_json;

  // Cumulative amount for the area series.
  const chartData = useMemo(() => {
    let cumulative = 0;
    return timeline.map((d) => {
      cumulative += d.total_amount || 0;
      return {
        date: d.date,
        label: dayMonth(d.date),
        cumulative_amount: cumulative,
        transaction_count: d.transaction_count,
      };
    });
  }, [timeline]);

  const totals = useMemo(() => ({
    amount: timeline.reduce((s, d) => s + (d.total_amount || 0), 0),
    transactions: timeline.reduce((s, d) => s + (d.transaction_count || 0), 0),
    // Per-day cashout counts are not in the timeline snapshot; the case total
    // comes from the cashout analysis instead.
    cashouts: analysis?.cashout_analysis?.total_cashout_transactions ?? 0,
  }), [timeline, analysis]);

  const latestDate = timeline.length ? timeline[timeline.length - 1].date : null;
  const fraudStart = analysis?.summary?.fraud_start_date
    || report?.fraud_start_date
    || (timeline.length ? timeline[0].date : null);
  const uploadDate = report?.upload_date || null;
  const responseGap = daysBetween(fraudStart, uploadDate);

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Money Movement Timeline</h1>
          <p className="subtitle">Building timeline…</p>
        </header>
        <SkeletonStats count={4} />
        <div style={{ marginBottom: 20 }}><SkeletonChart height={340} /></div>
        <SkeletonTable rows={6} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Money Movement Timeline</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load timeline"
          message={error.code === 'NO_REPORT'
            ? 'No report is selected. Upload a file or pick one from Previous Reports.'
            : friendlyErrorMessage(error)}
        />
        <div style={{ marginTop: 16 }}><Link className="btn btn-primary" to="/upload">← Go to Upload</Link></div>
      </div>
    );
  }

  if (timeline.length === 0) {
    return (
      <div className="page">
        <header className="page-header"><h1>Money Movement Timeline</h1></header>
        <div className="card card-pad">
          <div className="empty-state">
            No dated activity to plot. The uploaded file did not carry transaction
            dates this analysis could read, so a day-by-day timeline cannot be drawn.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Money Movement Timeline</h1>
        <p className="subtitle">Daily flow from {formatDate(fraudStart)} to {formatDate(latestDate)}.</p>
      </header>

      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard
          title="Fraud Response Gap"
          value={responseGap == null ? '—' : `${responseGap} day${responseGap === 1 ? '' : 's'}`}
          subtitle="fraud start → upload"
          icon="⏱️"
          color={responseGap != null && responseGap > 3 ? 'var(--danger)' : 'var(--accent-orange)'}
        />
        <StatCard title="Total Moved" value={formatCrore(totals.amount)} subtitle={`${formatNumber(totals.transactions)} transactions`} icon="💸" color="var(--brand)" />
        <StatCard title="Cashout Events" value={formatNumber(totals.cashouts)} subtitle="ATM/POS exits" icon="🏧" color="var(--accent-orange)" />
        <StatCard title="Active Days" value={timeline.length} subtitle="days with activity" icon="📅" color="var(--accent)" />
      </div>

      {/* ComposedChart: cumulative area + daily transaction bars */}
      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Cumulative Amount &amp; Daily Transactions</h3>
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={chartData} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
            <XAxis dataKey="label" tick={{ fontSize: 12 }} />
            <YAxis yAxisId="amount" tickFormatter={(v) => formatCrore(v)} tick={{ fontSize: 12 }} width={64} />
            <YAxis yAxisId="count" orientation="right" tick={{ fontSize: 12 }} width={40} />
            <Tooltip
              formatter={(value, name) => (name === 'Cumulative Amount'
                ? [formatINR(value), name]
                : [formatNumber(value), name])}
            />
            <Legend />
            <Area
              yAxisId="amount"
              type="monotone"
              dataKey="cumulative_amount"
              name="Cumulative Amount"
              stroke="var(--brand)"
              fill="var(--brand-light)"
              strokeWidth={2}
            />
            <Bar yAxisId="count" dataKey="transaction_count" name="Daily Transactions" fill="var(--accent-orange)" radius={[3, 3, 0, 0]} barSize={26} />

            {/* Key event markers */}
            {fraudStart && (
              <ReferenceLine yAxisId="amount" x={dayMonth(fraudStart)} stroke="var(--danger)" strokeDasharray="4 3" label={{ value: 'Fraud start', position: 'top', fontSize: 11, fill: 'var(--danger)' }} />
            )}
            {latestDate && (
              <ReferenceLine yAxisId="amount" x={dayMonth(latestDate)} stroke="var(--text-muted)" strokeDasharray="4 3" label={{ value: 'Latest', position: 'top', fontSize: 11, fill: 'var(--text-muted)' }} />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Date-wise table */}
      <div className="card card-pad">
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Date-wise Activity</h3>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th style={{ textAlign: 'right' }}>Transactions</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th>Layers Active</th>
                <th style={{ textAlign: 'right' }}>Cashouts</th>
              </tr>
            </thead>
            <tbody>
              {timeline.map((d) => (
                <tr key={d.date}>
                  <td>{formatDate(d.date)}</td>
                  <td style={{ textAlign: 'right' }}>{formatNumber(d.transaction_count)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatINR(d.total_amount)}</td>
                  <td>{Object.keys(d.layer_breakdown || {}).map((l) => `L${l}`).join(', ') || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{d.cashouts == null ? '—' : formatNumber(d.cashouts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
