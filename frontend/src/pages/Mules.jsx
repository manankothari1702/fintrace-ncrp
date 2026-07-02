/**
 * Mule Account Detection page.
 *
 * Risk-summary header, a Risk/Layer/Bank filter bar, and a sortable table of
 * scored beneficiary accounts. Mule score renders as a coloured progress bar;
 * clicking a row lazily loads that account's transaction history.
 *
 * Loads getMules(id); each expanded row fetches getTransactions filtered to the
 * account number.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import DataTable from '../components/DataTable.jsx';
import Badge from '../components/Badge.jsx';
import StatCard from '../components/StatCard.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { SkeletonStats, SkeletonTable } from '../components/Skeleton.jsx';
import { formatINR, formatNumber, formatHours, getMuleRiskColor } from '../utils/format.js';
import { getMules, getAggregators, getTransactions, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

const AGG_TIP = 'Aggregator — an account that received money from many distinct senders '
  + '(a collection point in the mule ring). Amber at 3–4 senders, red at 5 or more.';

// Fan-in counts are whole senders, but the MEDIAN of an even-sized set can be a
// half-integer (e.g. 3.5). Show that decimal instead of rounding it to 4, so the
// strip matches the analysis snapshot exactly.
function fmtFanIn(v) {
  return Number.isInteger(v) ? formatNumber(v) : v.toFixed(1);
}

// ─── Score progress bar ──────────────────────────────────────────────────────

function MuleScoreBar({ score }) {
  // Scores are uncapped (a textbook mule trips every signal and exceeds 100),
  // so the bar fill is clamped to its track while the numeric label shows the
  // true score.
  const fill = Math.min(100, Math.max(0, score));
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 100, height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${fill}%`, height: '100%', background: getMuleRiskColor(score), borderRadius: 4 }} />
      </div>
      <span style={{ fontWeight: 700, color: getMuleRiskColor(score), minWidth: 26, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

// ─── Gross-conduit transparency (audit F2) ───────────────────────────────────

// A freeze-relevant account (HIGH/MEDIUM) that MOVES a large GROSS sum but whose
// TRACED (disputed) inflow is tiny is most likely a settlement / aggregator
// account, not a dedicated mule — the score is driven by laundering-pattern
// signals on gross flow. Surface a warning so it is not blind-frozen. Thresholds
// are display-only; they never touch the score or risk label.
const LOW_TRACED_MAX = 10000;      // traced (disputed) inflow below ₹10k = "low traced"
const GROSS_CONDUIT_MIN = 100000;  // gross flow at/above ₹1L = a material conduit

function isGrossConduit(m) {
  const traced = m.disputed_received;
  // Legacy snapshots predate disputed_received — don't guess, show no badge.
  if (traced == null) return false;
  if (m.risk_label !== 'HIGH' && m.risk_label !== 'MEDIUM') return false;
  const grossFlow = Math.max(
    m.total_received || 0, m.onward_forwarded || 0,
    m.total_cashout || 0, m.total_forwarded || 0,
  );
  return traced < LOW_TRACED_MAX && grossFlow >= GROSS_CONDUIT_MIN;
}

// Feature 3 — inline aggregator badge (colour + ⚑ icon + sender count), so an
// officer judges severity from the number rather than an opaque label.
function AggregatorBadge({ severity, senders }) {
  if (!severity) return null;
  return (
    <span
      className={`aggregator-flag${severity === 'danger' ? ' danger' : ''}`}
      title={`Collected from ${formatNumber(senders)} distinct senders — a collection point in the mule ring. ${AGG_TIP}`}
    >
      ⚑ Aggregator ·{formatNumber(senders)}
    </span>
  );
}

// Risk badge + (when applicable) the gross-conduit and aggregator flags, stacked.
function RiskCell({ m }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
      <Badge variant="risk" value={m.mule_score} />
      {isGrossConduit(m) && (
        <span
          className="conduit-flag"
          title="Large gross flow but small traced (disputed) inflow — likely a settlement/aggregator account. Verify traced exposure before freezing."
        >
          ⚠ GROSS CONDUIT · LOW TRACED
        </span>
      )}
      <AggregatorBadge severity={m.aggregator_severity} senders={m.distinct_senders} />
    </div>
  );
}

export default function Mules() {
  const reportId = useActiveReportId();

  const [mules, setMules] = useState([]);
  const [agg, setAgg] = useState({ accounts: [], summary: { count: 0, max_fan_in: 0, median_fan_in: null, total_held: 0 } });
  const [tab, setTab] = useState('all'); // 'all' | 'aggregators'
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [riskFilter, setRiskFilter] = useState('');
  const [layerFilter, setLayerFilter] = useState('');
  const [bankFilter, setBankFilter] = useState('');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    Promise.all([getMules(reportId), getAggregators(reportId)])
      .then(([rows, aggData]) => {
        if (cancelled) return;
        setMules(rows);
        if (aggData && Array.isArray(aggData.accounts)) setAgg(aggData);
      })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [reportId]);

  const banks = useMemo(() => [...new Set(mules.map((m) => m.bank_name).filter(Boolean))].sort(), [mules]);
  const layers = useMemo(() => [...new Set(mules.map((m) => m.layer_no).filter((l) => l != null))].sort((a, b) => a - b), [mules]);

  const riskCounts = useMemo(() => {
    const c = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const m of mules) c[m.risk_label] = (c[m.risk_label] || 0) + 1;
    return c;
  }, [mules]);

  const filtered = useMemo(() => mules.filter((m) => (
    (!riskFilter || m.risk_label === riskFilter)
    && (layerFilter === '' || String(m.layer_no) === layerFilter)
    && (!bankFilter || m.bank_name === bankFilter)
  )), [mules, riskFilter, layerFilter, bankFilter]);

  const columns = [
    { accessorKey: 'account_no', header: 'Account No.' },
    {
      accessorKey: 'bank_name',
      header: 'Bank',
      // Truncate long bank names ("Punjab National Bank (incl. …)") to one line
      // with the full name on hover, so rows keep a uniform height (B4 density).
      cell: ({ getValue }) => {
        const v = getValue();
        return v
          ? (
            <span
              title={v}
              style={{ display: 'inline-block', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
            >
              {v}
            </span>
          )
          : '—';
      },
    },
    { accessorKey: 'layer_no', header: 'Layer', cell: ({ getValue }) => `L${getValue()}` },
    { accessorKey: 'mule_score', header: 'Mule Score', cell: ({ getValue }) => <MuleScoreBar score={getValue()} /> },
    // F2 — gross inflow and TRACED (disputed) inflow side by side, so an officer
    // sees real fraud exposure, not just gross throughput, before freezing.
    { accessorKey: 'total_received', header: 'Received (gross)', cell: ({ getValue }) => formatINR(getValue()) },
    {
      accessorKey: 'disputed_received',
      header: 'Traced Fraud In',
      cell: ({ getValue }) => formatINR(getValue()),
    },
    // F1 — the explicit onward leg replaces the old "Pass-Through %", whose
    // gross-over-traced ratio produced impossible values (e.g. 3908%). Falls back
    // to (total_forwarded − cashed-out) on legacy snapshots lacking the field.
    {
      id: 'onward_forwarded',
      header: 'Forwarded',
      accessorFn: (m) => (m.onward_forwarded != null
        ? m.onward_forwarded
        : (m.total_forwarded != null && m.total_cashout != null ? m.total_forwarded - m.total_cashout : null)),
      cell: ({ getValue }) => formatINR(getValue()),
    },
    { accessorKey: 'total_cashout', header: 'Cashed Out', cell: ({ getValue }) => formatINR(getValue()) },
    { accessorKey: 'channels', header: 'Channels', cell: ({ getValue }) => (getValue() || []).join(', ') || '—' },
    { accessorKey: 'forward_speed_hours', header: 'Fwd Speed', cell: ({ getValue }) => formatHours(getValue()) },
    { accessorKey: 'risk_label', header: 'Risk', cell: ({ row }) => <RiskCell m={row.original} /> },
    { accessorKey: 'appears_in_cases', header: 'Cases (incl. prior complaints)' },
  ];

  // Lazily load this account's transactions when the row is expanded; show the
  // scoring rationale (suspicion reasons) above the history.
  const renderExpanded = (m) => (
    <div>
      {Array.isArray(m.suspicion_reasons) && m.suspicion_reasons.length > 0 && (
        <div style={{ padding: '14px 18px 0' }}>
          <h4 style={{ fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
            Why this account was flagged{m.same_day_in_out ? ' · same-day in/out' : ''}
          </h4>
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 6, margin: 0 }}>
            {m.suspicion_reasons.map((reason, i) => (
              <li key={i} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13 }}>
                <span style={{ color: 'var(--risk-high)' }} aria-hidden="true">▸</span>
                <span>{reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <AccountHistory reportId={reportId} account={m.account_no} />
    </div>
  );

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Mule Account Detection</h1>
          <p className="subtitle">Scoring accounts…</p>
        </header>
        <SkeletonStats count={3} />
        <SkeletonTable rows={8} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Mule Account Detection</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load mule accounts"
          message={error.code === 'NO_REPORT'
            ? 'No report is selected. Upload a file or pick one from Previous Reports.'
            : friendlyErrorMessage(error)}
        />
        <div style={{ marginTop: 16 }}><Link className="btn btn-primary" to="/upload">← Go to Upload</Link></div>
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>Mule Account Detection</h1>
        <p className="subtitle">
          {formatNumber(mules.length)} accounts scored across 11 laundering signals · {formatNumber(riskCounts.HIGH)} high-risk (expand a row for the reasons).
        </p>
      </header>

      {/* Feature 3 — segmented control: all scored accounts vs the aggregator
          (collection-point) subset. Not a new route; a tab within this page. */}
      <div className="seg-tabs" role="tablist" aria-label="Mule accounts view">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={`seg-tab${tab === 'all' ? ' active' : ''}`}
          onClick={() => setTab('all')}
        >
          All Accounts
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'aggregators'}
          className={`seg-tab${tab === 'aggregators' ? ' active' : ''}`}
          onClick={() => setTab('aggregators')}
        >
          Aggregators{agg.summary.count > 0 ? ` (${formatNumber(agg.summary.count)})` : ''}
        </button>
      </div>

      {tab === 'aggregators' ? (
        <AggregatorsView agg={agg} reportId={reportId} />
      ) : (
      <>
      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard title="High Risk" value={riskCounts.HIGH} subtitle="score ≥ 70" icon="🔴" color="var(--risk-high)" />
        <StatCard title="Medium Risk" value={riskCounts.MEDIUM} subtitle="score 40–69" icon="🟠" color="var(--risk-medium)" />
        <StatCard title="Low Risk" value={riskCounts.LOW} subtitle="score < 40" icon="🟢" color="var(--risk-low)" />
      </div>

      {/* Gross-vs-traced transparency (audit F2/F5). Risk is a laundering-PATTERN
          signal computed on gross flow; it is NOT a measure of traced fraud. The
          two are surfaced separately so a freeze decision is informed. */}
      <div
        className="card card-pad"
        style={{ marginBottom: 16, borderLeft: '4px solid var(--accent-orange)', fontSize: 13, lineHeight: 1.55 }}
      >
        <strong style={{ color: 'var(--text)' }}>Risk reflects laundering-pattern signals on gross flow — verify traced exposure before freezing.</strong>{' '}
        <span style={{ color: 'var(--text-muted)' }}>
          <strong style={{ color: 'var(--text)' }}>Received (gross)</strong>, <strong style={{ color: 'var(--text)' }}>Forwarded</strong> and <strong style={{ color: 'var(--text)' }}>Cashed Out</strong> are full transaction legs (cashed-out is the gross ATM/POS withdrawal). <strong style={{ color: 'var(--text)' }}>Traced Fraud In</strong> is the disputed amount actually traced to the account, which follows only the fraud money — so an account can legitimately show large gross flow with a small traced figure, and cashed-out can exceed traced received.{' '}
          <span style={{ color: 'var(--risk-medium)', fontWeight: 700 }}>⚠ GROSS CONDUIT · LOW TRACED</span> flags likely settlement/aggregator accounts (large gross, &lt; {formatINR(LOW_TRACED_MAX)} traced) — confirm real exposure first.
        </span>
      </div>

      <DataTable
        columns={columns}
        data={filtered}
        renderExpanded={renderExpanded}
        emptyMessage={mules.length === 0
          ? 'No mule accounts detected. Every beneficiary account in this trail has a low pass-through ratio and stayed below the scoring threshold.'
          : 'No accounts match the current filters. Try a different risk level, layer, or bank — or clear the filters above.'}
        exportFilename="mule-accounts.csv"
        toolbar={(
          <>
            <select className="select" value={riskFilter} onChange={(e) => setRiskFilter(e.target.value)}>
              <option value="">All risk levels</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium</option>
              <option value="LOW">Low</option>
            </select>
            <select className="select" value={layerFilter} onChange={(e) => setLayerFilter(e.target.value)}>
              <option value="">All layers</option>
              {layers.map((l) => <option key={l} value={String(l)}>Layer {l}</option>)}
            </select>
            <select className="select" value={bankFilter} onChange={(e) => setBankFilter(e.target.value)}>
              <option value="">All banks</option>
              {banks.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </>
        )}
      />
      </>
      )}
    </div>
  );
}

