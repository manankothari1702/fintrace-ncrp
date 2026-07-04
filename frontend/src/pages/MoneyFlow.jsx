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
import { ResponsiveContainer, Sankey, Tooltip } from 'recharts';

import StatCard from '../components/StatCard.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { AccountLink } from '../components/EntityLink.jsx';
import { SkeletonStats, SkeletonTable } from '../components/Skeleton.jsx';
import { formatINR, formatCrore, formatNumber } from '../utils/format.js';
import { getReport, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';
import { useChartTheme } from '../utils/useChartTheme.js';

// ─── Layer-flow Sankey (Phase 1) ─────────────────────────────────────────────

/**
 * Map the backend's id-based layer_flows ({ nodes, links }) to the index-based
 * shape recharts <Sankey> wants, picking the active measure (disputed | gross)
 * as each link's width. Links with a zero value in the active measure are
 * dropped (e.g. on-hold has no disputed-traced portion in the source data), and
 * any node left unreferenced after that is removed so recharts never lays out a
 * dangling node. Both gross and disputed are kept on every link for the tooltip.
 */
function buildSankeyData(lf, mode) {
  if (!lf || !Array.isArray(lf.nodes) || !Array.isArray(lf.links)) return null;
  const links = lf.links
    .map((l) => ({ ...l, value: mode === 'disputed' ? l.disputed : l.gross }))
    .filter((l) => l.value > 0);
  if (!links.length) return null;
  const used = new Set();
  links.forEach((l) => { used.add(l.source); used.add(l.target); });
  const nodes = lf.nodes.filter((n) => used.has(n.id));
  if (nodes.length < 2) return null;
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  return {
    nodes: nodes.map((n) => ({ name: n.label, kind: n.kind, layer: n.layer, id: n.id })),
    links: links.map((l) => ({
      source: idx.get(l.source), target: idx.get(l.target),
      value: l.value, gross: l.gross, disputed: l.disputed,
    })),
  };
}

// Node colour grammar: cash-out = danger, on-hold = orange, victim inflow =
// accent (recovery green), laundering layers = brand navy.
function nodeColor(node, theme) {
  if (node.id === 'sink:cashout') return theme.danger;
  if (node.id === 'sink:hold') return theme.accentOrange;
  if (node.kind === 'origin') return theme.accent;
  return theme.brand;
}

/**
 * Custom Sankey node: a theme-filled bar plus a two-line label (name + throughput
 * ₹). Colours are passed as EXPLICIT theme props and the label carries a card-bg
 * halo (paint-order stroke) — the same fix the donut/bar labels use — so it stays
 * legible over any band in BOTH light and dark mode. Sink labels sit to the left
 * of their bar (they're right-most); every other label sits to the right.
 */
function LayerNode({ x, y, width, height, payload, theme }) {
  if (x == null || payload == null) return null;
  const isSink = payload.kind === 'sink';
  const color = nodeColor(payload, theme);
  const labelX = isSink ? x - 9 : x + width + 9;
  const anchor = isSink ? 'end' : 'start';
  // Deep layers carry near-zero flow, so their nodes bunch up at the right and
  // adjacent labels collide on one baseline. Stagger the label block up/down by
  // layer parity so consecutive layers never share a line; origin/sinks (always
  // well separated at the ends) stay centred on the node.
  const stagger = payload.kind === 'layer' ? (payload.layer % 2 === 0 ? 17 : -17) : 0;
  const cy = y + height / 2 + stagger;
  const halo = {
    paintOrder: 'stroke', stroke: theme.cardBg, strokeWidth: 3.5, strokeLinejoin: 'round',
  };
  return (
    <g>
      <rect x={x} y={y} width={width} height={Math.max(height, 1)} fill={color} rx={2} />
      <text x={labelX} y={cy - 8} textAnchor={anchor} dominantBaseline="central"
        style={{ fontSize: 12, fontWeight: 700, fill: theme.text, ...halo }}>
        {payload.name}
      </text>
      <text x={labelX} y={cy + 9} textAnchor={anchor} dominantBaseline="central"
        style={{ fontSize: 11, fontWeight: 600, fill: theme.textMuted, ...halo }}>
        {formatINR(payload.value)}
      </text>
    </g>
  );
}

/**
 * Custom Sankey link: a curved band whose strokeWidth IS recharts' value-scaled
 * linkWidth. Coloured by destination — cash-out red, on-hold orange, forward navy.
 * Per-link amounts live in the hover tooltip (not always-on labels) to keep the
 * diagram uncluttered.
 */
function LayerLink({
  sourceX, sourceY, targetX, targetY, sourceControlX, targetControlX, linkWidth, payload, theme,
}) {
  if (sourceX == null) return null;
  const tgt = (payload && payload.target) || {};
  const color = tgt.id === 'sink:cashout' ? theme.danger
    : tgt.id === 'sink:hold' ? theme.accentOrange
      : theme.brand;
  return (
    <path
      d={`M${sourceX},${sourceY} C${sourceControlX},${sourceY} ${targetControlX},${targetY} ${targetX},${targetY}`}
      fill="none"
      stroke={color}
      strokeWidth={Math.max(1, linkWidth)}
      strokeOpacity={theme.theme === 'dark' ? 0.42 : 0.3}
    />
  );
}

/** Tooltip: a link shows source→target with BOTH gross and disputed; a node shows
 *  its throughput in the active measure. */
function FlowTooltip({ active, payload, theme, mode }) {
  if (!active || !payload || !payload.length) return null;
  // recharts Sankey wraps the datum twice: payload[0].payload is its own geometry
  // props, and OUR node/link object sits at .payload.payload. For a link, source
  // and target there are resolved node OBJECTS (not the original indices).
  const data = payload[0] && payload[0].payload && payload[0].payload.payload;
  if (!data) return null;
  const box = {
    background: theme.cardBg, border: `1px solid ${theme.border}`, borderRadius: 8,
    padding: '8px 10px', fontSize: 12, color: theme.text, boxShadow: '0 4px 14px rgba(0,0,0,0.18)',
  };
  const isLink = data.source && typeof data.source === 'object'
    && data.target && typeof data.target === 'object';
  if (isLink) {
    return (
      <div style={box}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{data.source.name} → {data.target.name}</div>
        <div>Gross: <strong>{formatINR(data.gross)}</strong></div>
        <div style={{ color: theme.textMuted }}>Disputed: {formatINR(data.disputed)}</div>
      </div>
    );
  }
  return (
    <div style={box}>
      <div style={{ fontWeight: 700, marginBottom: 2 }}>{data.name}</div>
      <div style={{ color: theme.textMuted }}>
        {mode === 'disputed' ? 'Disputed' : 'Gross'} throughput: {formatINR(data.value)}
      </div>
    </div>
  );
}

/**
 * The layer-aggregated money-flow Sankey: victim inflow → L1 → L2 → … with
 * per-layer cash-out / on-hold terminal sinks, link width = amount. Defaults to
 * the DISPUTED (fraud-traced) measure with a toggle to GROSS (commingled), which
 * can dwarf disputed at deep layers once clean money is pooled in. It is a
 * directed-acyclic view: circular trails / self-loops can't appear and live in
 * the tables below.
 */
function LayerFlowSankey({ layerFlows, theme }) {
  const [mode, setMode] = useState('disputed');
  const data = useMemo(() => buildSankeyData(layerFlows, mode), [layerFlows, mode]);
  if (!data) return null;

  const layerCount = data.nodes.filter((n) => n.kind === 'layer').length;
  // Taller for longer trails so thin deep-layer bands stay separable.
  const height = Math.min(720, Math.max(380, layerCount * 52 + 120));

  return (
    <div className="card card-pad" style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h3 style={{ fontSize: 15, marginBottom: 4 }}>Layer-by-Layer Money Flow</h3>
          <p className="subtitle" style={{ marginBottom: 0 }}>
            Width = amount moving from each layer to the next, with cash-out / on-hold sinks. Hover a band for its gross &amp; disputed totals.
          </p>
        </div>
        <div className="seg" role="group" aria-label="Flow measure" style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 8, overflow: 'hidden', flexShrink: 0 }}>
          {[['disputed', 'Disputed'], ['gross', 'Gross']].map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              aria-pressed={mode === key}
              style={{
                border: 'none', cursor: 'pointer', padding: '6px 14px', fontSize: 13, fontWeight: 600,
                background: mode === key ? 'var(--brand)' : 'transparent',
                color: mode === key ? 'var(--text-on-solid)' : 'var(--text-muted)',
              }}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <ResponsiveContainer width="100%" height={height}>
          <Sankey
            data={data}
            nodeWidth={13}
            nodePadding={Math.max(14, Math.min(28, Math.round(height / (layerCount + 2))))}
            linkCurvature={0.5}
            iterations={64}
            margin={{ top: 16, right: 132, bottom: 16, left: 16 }}
            node={<LayerNode theme={theme} />}
            link={<LayerLink theme={theme} />}
          >
            <Tooltip content={<FlowTooltip theme={theme} mode={mode} />} />
          </Sankey>
        </ResponsiveContainer>
      </div>

      <p className="subtitle" style={{ marginTop: 10, marginBottom: 0, fontSize: 12, lineHeight: 1.5 }}>
        Layer-aggregated, directed-acyclic view.{' '}
        <strong style={{ color: 'var(--text)' }}>Disputed</strong> traces the fraud money; <strong style={{ color: 'var(--text)' }}>Gross</strong> is everything that moved on each leg (commingled), so it can balloon at deep layers.
        Circular trails and self-loops route money backwards and cannot be drawn in this flow — see the tables below.
      </p>
    </div>
  );
}

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

  const theme = useChartTheme();

  const net = report?.analysis_json?.money_flow_network;
  const edges = net?.top_edges || [];
  const aggregators = net?.aggregators || [];
  // Bounded layer→layer + disposition graph for the Sankey (Phase 1). Absent on
  // legacy snapshots analysed before this field existed → the chart is skipped.
  const layerFlows = net?.layer_flows;
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

      {/* Layer-aggregated money-flow Sankey (Phase 1). Sits above the detail
          tables: the at-a-glance trail first, the line-item evidence below. */}
      {layerFlows && <LayerFlowSankey layerFlows={layerFlows} theme={theme} />}

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
                  <td style={{ fontFamily: 'var(--font-mono, monospace)' }}><AccountLink account={e.source} /></td>
                  <td style={{ fontFamily: 'var(--font-mono, monospace)' }}>→ <AccountLink account={e.destination} /></td>
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
                  <td style={{ fontFamily: 'var(--font-mono, monospace)' }}><AccountLink account={a.account_no} /></td>
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
                      {(c.path || []).map((acct, pi) => (
                        <span key={`${acct}-${pi}`}>
                          {pi > 0 && ' → '}
                          <AccountLink account={acct} />
                        </span>
                      ))}
                      {(c.path && c.path.length) ? <> → <AccountLink account={c.path[0]} /></> : ''}
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
                    <td style={{ fontFamily: 'var(--font-mono, monospace)' }}><AccountLink account={c.account_no} /></td>
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
