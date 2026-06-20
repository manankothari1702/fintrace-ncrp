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

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import Badge from '../components/Badge.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { SkeletonLine, SkeletonCards } from '../components/Skeleton.jsx';
import { formatCrore, formatINR, formatNumber, formatHours, getMuleRiskColor } from '../utils/format.js';
import { getLayers, getMules, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

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
        </p>
      </header>

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
                      value={l.fan_out_ratio == null ? '—' : `${l.fan_out_ratio}×`}
                    />
                    <Metric
                      label="Avg forward time"
                      info={FWD_TIP}
                      value={l.avg_forward_time_hours == null ? '—' : formatHours(l.avg_forward_time_hours)}
                    />
                  </div>

                  {Array.isArray(l.top_banks) && l.top_banks.length > 0 && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Top banks:</span>
                      {l.top_banks.map((b) => (
                        <span key={b} className="badge badge-brand">{b}</span>
                      ))}
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
                              <td>{a.account_no}</td>
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
          <span style={hasCashout ? { color: 'var(--danger)', fontWeight: 700 } : undefined}>
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
