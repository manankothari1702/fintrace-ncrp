/**
 * Bank Statement — Counterparty page (REAL analysis).
 *
 * The "who is this account transacting with" view for ONE statement, from
 * the cached single-statement analysis: the full counterparty distribution
 * (grouped on the strongest identifier — VPA > phone > IFSC+name > name),
 * top counterparties by amount and by frequency, and the confidence caveat
 * whenever the distribution rests partly on low-confidence extractions.
 *
 * Honesty rules carried through from the engine: low-confidence groups wear
 * the ≈ marker and are never merged into solid identities, and every row can
 * be expanded to its underlying transactions with the RAW narration — the
 * extracted fields augment the source text, never replace it.
 */
import { useEffect, useMemo, useState } from 'react';

import DataTable from '../../../components/DataTable.jsx';
import { formatINR } from '../../../utils/format.js';
import ComingSoon from '../components/ComingSoon.jsx';
import { listStatements, getStatementAnalysis, getStatementTransactions } from '../utils/api.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2 Jul 2026" in UTC (statement wall-clock; see Transactions page note). */
function formatDateUTC(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function maskAccount(acct) {
  const s = acct ? String(acct) : '';
  return s.length <= 4 ? s : `…${s.slice(-4)}`;
}

/** The identifier shown for a counterparty group (strongest available). */
function identifierOf(cp) {
  return cp.vpa || cp.ifsc || cp.phone || '—';
}

const KIND_LABELS = {
  vpa: 'VPA',
  phone: 'Phone',
  'ifsc+name': 'IFSC',
  ifsc: 'IFSC',
  name: 'Name only',
};

const COLUMNS = [
  {
    id: 'display_name',
    accessorKey: 'display_name',
    header: 'Counterparty',
    cell: (info) => {
      const cp = info.row.original;
      return (
        <span>
          {cp.confidence === 'low' && (
            <span
              className="bs-cp-low"
              title="Grouped from low-confidence extractions — verify against narration"
              aria-label="Grouped from low-confidence extractions — verify against narration"
            >
              ≈
            </span>
          )}
          {info.getValue() || '(unnamed)'}
          {cp.names && cp.names.length > 1 && (
            <span className="bs-cp-alt" title={`Also seen as: ${cp.names.slice(1).join(', ')}`}>
              {' '}+{cp.names.length - 1}
            </span>
          )}
        </span>
      );
    },
  },
  {
    id: 'id_kind',
    accessorKey: 'id_kind',
    header: 'Keyed on',
    cell: (info) => <span className="bs-chip-channel">{KIND_LABELS[info.getValue()] || info.getValue()}</span>,
  },
  {
    id: 'identifier',
    accessorFn: identifierOf,
    header: 'Identifier',
    cell: (info) => <span className="tabular">{info.getValue()}</span>,
  },
  {
    id: 'sent_total',
    accessorKey: 'sent_total',
    header: 'Sent to them',
    cell: (info) => <span className="tabular">{info.getValue() ? formatINR(info.getValue(), { paise: true }) : '—'}</span>,
  },
  {
    id: 'received_total',
    accessorKey: 'received_total',
    header: 'Received',
    cell: (info) => <span className="tabular">{info.getValue() ? formatINR(info.getValue(), { paise: true }) : '—'}</span>,
  },
  {
    id: 'net',
    accessorKey: 'net',
    header: 'Net',
    cell: (info) => {
      const v = info.getValue();
      return (
        <span className="tabular" style={{ color: v > 0 ? 'var(--success, #1a7f37)' : v < 0 ? 'var(--danger, #c0392b)' : undefined }}>
          {formatINR(v, { paise: true })}
        </span>
      );
    },
  },
  { id: 'txn_count', accessorKey: 'txn_count', header: 'Txns', cell: (info) => <span className="tabular">{info.getValue()}</span> },
  {
    id: 'first_seen',
    accessorKey: 'first_seen',
    header: 'First seen',
    cell: (info) => <span className="tabular">{formatDateUTC(info.getValue())}</span>,
  },
  {
    id: 'last_seen',
    accessorKey: 'last_seen',
    header: 'Last seen',
    cell: (info) => <span className="tabular">{formatDateUTC(info.getValue())}</span>,
  },
];

/** Compact ranked list used for the two top-5 cards. */
function TopList({ title, entries, metric }) {
  return (
    <div className="card card-pad bs-top-card">
      <h3 className="bs-top-title">{title}</h3>
      {entries.length === 0 ? (
        <p className="subtitle">No counterparties.</p>
      ) : (
        <ol className="bs-top-list">
          {entries.map((cp) => (
            <li key={cp.key}>
              <span className="bs-top-name" title={identifierOf(cp)}>
                {cp.confidence === 'low' && <span className="bs-cp-low" title="Low confidence">≈</span>}
                {cp.display_name || '(unnamed)'}
              </span>
              <span className="tabular bs-top-metric">
                {metric === 'volume' ? formatINR(cp.volume, { paise: true }) : `${cp.txn_count} txns`}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export default function Counterparty() {
  const [statements, setStatements] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [txnsById, setTxnsById] = useState(new Map());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listStatements()
      .then((rows) => {
        if (cancelled) return;
        setStatements(rows);
        if (rows.length > 0) setSelectedId(rows[0].id);
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load statements.'); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    setLoading(true);
    setAnalysis(null);
    Promise.all([
      getStatementAnalysis(selectedId),
      // Transaction window for the drill-down (raw narration per row).
      getStatementTransactions(selectedId, { page: 1, limit: 500 }),
    ])
      .then(([a, t]) => {
        if (cancelled) return;
        setAnalysis(a.analysis);
        setTxnsById(new Map(t.data.map((row) => [row.id, row])));
      })
      .catch((err) => { if (!cancelled) setError(err.message || 'Could not load the analysis.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const selected = useMemo(
    () => (statements || []).find((s) => s.id === selectedId) || null,
    [statements, selectedId],
  );
  const byKey = useMemo(
    () => new Map(((analysis && analysis.counterparties) || []).map((c) => [c.key, c])),
    [analysis],
  );

  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Counterparty</h1></header>
        <div className="card card-pad empty-state" role="alert">{error}</div>
      </div>
    );
  }

  if (statements !== null && statements.length === 0) {
    return (
      <ComingSoon
        title="Counterparty"
        icon="👥"
        blurb="No statements ingested yet — upload a bank statement first, then its counterparty distribution appears here."
      />
    );
  }

  const lowGroups = analysis ? analysis.low_confidence_counterparty_count : 0;
  const unattributed = analysis ? analysis.unattributed_count : 0;
  const topByAmount = analysis ? analysis.top_by_amount.map((k) => byKey.get(k)).filter(Boolean) : [];
  const topByFrequency = analysis ? analysis.top_by_frequency.map((k) => byKey.get(k)).filter(Boolean) : [];

  /** Drill-down: the counterparty's transactions with their raw narration. */
  const renderExpanded = (cp) => {
    const rows = (cp.txn_ids || []).map((id) => txnsById.get(id)).filter(Boolean);
    return (
      <div className="bs-cp-drill">
        {rows.length < cp.txn_count && (
          <p className="subtitle">
            Showing {rows.length} of {cp.txn_count} transactions (window limit).
          </p>
        )}
        <table className="bs-cp-drill-table">
          <thead>
            <tr><th>Date</th><th>Narration (raw)</th><th>Debit</th><th>Credit</th></tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id}>
                <td className="tabular">{formatDateUTC(t.txn_date)}</td>
                <td>{t.narration}</td>
                <td className="tabular">{t.debit_amount === null ? '—' : formatINR(t.debit_amount, { paise: true })}</td>
                <td className="tabular">{t.credit_amount === null ? '—' : formatINR(t.credit_amount, { paise: true })}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  };

  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <label htmlFor="bs-cp-stmt-select" className="subtitle" style={{ margin: 0 }}>Statement</label>
      <select
        id="bs-cp-stmt-select"
        value={selectedId ?? ''}
        onChange={(e) => setSelectedId(Number(e.target.value))}
      >
        {(statements || []).map((s) => (
          <option key={s.id} value={s.id}>
            {(s.bank_name || 'Statement')} · a/c {maskAccount(s.account_number)} · {s.txn_count} txns
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="page">
      <header className="page-header">
        <h1>Counterparty</h1>
        <p className="subtitle">
          {selected
            ? `Who a/c ${maskAccount(selected.account_number)} transacts with — ` +
              `${analysis ? analysis.counterparties.length : '…'} distinct counterparties in this statement`
            : 'Counterparty distribution of the selected statement.'}
        </p>
      </header>

      {(lowGroups > 0 || unattributed > 0) && (
        <div className="card card-pad bs-cp-caveat" role="note">
          ⚠️ The distribution includes {lowGroups} low-confidence counterparty group{lowGroups === 1 ? '' : 's'}
          {unattributed > 0 ? ` and ${unattributed} unattributable transaction${unattributed === 1 ? '' : 's'}` : ''} —
          rows marked ≈ are grouped from partial extractions. Verify them against the raw narration
          (expand a row) before relying on their totals.
        </div>
      )}

      <div className="bs-top-grid">
        <TopList title="Top by amount" entries={topByAmount} metric="volume" />
        <TopList title="Top by frequency" entries={topByFrequency} metric="txns" />
      </div>

      <DataTable
        columns={COLUMNS}
        data={analysis ? analysis.counterparties : []}
        loading={statements === null || loading}
        emptyMessage="No counterparties extracted from this statement."
        exportFilename="bank-statement-counterparties.csv"
        toolbar={toolbar}
        renderExpanded={renderExpanded}
      />
    </div>
  );
}
