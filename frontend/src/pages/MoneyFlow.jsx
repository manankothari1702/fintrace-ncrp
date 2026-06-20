/**
 * Money Flow page.
 *
 * Renders the analyzer's account-to-account money-flow graph (analysis_json.
 * money_flow_network): the heaviest sender→receiver edges, the collector
 * ("aggregator") accounts that pull from many senders, and any circular flows
 * where money routes back to the same account.
 *
 * All data comes from the report's analysis snapshot (one getReport call) — no
 * dedicated endpoint needed.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import StatCard from '../components/StatCard.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { SkeletonStats, SkeletonTable } from '../components/Skeleton.jsx';
import { formatINR, formatCrore, formatNumber } from '../utils/format.js';
import { getReport, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

export default function MoneyFlow() {
  const reportId = useActiveReportId();

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

    getReport(reportId)
      .then((r) => { if (!cancelled) setReport(r); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [reportId]);

  const net = report?.analysis_json?.money_flow_network;
  const edges = net?.top_edges || [];
  const aggregators = net?.aggregators || [];
  // Direct self-loops (A→A, OTHER-kind benef=victim) — money_flow_network.circular_flows.
  const circular = net?.circular_flows || [];
  // Real multi-hop cycles (A→B→…→A) from the shared cycle detector. Already computed
  // and stored at analysis_json.circular_flows (the same source the PDF/Excel use) —
  // reused here, NOT recomputed. Shape: { path[], length, amount, txns, banks[] }.
  // The array is capped at 10; circular_cycle_count carries the TRUE total so the
  // card and caption don't under-report. Legacy snapshots fall back to the length.
  const cycles = report?.analysis_json?.circular_flows || [];
  const cycleCount = report?.analysis_json?.circular_cycle_count ?? cycles.length;

  // TRUE totals of the full computed sets (the tables below stay capped at 10).
  // Fall back to the displayed array length for legacy snapshots analysed before
  // these count fields existed, so an old report degrades to its prior behaviour
  // rather than rendering a blank card.
  const edgeCount = net?.edge_count ?? edges.length;
  const collectorCount = net?.collector_count ?? aggregators.length;
  const circularCount = net?.circular_count ?? circular.length;

  const totals = useMemo(() => ({
    edgeAmount: edges.reduce((s, e) => s + (e.amount || 0), 0),
    topCollector: aggregators[0],
  }), [edges, aggregators]);

  if (loading) {
    return (
      <div className="page">
        <header className="page-header"><h1>Money Flow</h1><p className="subtitle">Building the network…</p></header>
        <SkeletonStats count={4} />
        <SkeletonTable rows={8} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Money Flow</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load the money-flow network"
          message={error.code === 'NO_REPORT'
            ? 'No report is selected. Upload a file or pick one from Previous Reports.'
            : friendlyErrorMessage(error)}
        />
        <div style={{ marginTop: 16 }}><Link className="btn btn-primary" to="/upload">← Go to Upload</Link></div>
      </div>
    );
  }

  if (!net || (edges.length === 0 && aggregators.length === 0 && circular.length === 0)) {
    return (
      <div className="page">
        <header className="page-header"><h1>Money Flow</h1></header>
        <div className="card card-pad"><div className="empty-state">No account-to-account flow graph for this report.</div></div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Money Flow Network</h1>
        <p className="subtitle">Account-to-account transfers, collector accounts, and circular flows</p>
      </header>

      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard title="Transfer Edges" value={formatNumber(edgeCount)} subtitle="distinct sender→receiver routes" icon="🔗" color="var(--brand)" />
        <StatCard title="Collector Accounts" value={formatNumber(collectorCount)} subtitle="high fan-in (≥2 senders)" icon="🕸️" color="var(--accent-orange)" />
        <StatCard title="Self-Loops" value={formatNumber(circularCount)} subtitle="direct A→A round-trips" icon="🔁" color="var(--accent-orange)" />
        <StatCard title="Multi-Hop Cycles" value={formatNumber(cycleCount)} subtitle="money routed back through a loop" icon="🔄" color="var(--danger)" />
      </div>

      {/* Top sender → receiver edges */}
      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, marginBottom: 4 }}>Top Sender → Receiver Edges</h3>
        <p className="subtitle" style={{ marginBottom: 4 }}>
          Ranked by gross throughput. <strong style={{ color: 'var(--text)' }}>Gross</strong> is the total moved on the edge (commingled);
          {' '}<strong style={{ color: 'var(--text)' }}>Disputed</strong> is the fraud-traced portion — they can differ by orders of magnitude.
        </p>
        <TopCaption shown={edges.length} total={edgeCount} noun="edges, by gross amount" />
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Source A/c</th>
                <th>Destination A/c</th>
                <th>Bank</th>
                <th>Layers</th>
                <th style={{ textAlign: 'right' }}>Txns</th>
                <th style={{ textAlign: 'right' }}>Gross Amount</th>
                <th style={{ textAlign: 'right' }}>Disputed</th>
              </tr>
            </thead>
            <tbody>
              {edges.length === 0 ? (
                <tr><td colSpan={7}><div className="empty-state">No transfer edges detected.</div></td></tr>
              ) : edges.map((e, i) => (
                <tr key={`${e.source}-${e.destination}-${i}`}>
                  <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>{e.source}</td>
                  <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>→ {e.destination}</td>
                  <td>{e.banks || '—'}</td>
                  <td>{e.layers || '—'}</td>
                  <td style={{ textAlign: 'right' }}>{formatNumber(e.txn_count)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatINR(e.amount)}</td>
                  <td style={{ textAlign: 'right', color: 'var(--text-muted)' }}>{formatINR(e.disputed)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Aggregator / collector accounts */}
      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, marginBottom: 4 }}>Aggregator / Collector Accounts</h3>
        <p className="subtitle" style={{ marginBottom: 4 }}>
          Accounts with ≥2 distinct senders funnelling in (high fan-in) — classic pooling points.
        </p>
        <TopCaption shown={aggregators.length} total={collectorCount} noun="collectors, by fan-in" />
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Account No.</th>
                <th>Bank</th>
                <th style={{ textAlign: 'right' }}>Senders (in)</th>
                <th style={{ textAlign: 'right' }}>Recipients (out)</th>
                <th style={{ textAlign: 'right' }}>Total In</th>
                <th style={{ textAlign: 'right' }}>Total Out</th>
              </tr>
            </thead>
            <tbody>
              {aggregators.length === 0 ? (
                <tr><td colSpan={6}><div className="empty-state">No collector accounts detected.</div></td></tr>
              ) : aggregators.map((a) => (
                <tr key={a.account_no}>
                  <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>{a.account_no}</td>
                  <td>{a.bank || '—'}</td>
                  <td style={{ textAlign: 'right', fontWeight: 700, color: a.in_degree >= 3 ? 'var(--danger)' : 'inherit' }}>{formatNumber(a.in_degree)}</td>
                  <td style={{ textAlign: 'right' }}>{formatNumber(a.out_degree)}</td>
                  <td style={{ textAlign: 'right' }}>{formatINR(a.total_in)}</td>
                  <td style={{ textAlign: 'right' }}>{formatINR(a.total_out)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Multi-hop circular money trails (A→B→…→A) — the real laundering-loop
          signal, from the shared cycle detector (analysis_json.circular_flows).
          Shown above self-loops because a genuine loop is the stronger signal. */}
      {cycles.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, marginBottom: 4 }}>Circular Money Trails (Multi-Hop)</h3>
          <p className="subtitle" style={{ marginBottom: 4 }}>
            Money that returns to an account it already passed through (A→B→…→A) — a strong layering signal.
            Amount is the loop&apos;s thinnest leg (the most that could actually have circulated).
          </p>
          <TopCaption shown={cycles.length} total={cycleCount} noun="cycles, by amount" />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Cycle (account loop)</th>
                  <th style={{ textAlign: 'right' }}>Length</th>
                  <th style={{ textAlign: 'right' }}>Txns</th>
                  <th style={{ textAlign: 'right' }}>Loop Amount</th>
                </tr>
              </thead>
              <tbody>
                {cycles.map((c, i) => (
                  <tr key={`${(c.path || []).join('-')}-${i}`}>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>
                      {(c.path || []).join(' → ')}{(c.path && c.path.length) ? ` → ${c.path[0]}` : ''}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatNumber(c.length)}</td>
                    <td style={{ textAlign: 'right' }}>{formatNumber(c.txns)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatINR(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Direct self-loops (A→A) — distinct from the multi-hop cycles above. These
          are single-account round-trips / self-referential legs, a weaker signal. */}
      {circular.length > 0 && (
        <div className="card card-pad">
          <h3 style={{ fontSize: 15, marginBottom: 4 }}>Self-Loops / Wallet Round-Trips</h3>
          <p className="subtitle" style={{ marginBottom: 4 }}>
            Direct single-account round-trips (sender = receiver) — NOT multi-hop cycles (see above).
          </p>
          <TopCaption shown={circular.length} total={circularCount} noun="self-loops, by amount" />
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Account No.</th>
                  <th style={{ textAlign: 'right' }}>Txns</th>
                  <th style={{ textAlign: 'right' }}>Amount</th>
                </tr>
              </thead>
              <tbody>
                {circular.map((c) => (
                  <tr key={c.account_no}>
                    <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>{c.account_no}</td>
                    <td style={{ textAlign: 'right' }}>{formatNumber(c.txn_count)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatINR(c.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Presentational helpers ──────────────────────────────────────────────────

/**
 * "Showing top N of M …" caption under a table whose display is capped at 10 while
 * the summary card reports the true total M. Renders nothing when the table already
 * shows everything (M ≤ N), so small reports stay uncluttered.
 */
function TopCaption({ shown, total, noun }) {
  if (!(total > shown)) return null;
  return (
    <p className="subtitle" style={{ marginTop: 0, marginBottom: 12, fontSize: 12 }}>
      Showing top {formatNumber(shown)} of {formatNumber(total)} {noun}.
    </p>
  );
}