// ─── Aggregators tab (Feature 3) ─────────────────────────────────────────────

/**
 * The aggregator subset: a summary strip (count · max fan-in · median · total
 * held) over a table sorted by distinct-sender count. Each row expands to the
 * same lazy transaction history used elsewhere, so the inbound counterparties —
 * the evidence of aggregation — are one click away with no new mental model.
 */
function AggregatorsView({ agg, reportId }) {
  const rows = agg.accounts || [];
  const s = agg.summary || {};

  const columns = [
    { accessorKey: 'account_no', header: 'Account No.' },
    {
      accessorKey: 'bank',
      header: 'Bank',
      cell: ({ getValue }) => {
        const v = getValue();
        return v
          ? (
            <span
              title={v}
              style={{ display: 'inline-block', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
            >
              {v}
            </span>
          ) : '—';
      },
    },
    {
      accessorKey: 'distinct_senders',
      header: 'Distinct senders',
      cell: ({ row }) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700, color: row.original.severity === 'danger' ? 'var(--risk-high)' : 'var(--risk-medium)' }}>
            {formatNumber(row.original.distinct_senders)}
          </span>
          <AggregatorBadge severity={row.original.severity} senders={row.original.distinct_senders} />
        </span>
      ),
    },
    { accessorKey: 'total_received', header: 'Total received', cell: ({ getValue }) => formatINR(getValue()) },
    { accessorKey: 'held', header: 'Held', cell: ({ getValue }) => (getValue() == null ? '—' : formatINR(getValue())) },
    { accessorKey: 'layer_no', header: 'Layer', cell: ({ getValue }) => (getValue() == null ? '—' : `L${getValue()}`) },
  ];

  return (
    <>
      <div className="agg-summary-strip" role="group" aria-label="Aggregator summary">
        <SummaryStat label="Aggregators" value={formatNumber(s.count || 0)} info={AGG_TIP} />
        <SummaryStat label="Max fan-in" value={formatNumber(s.max_fan_in || 0)} suffix=" senders" />
        <SummaryStat label="Median fan-in" value={s.median_fan_in == null ? '—' : fmtFanIn(s.median_fan_in)} suffix={s.median_fan_in == null ? '' : ' senders'} />
        <SummaryStat label="Total held" value={formatINR(s.total_held || 0)} />
      </div>

      <DataTable
        columns={columns}
        data={rows}
        renderExpanded={(a) => <AccountHistory reportId={reportId} account={a.account_no} />}
        emptyMessage="No aggregator accounts in this trail — no account received money from 3 or more distinct senders."
        exportFilename="aggregators.csv"
      />
    </>
  );
}

