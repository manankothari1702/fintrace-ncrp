/**
 * Bank Statement — Transactions page (REAL data).
 *
 * A simple paginated ledger of one statement's parsed transactions, straight
 * from GET /api/bank-statement/statements/:id/transactions. Reuses the shared
 * DataTable (client-side sort/pagination/CSV within the fetched window) with
 * a statement selector in the toolbar; server-side paging kicks in only past
 * the 500-row window.
 *
 * Counterparty columns (Phase 6 m3) AUGMENT the raw narration, never replace
 * it: the Description column always shows the source string the fields were
 * extracted from, and low-confidence extractions carry a ≈ marker + tooltip
 * so partial fields are verified against it.
 *
 * Dates are rendered with UTC components: statement dates are the source
 * file's wall-clock relabelled as UTC (same model as NCRP transaction dates),
 * so reading them in the local zone would shift the calendar day.
 */
import { useEffect, useMemo, useState } from 'react';

import DataTable from '../../../components/DataTable.jsx';
import { formatINR } from '../../../utils/format.js';
import ComingSoon from '../components/ComingSoon.jsx';
import { listStatements, getStatementTransactions } from '../utils/api.js';

/** Rows fetched per server page (backend cap). */
const SERVER_PAGE_SIZE = 500;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2 Jul 2026" from an ISO string, read in UTC (see module comment). */
function formatDateUTC(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Mask an account number for display (last 4 kept). */
function maskAccount(acct) {
  const s = acct ? String(acct) : '';
  return s.length <= 4 ? s : `…${s.slice(-4)}`;
}

/**
 * Subtle low-confidence marker: extraction was partial/ambiguous, so the
 * investigator should verify the field against the raw narration (always
 * visible in the Description column right alongside).
 */
function LowConfidenceMark() {
  return (
    <span
      className="bs-cp-low"
      title="Partial extraction — verify against narration"
      aria-label="Partial extraction — verify against narration"
    >
      ≈
    </span>
  );
}

const COLUMNS = [
  {
    id: 'txn_date',
    accessorKey: 'txn_date',
    header: 'Date',
    cell: (info) => <span className="tabular">{formatDateUTC(info.getValue())}</span>,
  },
  {
    id: 'narration',
    accessorKey: 'narration',
    header: 'Description',
    cell: (info) => <span title={info.getValue() || ''}>{info.getValue() || '—'}</span>,
  },
  {
    id: 'counterparty_name',
    accessorKey: 'counterparty_name',
    header: 'Counterparty',
    cell: (info) => {
      const row = info.row.original;
      const name = info.getValue();
      if (!name) return <span>—</span>;
      return (
        <span title={`Extracted from: ${row.narration || ''}`}>
          {row.extraction_confidence === 'low' && <LowConfidenceMark />}
          {name}
        </span>
      );
    },
  },
  {
    id: 'txn_channel',
    accessorKey: 'txn_channel',
    header: 'Channel',
    cell: (info) => (info.getValue()
      ? <span className="bs-chip-channel">{info.getValue()}</span>
      : <span>—</span>),
  },
  {
    id: 'counterparty_handle',
    // Sort/filter/export on whichever identifier the row carries.
    accessorFn: (row) => row.counterparty_vpa || row.counterparty_ifsc || row.counterparty_phone || '',
    header: 'VPA / IFSC / Phone',
    cell: (info) => {
      const row = info.row.original;
      const value = row.counterparty_vpa || row.counterparty_ifsc || row.counterparty_phone;
      if (!value) return <span>—</span>;
      const kind = row.counterparty_vpa ? 'UPI handle (VPA)'
        : row.counterparty_ifsc ? 'IFSC' : 'Phone';
      return (
        <span className="tabular" title={`${kind} — extracted from: ${row.narration || ''}`}>
          {row.extraction_confidence === 'low' && <LowConfidenceMark />}
          {value}
        </span>
      );
    },
  },
  {
    id: 'debit_amount',
    accessorKey: 'debit_amount',
    header: 'Debit',
    cell: (info) => (
      <span className="tabular">
        {info.getValue() === null ? '—' : formatINR(info.getValue(), { paise: true })}
      </span>
    ),
  },
  {
    id: 'credit_amount',
    accessorKey: 'credit_amount',
    header: 'Credit',
    cell: (info) => (
      <span className="tabular">
        {info.getValue() === null ? '—' : formatINR(info.getValue(), { paise: true })}
      </span>
    ),
  },
  {
    id: 'balance',
    accessorKey: 'balance',
    header: 'Balance',
    cell: (info) => {
      const t = info.row.original.balance_type;
      return (
        <span className="tabular">
          {info.getValue() === null ? '—' : formatINR(info.getValue(), { paise: true })}
          {t ? ` ${t}` : ''}
        </span>
      );
    },
  },
];

export default function Transactions() {
  const [statements, setStatements] = useState(null); // null = loading
  const [loadError, setLoadError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [serverPage, setServerPage] = useState(1);
  const [result, setResult] = useState(null);
  const [txnsLoading, setTxnsLoading] = useState(false);

  // Load the statement list once; default to the newest statement.
  useEffect(() => {
    let cancelled = false;
    listStatements()
      .then((rows) => {
        if (cancelled) return;
        setStatements(rows);
        if (rows.length > 0) setSelectedId(rows[0].id);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || 'Could not load statements.');
      });
    return () => { cancelled = true; };
  }, []);

  // (Re)fetch the transaction window when the selection or server page moves.
  useEffect(() => {
    if (!selectedId) return undefined;
    let cancelled = false;
    setTxnsLoading(true);
    getStatementTransactions(selectedId, { page: serverPage, limit: SERVER_PAGE_SIZE })
      .then((res) => { if (!cancelled) setResult(res); })
      .catch((err) => { if (!cancelled) setLoadError(err.message || 'Could not load transactions.'); })
      .finally(() => { if (!cancelled) setTxnsLoading(false); });
    return () => { cancelled = true; };
  }, [selectedId, serverPage]);

  const selected = useMemo(
    () => (statements || []).find((s) => s.id === selectedId) || null,
    [statements, selectedId],
  );

  if (loadError) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Transactions</h1>
        </header>
        <div className="card card-pad empty-state" role="alert">{loadError}</div>
      </div>
    );
  }

  if (statements !== null && statements.length === 0) {
    return (
      <ComingSoon
        title="Transactions"
        icon="📋"
        blurb="No statements ingested yet — upload a bank statement first, then its parsed ledger appears here."
      />
    );
  }

  const totalPages = result ? result.total_pages : 0;

  const toolbar = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
      <label htmlFor="bs-stmt-select" className="subtitle" style={{ margin: 0 }}>Statement</label>
      <select
        id="bs-stmt-select"
        value={selectedId ?? ''}
        onChange={(e) => { setSelectedId(Number(e.target.value)); setServerPage(1); }}
      >
        {(statements || []).map((s) => (
          <option key={s.id} value={s.id}>
            {(s.bank_name || 'Statement')} · a/c {maskAccount(s.account_number)} · {s.txn_count} txns ({String(s.source_format || '').toUpperCase()})
          </option>
        ))}
      </select>
      {totalPages > 1 && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <button type="button" className="btn btn-sm" disabled={serverPage <= 1}
            onClick={() => setServerPage((p) => p - 1)}>‹ Prev</button>
          <span className="subtitle" style={{ margin: 0 }}>window {serverPage}/{totalPages}</span>
          <button type="button" className="btn btn-sm" disabled={serverPage >= totalPages}
            onClick={() => setServerPage((p) => p + 1)}>Next ›</button>
        </span>
      )}
    </div>
  );

  return (
    <div className="page">
      <header className="page-header">
        <h1>Transactions</h1>
        <p className="subtitle">
          {selected
            ? `${selected.bank_name || 'Statement'} — a/c ${maskAccount(selected.account_number)}` +
              (selected.account_holder ? ` (${selected.account_holder})` : '') +
              ` · ${result ? result.total : selected.txn_count} transactions`
            : 'Parsed ledger of the selected statement.'}
        </p>
      </header>

      <DataTable
        columns={COLUMNS}
        data={result ? result.data : []}
        loading={statements === null || txnsLoading}
        emptyMessage="No transactions in this statement."
        exportFilename="bank-statement-transactions.csv"
        toolbar={toolbar}
      />
    </div>
  );
}
