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
import { useChartTheme } from '../utils/useChartTheme.js';

// "15 Jan" short label for the axis. NOTE (F4, latent): the year is intentionally
// dropped to keep the axis compact, and the trail can span >1 year. If two active
// days ever share the same day+month across different years (e.g. 2 May 2025 and
// 2 May 2026), they would render with the identical "2 May" label and the
// label-matched ReferenceLine markers (fraud start / latest) could attach to the
// wrong occurrence. No collision occurs in the current reports; revisit with a
// time-scaled axis (or year-qualified labels + date-keyed markers) if it recurs.
function dayMonth(dateStr) {
  const d = new Date(dateStr);
  if (Number.isNaN(d.getTime())) return dateStr;
  return formatDate(d).split(' ').slice(0, 2).join(' ');
}

// Full days elapsed between two instants. Uses floor, not round: the fraud
// response gap is evidentiary, so it reports complete elapsed days rather than
// rounding a partial day up (which would overstate the gap by up to ~1 day).
function daysBetween(a, b) {
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.floor(ms / 86400000));
}

export default function Timeline() {
  const reportId = useActiveReportId();
  // recharts paints SVG fill/stroke, which don't resolve CSS var(); hand it
  // concrete colours that re-resolve on every light/dark flip.
  const chart = useChartTheme();

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
  // Transaction reconciliation (raw legs → deduped → dated/undated). The timeline
  // plots dated rows only; surface the undated split when it carries money so the
  // page reconciles with the headline counts and the Cashout Events total.
  const txRecon = analysis?.reconciliation?.transactions;

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
          /* >3 days = slow response → danger (lifted so the red number stays AA on
             the dark card); a prompt report stays neutral. */
          color={responseGap != null && responseGap > 3 ? 'var(--risk-high)' : 'var(--text-muted)'}
        />
        {/* --brand-text, not raw --brand: navy is ~1.5:1 (illegible) as a value on
            the dark card. "gross throughput" labels the figure the way Layers /
            Money Flow do — it re-counts the same rupees across layers, so it is far
            larger than the victim loss and must not be read as the fraud amount. */}
        <StatCard title="Total Moved" value={formatCrore(totals.amount)} subtitle={`gross throughput · ${formatNumber(totals.transactions)} dated txns`} icon="💸" color="var(--brand-text)" />
        <StatCard title="Cashout Events" value={formatNumber(totals.cashouts)} subtitle="ATM/POS exits" icon="🏧" color="var(--accent-orange)" />
        <StatCard title="Active Days" value={timeline.length} subtitle="days with activity" icon="📅" color="var(--accent)" />
      </div>

      {/* ComposedChart: cumulative area + daily transaction bars */}
      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Cumulative Amount &amp; Daily Transactions</h3>
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart data={chartData} margin={{ top: 16, right: 16, left: 8, bottom: 4 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={chart.border} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fontSize: 12, fill: chart.textMuted }}
              axisLine={{ stroke: chart.border }}
              tickLine={{ stroke: chart.border }}
            />
            <YAxis
              yAxisId="amount"
              tickFormatter={(v) => formatCrore(v)}
              tick={{ fontSize: 12, fill: chart.textMuted }}
              width={64}
              axisLine={{ stroke: chart.border }}
              tickLine={{ stroke: chart.border }}
            />
            <YAxis
              yAxisId="count"
              orientation="right"
              tick={{ fontSize: 12, fill: chart.textMuted }}
              width={40}
              axisLine={{ stroke: chart.border }}
              tickLine={{ stroke: chart.border }}
            />
            <Tooltip
              formatter={(value, name) => (name === 'Cumulative Amount'
                ? [formatINR(value), name]
                : [formatNumber(value), name])}
              cursor={{ fill: chart.text, fillOpacity: 0.06 }}
              contentStyle={{ background: chart.cardBg, border: `1px solid ${chart.border}`, borderRadius: 8, color: chart.text }}
              labelStyle={{ color: chart.text }}
              itemStyle={{ color: chart.text }}
            />
            <Legend wrapperStyle={{ fontSize: 12, color: chart.text }} formatter={(v) => <span style={{ color: chart.text }}>{v}</span>} />
            <Area
              yAxisId="amount"
              type="monotone"
              dataKey="cumulative_amount"
              name="Cumulative Amount"
              stroke={chart.brandText}
              fill={chart.brandText}
              fillOpacity={0.14}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, fill: chart.brandText, stroke: chart.cardBg }}
            />
            <Bar yAxisId="count" dataKey="transaction_count" name="Daily Transactions" fill={chart.accentOrange} radius={[3, 3, 0, 0]} barSize={26} />

            {/* Key event markers — colours are concrete (recharts SVG) and lifted so
                the dashed lines + labels stay legible on the dark card. */}
            {fraudStart && (
              <ReferenceLine yAxisId="amount" x={dayMonth(fraudStart)} stroke={chart.dangerText} strokeDasharray="4 3" strokeWidth={1.5} label={{ value: 'Fraud start', position: 'insideTopRight', fontSize: 11, fontWeight: 600, fill: chart.dangerText }} />
            )}
            {latestDate && (
              <ReferenceLine yAxisId="amount" x={dayMonth(latestDate)} stroke={chart.textMuted} strokeDasharray="4 3" label={{ value: 'Latest', position: 'insideTopLeft', fontSize: 11, fill: chart.textMuted }} />
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
                  {/* Per-day cash-exit (ATM/POS) count. Real numbers now (F1); a
                      legacy snapshot without the field falls back to "—". Days WITH
                      a cash-out are flagged in the danger grammar (lifted so the red
                      stays AA in both themes — raw orange is sub-AA on white) so the
                      high-extraction days pop; zero days stay muted. */}
                  <td style={{ textAlign: 'right' }}>
                    {d.cashouts == null
                      ? '—'
                      : d.cashouts > 0
                        ? <span style={{ fontWeight: 700, color: 'var(--risk-high)' }}>{formatNumber(d.cashouts)}</span>
                        : <span style={{ color: 'var(--text-muted)' }}>0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* F2 — disclose undated rows when they carry money. The timeline can only
            plot dated rows, so the dated total (and per-day Cashouts) sit below the
            case headline; this footnote reconciles the difference. Mirrors the PDF
            Annexure G "Undated" framing. Hidden when undated_amount is 0. */}
        {txRecon && txRecon.undated_amount > 0 && (
          <p style={{ marginTop: 10, marginBottom: 0, fontSize: 12.5, color: 'var(--text-muted)' }}>
            Timeline plots dated transactions only. Excludes {formatINR(txRecon.undated_amount)} across{' '}
            {formatNumber(txRecon.undated)} undated transaction{txRecon.undated === 1 ? '' : 's'} with no
            date in the source file — counted in case totals (including Cashout Events) but not placed on a day.
          </p>
        )}
      </div>
    </div>
  );
}