// Compact metric for the aggregator summary strip (no card chrome).
function SummaryStat({ label, value, suffix = '', info }) {
  return (
    <div className="agg-summary-item">
      <div className="agg-summary-label">
        {label}
        {info && <span className="info-dot" title={info} tabIndex={0} role="img" aria-label={info}>i</span>}
      </div>
      <div className="agg-summary-value">{value}<span className="agg-summary-suffix">{suffix}</span></div>
    </div>
  );
}

// ─── Per-account transaction history (lazy-loaded on row expand) ─────────────

function AccountHistory({ reportId, account }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    if (!reportId) { setLoading(false); return undefined; }
    setLoading(true);
    setError(null);
    getTransactions(reportId, { search: account, limit: 100 })
      .then((r) => { if (!cancelled) setRows(r.data || []); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [reportId, account]);

  return (
    <div style={{ padding: '14px 18px' }}>
      <h4 style={{ fontSize: 13, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>
        Transaction history — {account}
      </h4>
      {loading ? (
        <LoadingSpinner block label="Loading transactions…" />
      ) : error ? (
        <ErrorAlert error={error} title="Could not load history" message={friendlyErrorMessage(error)} />
      ) : rows.length === 0 ? (
        <div className="empty-state" style={{ padding: 16 }}>No transactions found for this account.</div>
      ) : (
        <table className="data-table">
          <thead>
            <tr><th>Date</th><th>Amount</th><th>Mode</th><th>Beneficiary</th><th>UTR</th></tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.transaction_date).toLocaleString('en-IN')}</td>
                <td>{formatINR(t.transaction_amount)}</td>
                <td>{t.payment_mode}</td>
                <td>{t.beneficiary_name}</td>
                <td>{t.utr_no}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
