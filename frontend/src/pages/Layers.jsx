/**
 * Layers page.
 *
 * Walks the money trail layer by layer. A horizontal step diagram (L0 → L1 →
 * …) sits up top; below it each layer is an expandable card showing its
 * aggregates, the accounts that sit in it (with mule score), and the average
 * time funds dwelt before being forwarded to the next layer.
 *
 * Loads getLayers(id) and getMules(id) in parallel; mules are grouped by layer
 * for the per-layer account tables.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

import Badge from '../components/Badge.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { AccountLink } from '../components/EntityLink.jsx';
import { SkeletonLine, SkeletonCards } from '../components/Skeleton.jsx';
import { formatCrore, formatINR, formatNumber, formatHours, getMuleRiskColor } from '../utils/format.js';
import { getLayers, getMules, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';
import { useChartTheme } from '../utils/useChartTheme.js';

// Clarity copy surfaced by the correctness audit. The per-layer "total amount"
// is GROSS THROUGHPUT — the sum of every transfer moving through the layer
// (commingled account flow), which at deep layers balloons far past the traced
// fraud (e.g. a single ₹18.4Cr pass-through whose disputed portion is ₹10k).
// These tooltips keep an officer from reading that figure as "fraud here".
const GROSS_TIP =
  'Gross throughput — the total of every transfer amount moving through this layer '
  + '(commingled account flow). This is NOT the fraud amount at this layer; see the '
  + 'Disputed figure for the traced fraud portion.';
const FWD_TIP =
  'Average time from an account first receiving funds in this layer to the earliest '
  + 'onward hop into the next layer that shares the case acknowledgement number. Large '
  + 'values are real measured gaps (e.g. funds held before moving on), not errors.';
const FANOUT_TIP =
  'Fan-out — for every account at this layer, how many accounts the money spread into '
  + 'at the next hop. A high value means the funds suddenly scattered, a classic '
  + 'layering/muling signal and a good place to prioritise freezes. Flagged HIGH when '
  + 'the money spread into 2× or more accounts than the previous hop.';

export default function Layers() {
  const reportId = useActiveReportId();

  const [layers, setLayers] = useState([]);
  const [mules, setMules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set([0])); // first layer open

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    Promise.all([getLayers(reportId), getMules(reportId)])
      .then(([ls, ms]) => { if (!cancelled) { setLayers(ls); setMules(ms); } })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [reportId]);

  // Group mule accounts by layer for the per-layer mini-tables.
  const mulesByLayer = useMemo(() => {
    const map = new Map();
    for (const m of mules) {
      const key = m.layer_no ?? -1;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }
    for (const list of map.values()) list.sort((a, b) => b.mule_score - a.mule_score);
    return map;
  }, [mules]);

  const totalTrailAmount = useMemo(
    () => layers.reduce((s, l) => s + (l.total_amount || 0), 0),
    [layers],
  );

  // Feature 2 — the highest-fan-out flagged layer, surfaced in the page header so
  // the scatter point is unmissable regardless of scroll position.
  const peakFanOut = useMemo(() => {
    let peak = null;
    for (const l of layers) {
      if (l.fan_out_high && (peak === null || (l.fan_out_ratio || 0) > (peak.fan_out_ratio || 0))) {
        peak = l;
      }
    }
    return peak;
  }, [layers]);

  const toggle = (layerNo) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(layerNo)) next.delete(layerNo); else next.add(layerNo);
      return next;
    });
  };

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Layer Analysis</h1>
          <p className="subtitle">Tracing the layers…</p>
        </header>
        <div className="card card-pad" style={{ marginBottom: 20 }}>
          <SkeletonLine height={84} />
        </div>
        <SkeletonCards count={4} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Layer Analysis</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load layers"
          message={error.code === 'NO_REPORT'
            ? 'No report is selected. Upload a file or pick one from Previous Reports.'
            : friendlyErrorMessage(error)}
        />
        <div style={{ marginTop: 16 }}><Link className="btn btn-primary" to="/upload">← Go to Upload</Link></div>
      </div>
    );
  }

  if (layers.length === 0) {
    return (
      <div className="page">
        <header className="page-header"><h1>Layer Analysis</h1></header>
        <div className="card card-pad"><div className="empty-state">No layer data for this report.</div></div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Layer Analysis</h1>
        <p className="subtitle" style={{ display: 'inline-flex', alignItems: 'center', flexWrap: 'wrap' }}>
          <strong style={{ color: 'var(--text)' }}>{layers.length}</strong>&nbsp;layers
          &nbsp;·&nbsp;
          <strong style={{ color: 'var(--text)' }}>{formatCrore(totalTrailAmount)}</strong>&nbsp;gross throughput
          <InfoDot title={GROSS_TIP} />
          {peakFanOut && (
            <>
              &nbsp;·&nbsp;
              <span className="fanout-flag" title={FANOUT_TIP}>
                ⚑ peak fan-out {peakFanOut.fan_out_ratio}× at L{peakFanOut.layer_no}
              </span>
            </>
          )}
        </p>
      </header>

      {/* Feature 2 — optional summary chart (accounts & banks by layer), collapsed
          by default so it never pushes the layer breakdown below the fold. */}
      <LayerSummaryChart layers={layers} />

      {/* Horizontal flow diagram */}
      <div className="card card-pad" style={{ marginBottom: 20, overflowX: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, minWidth: 'min-content' }}>
          {layers.map((l, i) => (
            <FlowStep
              key={l.layer_no}
              layer={l}
              isLast={i === layers.length - 1}
            />
          ))}
        </div>
      </div>

      {/* Expandable per-layer cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {layers.map((l, i) => {
          const isOpen = expanded.has(l.layer_no);
          const accounts = mulesByLayer.get(l.layer_no) || [];
          const isTerminal = i === layers.length - 1; // deepest layer = end of the trail
          return (
            <div className="card layer-card" key={l.layer_no}>
              <button
                type="button"
                className="layer-toggle"
                onClick={() => toggle(l.layer_no)}
                aria-expanded={isOpen}
              >
                <span className="badge badge-brand">Layer {l.layer_no}</span>
                {isTerminal && (
                  <Badge color="var(--text-muted)" dot={false}>Terminal</Badge>
                )}
                {l.txn_count != null && <span style={{ color: 'var(--text-muted)' }}>{formatNumber(l.txn_count)} txns</span>}
                <span style={{ color: 'var(--text-muted)' }}>{formatNumber(l.account_count)} accounts</span>
                {l.fan_out_high && <FanOutFlag ratio={l.fan_out_ratio} showRatio />}
                <span style={{ fontWeight: 800, fontSize: 16 }} title={GROSS_TIP}>{formatINR(l.total_amount)}</span>
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>disputed {formatINR(l.disputed_amount)}</span>
                <span className="spacer" style={{ flex: 1 }} />
                <span style={{ color: 'var(--text-muted)', fontSize: 13, display: 'inline-flex', alignItems: 'center' }}>
                  Avg forward: {l.avg_forward_time_hours == null ? '—' : formatHours(l.avg_forward_time_hours)}
                  <InfoDot title={FWD_TIP} />
                </span>
                <span className="layer-chevron" data-open={isOpen} aria-hidden="true">▸</span>
              </button>

              {isOpen && (
                <div style={{ padding: '0 20px 18px', borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '14px 0' }}>
                    {l.txn_count != null && <Metric label="Transactions" value={formatNumber(l.txn_count)} />}
                    <Metric label="Accounts" value={formatNumber(l.account_count)} />
                    <Metric label="Banks" value={formatNumber(l.bank_count ?? l.unique_banks)} />
                    <Metric label="Gross throughput" info={GROSS_TIP} value={formatINR(l.total_amount)} />
                    <Metric label="Disputed (fraud)" value={formatINR(l.disputed_amount)} />
                    <Metric label="Cashouts" value={formatNumber(l.cashout_count)} />
                    <Metric
                      label="Fan-out ratio"
                      info={FANOUT_TIP}
                      value={l.fan_out_ratio == null ? '—' : (
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                          {l.fan_out_ratio}×
                          {l.fan_out_high && <FanOutFlag />}
                        </span>
                      )}
                    />
                    <Metric
                      label="Avg forward time"
                      info={FWD_TIP}
                      value={l.avg_forward_time_hours == null ? '—' : formatHours(l.avg_forward_time_hours)}
                    />
                  </div>

                  {((l.banks_ranked && l.banks_ranked.length > 0)
                    || (Array.isArray(l.top_banks) && l.top_banks.length > 0)) && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Top banks:</span>
                      <BankChips banks={l.banks_ranked} legacy={l.top_banks} />
                    </div>
                  )}

                  <h4 style={{ fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
                    Accounts in this layer
                  </h4>
                  {accounts.length === 0 ? (
                    <div className="empty-state" style={{ padding: 20 }}>No flagged accounts recorded at this layer.</div>
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Account No.</th>
                            <th>Bank</th>
                            <th style={{ textAlign: 'right' }}>Received</th>
                            <th style={{ textAlign: 'right' }}>Mule Score</th>
                            <th>Risk</th>
                          </tr>
                        </thead>
                        <tbody>
                          {accounts.map((a) => (
                            <tr key={a.account_no}>
                              <td style={{ fontFamily: 'var(--font-mono)' }}><AccountLink account={a.account_no} /></td>
                              <td>{a.bank_name || '—'}</td>
                              <td style={{ textAlign: 'right' }}>{formatINR(a.total_received)}</td>
                              <td style={{ textAlign: 'right', fontWeight: 700, color: getMuleRiskColor(a.mule_score) }}>
                                {a.mule_score}
                              </td>
                              <td><Badge variant="risk" value={a.mule_score} /></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {i < layers.length - 1 && (
                    <div style={{ marginTop: 14, color: 'var(--text-muted)', fontSize: 13 }}>
                      ↓ forwards to <strong style={{ color: 'var(--text)' }}>Layer {layers[i + 1].layer_no}</strong>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Presentational helpers ──────────────────────────────────────────────────

function Metric({ label, value, info }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'inline-flex', alignItems: 'center' }}>
        {label}{info && <InfoDot title={info} />}
      </div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

/**
 * Inline info affordance — a bordered "i" with a native tooltip (same pattern
 * the rest of the app uses for at-a-glance clarifications). Keyboard-focusable
 * so the tooltip text is reachable, and exposed to assistive tech via aria-label.
 */
function InfoDot({ title }) {
  return (
    <span className="info-dot" title={title} tabIndex={0} role="img" aria-label={title}>i</span>
  );
}

/**
 * Feature 2 — HIGH fan-out flag. Colour + icon + word, so it survives a
 * grayscale printout / screenshot (the doc's badge discipline). `showRatio`
 * appends the ratio when the flag stands alone (e.g. in the collapsed header,
 * where the ratio isn't otherwise shown).
 */
function FanOutFlag({ ratio, showRatio = false }) {
  return (
    <span className="fanout-flag" title={FANOUT_TIP}>
      ⚑ HIGH{showRatio && ratio != null ? ` ${ratio}×` : ''}
    </span>
  );
}

/**
 * Feature 2 — top banks as up to three "Bank ·n" chips plus a "+N" chip that
 * opens a popover with the full ranked list, so a bank-heavy layer never widens
 * the card unboundedly. Prefers the structured `banks_ranked`; falls back to
 * parsing the legacy "Bank (n)" strings on pre-Feature-2 analysis snapshots.
 */
function BankChips({ banks, legacy }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  const list = useMemo(() => {
    if (Array.isArray(banks) && banks.length) return banks;
    if (Array.isArray(legacy)) {
      return legacy.map((s) => {
        const m = /^(.*)\s+\((\d+)\)\s*$/.exec(String(s));
        return m ? { bank: m[1], count: Number(m[2]) } : { bank: String(s), count: null };
      });
    }
    return [];
  }, [banks, legacy]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!list.length) return null;
  const shown = list.slice(0, 3);
  const rest = list.length - shown.length;

  return (
    <span className="bank-chip-group" ref={ref}>
      {shown.map((b) => (
        <span key={b.bank} className="badge badge-brand">
          {b.bank}{b.count != null ? ` ·${b.count}` : ''}
        </span>
      ))}
      {rest > 0 && (
        <button
          type="button"
          className="bank-more-chip"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          aria-label={`Show all ${list.length} banks`}
        >
          +{rest}
        </button>
      )}
      {open && (
        <div className="bank-more-popover" role="dialog" aria-label="All banks at this layer">
          <div className="bank-more-popover-head">All banks ({list.length})</div>
          <ul className="bank-more-list">
            {list.map((b) => (
              <li key={b.bank}>
                <span className="bank-more-name">{b.bank}</span>
                {b.count != null && <span className="bank-more-count">{b.count}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </span>
  );
}

/**
 * Feature 2 — optional summary chart: accounts & banks per layer. Collapsed by
 * default (a Chart/Table toggle) so on a small laptop it never pushes the layer
 * breakdown below the fold; the breakdown table stays the primary view.
 */
function LayerSummaryChart({ layers }) {
  const [open, setOpen] = useState(false);
  const chart = useChartTheme();
  const data = useMemo(
    () => layers.map((l) => ({
      name: `L${l.layer_no}`,
      accounts: l.account_count || 0,
      banks: l.bank_count ?? l.unique_banks ?? 0,
    })),
    [layers],
  );
  if (!layers.length) return null;

  return (
    <div className="card" style={{ marginBottom: 20 }}>
      <button
        type="button"
        className="layer-toggle"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="badge badge-brand">Chart</span>
        <span style={{ fontWeight: 700 }}>Accounts &amp; banks by layer</span>
        <span className="spacer" style={{ flex: 1 }} />
        <span className="layer-chevron" data-open={open} aria-hidden="true">▸</span>
      </button>
      {open && (
        <div style={{ padding: '4px 20px 18px', borderTop: '1px solid var(--border)' }}>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={data} margin={{ top: 16, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke={chart.border} strokeDasharray="3 3" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12, fill: chart.textMuted }}
                axisLine={{ stroke: chart.border }}
                tickLine={{ stroke: chart.border }}
              />
              <YAxis
                allowDecimals={false}
                tick={{ fontSize: 12, fill: chart.textMuted }}
                width={44}
                axisLine={{ stroke: chart.border }}
                tickLine={{ stroke: chart.border }}
              />
              <Tooltip
                contentStyle={{
                  background: chart.cardBg, border: `1px solid ${chart.border}`,
                  borderRadius: 8, color: chart.text,
                }}
                labelStyle={{ color: chart.text }}
                itemStyle={{ color: chart.text }}
                cursor={{ fill: chart.border, opacity: 0.35 }}
              />
              <Legend wrapperStyle={{ fontSize: 12, color: chart.textMuted }} />
              <Bar dataKey="accounts" name="Accounts" fill={chart.brand} radius={[3, 3, 0, 0]} />
              <Bar dataKey="banks" name="Banks" fill={chart.accent} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

function FlowStep({ layer, isLast }) {
  const hasCashout = (layer.cashout_count || 0) > 0;
  return (
    <>
      <div
        className={`layer-flow-step${hasCashout ? ' has-cashout' : ''}`}
        title={hasCashout
          ? `Layer ${layer.layer_no} · ${formatNumber(layer.cashout_count)} cash-out${layer.cashout_count === 1 ? '' : 's'} (money leaving the chain)`
          : undefined}
      >
        <div className="layer-flow-layer-no">Layer {layer.layer_no}</div>
        <div style={{ fontSize: 13, fontWeight: 700 }} title={GROSS_TIP}>{formatCrore(layer.total_amount)}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          {formatNumber(layer.account_count)} acct ·{' '}
          <span className={hasCashout ? 'layer-flow-cashout' : undefined}>
            {formatNumber(layer.cashout_count)} cashout
          </span>
        </div>
      </div>
      {!isLast && (
        <span className="layer-flow-arrow" aria-hidden="true">→</span>
      )}
    </>
  );
}
