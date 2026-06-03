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
import { formatINR, formatPercent, formatHours, getMuleRiskColor } from '../utils/format.js';
import { getMules, getTransactions, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

// ─── Score progress bar ──────────────────────────────────────────────────────

function MuleScoreBar({ score }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{ width: 100, height: 8, background: 'var(--border)', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ width: `${score}%`, height: '100%', background: getMuleRiskColor(score), borderRadius: 4 }} />
      </div>
      <span style={{ fontWeight: 700, color: getMuleRiskColor(score), minWidth: 26, textAlign: 'right' }}>{score}</span>
    </div>
  );
}

export default function Mules() {
  const reportId = useActiveReportId();

  const [mules, setMules] = useState([]);
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

    getMules(reportId)
      .then((rows) => { if (!cancelled) setMules(rows); })
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
    { accessorKey: 'bank_name', header: 'Bank', cell: ({ getValue }) => getValue() || '—' },
    { accessorKey: 'layer_no', header: 'Layer', cell: ({ getValue }) => `L${getValue()}` },
    { accessorKey: 'mule_score', header: 'Mule Score', cell: ({ getValue }) => <MuleScoreBar score={getValue()} /> },
    { accessorKey: 'pass_through_ratio', header: 'Pass-Through', cell: ({ getValue }) => formatPercent(getValue()) },
    { accessorKey: 'total_received', header: 'Received', cell: ({ getValue }) => formatINR(getValue()) },
    { accessorKey: 'total_forwarded', header: 'Forwarded', cell: ({ getValue }) => formatINR(getValue()) },
    { accessorKey: 'forward_speed_hours', header: 'Fwd Speed', cell: ({ getValue }) => formatHours(getValue()) },
    { accessorKey: 'risk_label', header: 'Risk', cell: ({ row }) => <Badge variant="risk" value={row.original.mule_score} /> },
    { accessorKey: 'appears_in_cases', header: 'Cases' },
  ];

  // Lazily load this account's transactions when the row is expanded.
  const renderExpanded = (m) => (
    <AccountHistory reportId={reportId} account={m.account_no} />
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
        <p className="subtitle">{mules.length} flagged accounts scored 0–100 across six laundering signals.</p>
      </header>

      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard title="High Risk" value={riskCounts.HIGH} subtitle="score 71–100" icon="🔴" color="var(--danger)" />
        <StatCard title="Medium Risk" value={riskCounts.MEDIUM} subtitle="score 41–70" icon="🟠" color="var(--accent-orange)" />
        <StatCard title="Low Risk" value={riskCounts.LOW} subtitle="score 0–40" icon="🟢" color="var(--accent)" />
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
