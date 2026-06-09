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
        <p className="subtitle">
          {layers.length} layers · {formatCrore(totalTrailAmount)} moved through the trail
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
          return (
            <div className="card" key={l.layer_no}>
              <button
                type="button"
                onClick={() => toggle(l.layer_no)}
                style={{
                  width: '100%', display: 'flex', alignItems: 'center', gap: 16,
                  padding: '16px 20px', background: 'transparent', border: 'none', textAlign: 'left',
                }}
                aria-expanded={isOpen}
              >
                <Badge color="var(--brand)">Layer {l.layer_no}</Badge>
                {l.txn_count != null && <span style={{ color: 'var(--text-muted)' }}>{formatNumber(l.txn_count)} txns</span>}
                <span style={{ color: 'var(--text-muted)' }}>{formatNumber(l.account_count)} accounts</span>
                <span style={{ fontWeight: 700 }}>{formatINR(l.total_amount)}</span>
                <span style={{ color: 'var(--text-muted)' }}>disputed {formatINR(l.disputed_amount)}</span>
                <span className="spacer" style={{ flex: 1 }} />
                <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>
                  Avg forward: {l.avg_forward_time_hours == null ? '— (terminal)' : formatHours(l.avg_forward_time_hours)}
                </span>
                <span style={{ fontSize: 14, color: 'var(--brand)' }}>{isOpen ? '▾' : '▸'}</span>
              </button>

              {isOpen && (
                <div style={{ padding: '0 20px 18px', borderTop: '1px solid var(--border)' }}>
                  <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', margin: '14px 0' }}>
                    {l.txn_count != null && <Metric label="Transactions" value={formatNumber(l.txn_count)} />}
                    <Metric label="Accounts" value={formatNumber(l.account_count)} />
                    <Metric label="Banks" value={formatNumber(l.bank_count ?? l.unique_banks)} />
                    <Metric label="Total Amount" value={formatINR(l.total_amount)} />
                    <Metric label="Disputed" value={formatINR(l.disputed_amount)} />
                    <Metric label="Cashouts" value={formatNumber(l.cashout_count)} />
                    <Metric
                      label="Fan-out ratio"
                      value={l.fan_out_ratio == null ? '— (terminal)' : `${l.fan_out_ratio}×`}
                    />
                    <Metric
                      label="Avg forward time"
                      value={l.avg_forward_time_hours == null ? '— (terminal)' : formatHours(l.avg_forward_time_hours)}
                    />
                  </div>

                  {Array.isArray(l.top_banks) && l.top_banks.length > 0 && (
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}>
                      <span style={{ fontSize: 12, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Top banks:</span>
                      {l.top_banks.map((b) => (
                        <span key={b} className="badge" style={{ color: 'var(--brand)', borderColor: 'color-mix(in srgb, var(--brand) 40%, transparent)', background: 'color-mix(in srgb, var(--brand) 10%, transparent)' }}>{b}</span>
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

function Metric({ label, value }) {
  return (
    <div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 700 }}>{value}</div>
    </div>
  );
}

function FlowStep({ layer, isLast }) {
  return (
    <>
      <div
        style={{
          flex: '0 0 auto', textAlign: 'center', padding: '12px 16px',
          border: '1px solid var(--border)', borderRadius: 'var(--radius)',
          background: 'var(--brand-light)', minWidth: 120,
        }}
      >
        <div style={{ fontWeight: 800, color: 'var(--brand)' }}>Layer {layer.layer_no}</div>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{formatCrore(layer.total_amount)}</div>
        <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{formatNumber(layer.account_count)} acct · {formatNumber(layer.cashout_count)} cashout</div>
      </div>
      {!isLast && (
        <span style={{ flex: '0 0 auto', color: 'var(--accent-orange)', fontSize: 22, fontWeight: 700, padding: '0 2px' }} aria-hidden="true">→</span>
      )}
    </>
  );
}
