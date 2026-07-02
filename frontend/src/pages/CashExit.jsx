/**
 * Cash / Exit Channel page (Features 4 & 5).
 *
 * One channel's story on screen at a time. An overview band answers "how much
 * left and is anything alarming"; channel tabs (ATM / POS / AEPS, zero-count
 * ones disabled) drive progressive disclosure; each channel shows KPI cards plus
 * behavioural flag cards that are CLICKABLE FILTERS (rapid withdrawals + multi-
 * ATM for ATM; suspicious merchants for POS). Clicking a flag card filters the
 * transaction table below to just those instances and adds a "Why flagged"
 * column. All figures are computed once in the backend (analysis.cash_exit_
 * analysis) and cached; this page only renders and filters them.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, LabelList,
} from 'recharts';

import StatCard from '../components/StatCard.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { SkeletonStats, SkeletonTable } from '../components/Skeleton.jsx';
import { formatINR, formatCrore, formatNumber, formatDateTimeUTC } from '../utils/format.js';
import { getCashExit, openCashExitExcel, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';
import { useChartTheme } from '../utils/useChartTheme.js';

const CHANNEL_ORDER = ['ATM', 'POS', 'AEPS'];
const FLAG_TIPS = {
  rapid: 'Rapid withdrawals — one account making 3 or more cash withdrawals within an hour.',
  multi_atm: 'Multi-ATM — one account withdrawing at 3 or more different ATMs in a single day.',
  suspicious_merchant: 'Suspicious merchant — 3 or more POS transactions at one terminal within an hour.',
};

export default function CashExit() {
  const reportId = useActiveReportId();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [channel, setChannel] = useState(null);
  const [activeFlag, setActiveFlag] = useState(null);
  const chart = useChartTheme();

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }
    getCashExit(reportId)
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reportId]);

  const summary = data?.summary;
  const channels = data?.channels || {};
  const present = summary?.channels_present || [];

  // Default the active channel to the first one that has activity.
  useEffect(() => {
    if (!present.length) { setChannel(null); return; }
    if (!channel || !present.includes(channel)) setChannel(present[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  // Switching channel clears any active flag filter.
  const selectChannel = (ch) => { setChannel(ch); setActiveFlag(null); };

  const active = channel ? channels[channel] : null;

  // Map txn id → "why flagged" for the currently active flag, and the filtered
  // transaction set the table renders.
  const { rows, whyById } = useMemo(() => {
    if (!active) return { rows: [], whyById: null };
    if (!activeFlag) return { rows: active.transactions || [], whyById: null };
    const flag = (active.flags || []).find((f) => f.key === activeFlag);
    if (!flag) return { rows: active.transactions || [], whyById: null };
    const why = new Map();
    for (const inst of flag.instances || []) {
      for (const id of inst.txn_ids || []) why.set(id, inst.why);
    }
    const filtered = (active.transactions || []).filter((t) => why.has(t.id));
    return { rows: filtered, whyById: why };
  }, [active, activeFlag]);

  // Overview risk-flag breakdown, e.g. "rapid 5 · multi-ATM 1 · merchant 1".
  const flagBreakdown = useMemo(() => {
    const parts = [];
    const labels = { rapid: 'rapid', multi_atm: 'multi-ATM', suspicious_merchant: 'merchant' };
    for (const ch of CHANNEL_ORDER) {
      for (const f of (channels[ch]?.flags || [])) {
        if (f.count > 0) parts.push(`${labels[f.key] || f.key} ${f.count}`);
      }
    }
    return parts.join(' · ');
  }, [channels]);

  const isPos = channel === 'POS';
  const pointLabel = isPos ? 'Merchant' : 'ATM';

  const [exporting, setExporting] = useState(null); // 'view' | 'all' | null

  // Both exports produce a real multi-sheet .xlsx from the backend (reusing the
  // NCRP workbook infra). "view" = the current channel/flag filter (one sheet);
  // "all" = the full channel breakdown (overview + per-channel + flags + tops).
  const runExport = async (scope) => {
    if (!reportId) return;
    setExporting(scope);
    try {
      const params = scope === 'view'
        ? { scope: 'view', channel, ...(activeFlag ? { flag: activeFlag } : {}) }
        : { scope: 'full' };
      await openCashExitExcel(reportId, params);
    } catch (e) {
      // Surface, but don't crash the page — the buttons re-enable below.
      // eslint-disable-next-line no-console
      console.error('Cash/Exit export failed:', e);
    } finally {
      setExporting(null);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <header className="page-header"><h1>Cash / Exit Channel</h1><p className="subtitle">Loading exit-channel analytics…</p></header>
        <SkeletonStats count={4} />
        <SkeletonTable rows={8} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Cash / Exit Channel</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load cash-exit analytics"
          message={error.code === 'NO_REPORT'
            ? 'No report is selected. Upload a file or pick one from Previous Reports.'
            : friendlyErrorMessage(error)}
        />
        <div style={{ marginTop: 16 }}><Link className="btn btn-primary" to="/upload">← Go to Upload</Link></div>
      </div>
    );
  }

  const noCashOut = !summary || summary.total_withdrawals === 0;

  return (
    <div className="page">
      <header className="page-header page-header-row">
        <div>
          <h1>Cash / Exit Channel</h1>
          <p className="subtitle">Where the money left the banking system and where cash was pulled.</p>
        </div>
        {!noCashOut && (
          <div className="cash-exit-export">
            <button type="button" className="btn btn-secondary" onClick={() => runExport('view')} disabled={exporting !== null} title="Export the transactions currently shown (this channel / filter) as an Excel sheet">
              {exporting === 'view' ? '… Exporting' : '⬇ Export view'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => runExport('all')} disabled={exporting !== null} title="Export every channel's breakdown as one multi-sheet Excel workbook">
              {exporting === 'all' ? '… Exporting' : '⬇ Export all'}
            </button>
          </div>
        )}
      </header>

      {/* Overview band — channel-agnostic. */}
      <div className="metrics-band-label">Overview</div>
      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard
          title="Total Cashed Out"
          value={formatCrore(summary.total_cashed_out)}
          subtitle={`confirmed · gross ${formatCrore(summary.total_withdrawn_gross)}`}
          icon="🏧"
          color="var(--accent-orange)"
          info="Confirmed cash-out (capped at each account's disputed inflow) — the same headline figure as the Dashboard. Per-channel amounts below are gross."
        />
        <StatCard title="Withdrawals" value={formatNumber(summary.total_withdrawals)} subtitle="cash-exit transactions" color="var(--brand)" />
        <StatCard title="Unique Exit Points" value={formatNumber(summary.unique_exit_points)} subtitle="ATMs · POS terminals" color="var(--brand)" />
        <StatCard
          title="Risk Flags"
          value={formatNumber(summary.risk_flag_count)}
          subtitle={summary.risk_flag_count > 0 ? (flagBreakdown || 'behavioural flags') : 'none detected'}
          icon={summary.risk_flag_count > 0 ? <span style={{ color: 'var(--risk-high)' }}>⚑</span> : undefined}
          color={summary.risk_flag_count > 0 ? 'var(--risk-high)' : 'var(--risk-low)'}
          info="Behavioural flags across all channels: rapid withdrawals, multi-ATM accounts, and suspicious POS merchants."
        />
      </div>

      {noCashOut ? (
        <div className="card card-pad cash-exit-empty">
          <div className="cash-exit-empty-icon" aria-hidden="true">🏧</div>
          <h3>No cash-out activity in this case</h3>
          <p>
            Every disputed rupee in this trail moved as bank transfers or is on hold — no ATM, POS, or AEPS
            cash exits were found. There are no exit channels to analyse.
          </p>
          <Link className="btn btn-secondary" to={`/transactions${reportId ? `?reportId=${reportId}` : ''}`}>
            View all transactions →
          </Link>
        </div>
      ) : (
        <>
          {/* Channel tabs — zero-count channels disabled/greyed. */}
          <div className="channel-tabs" role="tablist" aria-label="Exit channel">
            {CHANNEL_ORDER.map((ch) => {
              const c = channels[ch];
              const count = c?.count || 0;
              const disabled = count === 0;
              return (
                <button
                  key={ch}
                  type="button"
                  role="tab"
                  aria-selected={channel === ch}
                  disabled={disabled}
                  className={`channel-tab${channel === ch ? ' active' : ''}`}
                  onClick={() => !disabled && selectChannel(ch)}
                  title={disabled ? `No ${ch} cash-outs in this case` : undefined}
                >
                  {ch} <span className="channel-tab-count">({formatNumber(count)})</span>
                </button>
              );
            })}
          </div>

          {active && (
            <>
              {/* Channel KPI + behavioural flag cards. */}
              <div className="grid grid-stats" style={{ marginBottom: 20 }}>
                <StatCard title={isPos ? 'POS Spend' : 'Withdrawn'} value={formatCrore(active.amount)} subtitle={`${formatNumber(active.count)} transactions`} color="var(--accent-orange)" />
                <StatCard title="Disputed" value={formatCrore(active.disputed)} subtitle="traced fraud portion" color="var(--danger)" />
                <StatCard title={isPos ? 'Unique Merchants' : 'Unique ATMs'} value={formatNumber(active.unique_points)} subtitle={isPos ? 'terminals / merchants' : 'distinct ATMs'} color="var(--brand)" />
                {(active.flags || []).map((f) => (
                  <FlagCard
                    key={f.key}
                    flag={f}
                    active={activeFlag === f.key}
                    onToggle={() => setActiveFlag((cur) => (cur === f.key ? null : f.key))}
                  />
                ))}
              </div>

              {/* Top cities chart + top exit points table. */}
              <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', marginBottom: 20 }}>
                <div className="card card-pad">
                  <h3 style={{ fontSize: 15, marginBottom: 12 }}>Top cities by amount</h3>
                  {active.top_cities.length === 0 ? (
                    <div className="empty-state" style={{ padding: 20 }}>No city recorded for {channel} exits.</div>
                  ) : (
                    <ResponsiveContainer width="100%" height={Math.max(160, active.top_cities.length * 40)}>
                      <BarChart data={active.top_cities} layout="vertical" margin={{ top: 4, right: 48, left: 8, bottom: 4 }}>
                        <CartesianGrid horizontal={false} stroke={chart.border} strokeDasharray="3 3" />
                        <XAxis type="number" tickFormatter={(v) => formatCrore(v)} tick={{ fontSize: 11, fill: chart.textMuted }} axisLine={{ stroke: chart.border }} tickLine={{ stroke: chart.border }} />
                        <YAxis type="category" dataKey="city" width={110} tick={{ fontSize: 12, fill: chart.textMuted }} axisLine={{ stroke: chart.border }} tickLine={{ stroke: chart.border }} />
                        <Tooltip
                          contentStyle={{ background: chart.cardBg, border: `1px solid ${chart.border}`, borderRadius: 8, color: chart.text }}
                          labelStyle={{ color: chart.text }} itemStyle={{ color: chart.text }}
                          cursor={{ fill: chart.border, opacity: 0.35 }}
                          formatter={(v) => [formatINR(v), 'Amount']}
                        />
                        <Bar dataKey="amount" fill={chart.accentOrange} radius={[0, 3, 3, 0]}>
                          {/* fill as a direct prop (not style) so recharts doesn't
                              override the label colour with the bar fill in dark mode. */}
                          <LabelList dataKey="amount" position="right" formatter={(v) => formatCrore(v)} fill={chart.textMuted} fontSize={11} />
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  )}
                </div>

                <div className="card card-pad">
                  <h3 style={{ fontSize: 15, marginBottom: 12 }}>Top {isPos ? 'merchants' : 'ATMs'}</h3>
                  {active.top_points.length === 0 ? (
                    <div className="empty-state" style={{ padding: 20 }}>No {pointLabel.toLowerCase()} identifiers recorded.</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>{isPos ? 'Terminal / MID' : 'ATM ID'}</th>
                            <th>{isPos ? 'Merchant' : 'Location'}</th>
                            <th style={{ textAlign: 'right' }}>Txns</th>
                            <th style={{ textAlign: 'right' }}>Accts</th>
                            <th style={{ textAlign: 'right' }}>Amount</th>
                          </tr>
                        </thead>
                        <tbody>
                          {active.top_points.map((p, i) => (
                            <tr key={`${p.terminal || p.location || i}`}>
                              <td style={{ fontFamily: 'var(--font-mono)' }}>{p.terminal || '—'}</td>
                              <td><span title={p.location || ''} style={{ display: 'inline-block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{p.location || '—'}</span></td>
                              <td style={{ textAlign: 'right' }}>{formatNumber(p.txn_count)}</td>
                              <td style={{ textAlign: 'right' }}>{formatNumber(p.account_count)}</td>
                              <td style={{ textAlign: 'right' }}>{formatINR(p.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </div>

              {/* Transaction table — filtered to flagged instances when a flag card is active. */}
              <div className="card">
                <div className="cash-exit-table-head">
                  <h3 style={{ fontSize: 15 }}>
                    {activeFlag
                      ? <>Flagged {channel} transactions · <span style={{ color: 'var(--risk-high)' }}>{(active.flags.find((f) => f.key === activeFlag) || {}).label}</span></>
                      : `${channel} transactions`}
                    <span style={{ color: 'var(--text-muted)', fontWeight: 400, marginLeft: 8 }}>({formatNumber(rows.length)})</span>
                  </h3>
                  {activeFlag && (
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => setActiveFlag(null)}>✕ Clear filter</button>
                  )}
                </div>
                {rows.length === 0 ? (
                  <div className="empty-state" style={{ padding: 24 }}>No transactions to show.</div>
                ) : (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Date</th>
                          <th>Account</th>
                          <th style={{ textAlign: 'right' }}>Amount</th>
                          <th style={{ textAlign: 'right' }}>Disputed</th>
                          <th>{isPos ? 'Terminal / MID' : 'ATM ID'}</th>
                          <th>{isPos ? 'Merchant' : 'Location'}</th>
                          <th>City</th>
                          {whyById && <th>Why flagged</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((t) => (
                          <tr key={t.id}>
                            <td style={{ whiteSpace: 'nowrap' }}>{t.date ? formatDateTimeUTC(t.date) : '—'}{t.same_day ? <span title="Withdrawn the same day it was received" style={{ marginLeft: 4 }}>⚡</span> : null}</td>
                            <td style={{ fontFamily: 'var(--font-mono)' }}>{t.account}</td>
                            <td style={{ textAlign: 'right' }}>{formatINR(t.amount)}</td>
                            <td style={{ textAlign: 'right' }}>{formatINR(t.disputed)}</td>
                            <td style={{ fontFamily: 'var(--font-mono)' }}>{t.atm_id || '—'}</td>
                            <td><span title={t.location || ''} style={{ display: 'inline-block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>{t.location || '—'}</span></td>
                            <td>{t.city || '—'}</td>
                            {whyById && <td className="why-flag">{whyById.get(t.id) || '—'}</td>}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <div className="cash-exit-table-foot">
                  <Link to={`/transactions?payment_mode=${channel}${reportId ? `&reportId=${reportId}` : ''}`}>
                    ▸ View all {channel} transactions in Transactions
                  </Link>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─── Clickable behavioural flag card (Feature 4/5) ───────────────────────────

/**
 * A flag card doubles as a filter: clicking it filters the transaction table to
 * the flagged instances. Colour + ⚑ icon + count + label (never colour alone);
 * a 0-count card is shown but not clickable.
 */
function FlagCard({ flag, active, onToggle }) {
  const has = flag.count > 0;
  const color = has ? 'var(--risk-high)' : 'var(--text-muted)';
  return (
    <button
      type="button"
      className={`stat-card flag-card${active ? ' active' : ''}`}
      style={{ borderLeftColor: color }}
      onClick={has ? onToggle : undefined}
      disabled={!has}
      aria-pressed={active}
      title={has ? `${FLAG_TIPS[flag.key] || ''} Click to filter the table to these ${flag.count} instances.` : `No ${flag.label.toLowerCase()} detected. ${FLAG_TIPS[flag.key] || ''}`}
    >
      <div className="stat-head">
        <span className="stat-title">{has ? '⚑ ' : ''}{flag.label}</span>
        {has && <span className="stat-icon" aria-hidden="true">▸</span>}
      </div>
      <div className="stat-value" style={{ color }}>{formatNumber(flag.count)}</div>
      <div className="stat-footer"><span>{has ? (active ? 'filtering table — click to clear' : 'click to filter table') : 'none detected'}</span></div>
    </button>
  );
}
