/**
 * All Transactions page.
 *
 * Server-paginated listing (the only view large enough to need it) with a
 * collapsible filter panel and virtualized row rendering so a 50k-row page
 * stays at ~30 DOM rows. Cashout rows are tinted light red; same-day cashouts
 * carry a ⚡ marker.
 *
 * Server-driven: every filter/page change calls getTransactions(id, params)
 * (layers/banks sent comma-separated). The search box is debounced 300ms and
 * filter state is mirrored into the URL query so a refresh restores the view.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';

import LoadingSpinner from '../components/LoadingSpinner.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { formatINR, formatDateTime, formatNumber } from '../utils/format.js';
import { getTransactions, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

const PAGE_SIZES = [100, 250, 500];
const PAYMENT_MODES = ['ATM', 'UPI', 'IMPS', 'NEFT', 'RTGS', 'POS'];
const BANKS = ['HDFC Bank', 'ICICI Bank', 'SBI', 'Axis Bank', 'Kotak', 'Yes Bank'];
const CASH_EXIT_MODES = new Set(['ATM', 'POS']);

const EMPTY_FILTERS = {
  page: 1,
  limit: 100,
  layers: [],          // multi-select → sent as comma-separated `layer`
  banks: [],           // multi-select → sent as comma-separated `bank`
  payment_mode: '',
  date_from: '',
  date_to: '',
  min_amount: '',
  max_amount: '',
  search: '',
};

// Build the filter state from URL query params so filters survive a refresh.
function filtersFromParams(sp) {
  const csvNums = (v) => (v ? v.split(',').map(Number).filter(Number.isFinite) : []);
  const csv = (v) => (v ? v.split(',').filter(Boolean) : []);
  const limit = Number(sp.get('limit'));
  return {
    page: Math.max(1, parseInt(sp.get('page'), 10) || 1),
    limit: PAGE_SIZES.includes(limit) ? limit : 100,
    layers: csvNums(sp.get('layer')),
    banks: csv(sp.get('bank')),
    payment_mode: sp.get('payment_mode') || '',
    date_from: sp.get('date_from') || '',
    date_to: sp.get('date_to') || '',
    min_amount: sp.get('min_amount') || '',
    max_amount: sp.get('max_amount') || '',
    search: sp.get('search') || '',
  };
}

export default function Transactions() {
  const [searchParams, setSearchParams] = useSearchParams();
  const reportId = useActiveReportId();

  const [filters, setFilters] = useState(() => filtersFromParams(searchParams));
  const [searchText, setSearchText] = useState(() => searchParams.get('search') || '');
  const [resp, setResp] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showFilters, setShowFilters] = useState(true);

  const searchTimer = useRef(null);
  const scrollRef = useRef(null);

  // Sync filter state → URL query params (preserving reportId) so a refresh or
  // shared link restores the same view. `replace` keeps history uncluttered.
  useEffect(() => {
    const next = new URLSearchParams();
    const rid = searchParams.get('reportId');
    if (rid) next.set('reportId', rid);
    if (filters.layers.length) next.set('layer', filters.layers.join(','));
    if (filters.banks.length) next.set('bank', filters.banks.join(','));
    if (filters.payment_mode) next.set('payment_mode', filters.payment_mode);
    if (filters.date_from) next.set('date_from', filters.date_from);
    if (filters.date_to) next.set('date_to', filters.date_to);
    if (filters.min_amount !== '') next.set('min_amount', String(filters.min_amount));
    if (filters.max_amount !== '') next.set('max_amount', String(filters.max_amount));
    if (filters.search) next.set('search', filters.search);
    if (filters.page !== 1) next.set('page', String(filters.page));
    if (filters.limit !== 100) next.set('limit', String(filters.limit));
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  // Fetch from the server on every filter / report change.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    const params = {
      page: filters.page,
      limit: filters.limit,
      layer: filters.layers.length ? filters.layers.join(',') : undefined,
      bank: filters.banks.length ? filters.banks.join(',') : undefined,
      payment_mode: filters.payment_mode || undefined,
      date_from: filters.date_from || undefined,
      // make date_to inclusive of the whole day (backend compares the raw string)
      date_to: filters.date_to ? `${filters.date_to}T23:59:59` : undefined,
      min_amount: filters.min_amount !== '' ? filters.min_amount : undefined,
      max_amount: filters.max_amount !== '' ? filters.max_amount : undefined,
      search: filters.search || undefined,
    };

    getTransactions(reportId, params)
      .then((r) => { if (!cancelled) setResp(r); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [filters, reportId]);

  // Debounce the search box (300ms) → folds into filters.page = 1.
  const onSearchChange = (value) => {
    setSearchText(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setFilters((f) => ({ ...f, search: value, page: 1 }));
    }, 300);
  };

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch, page: 1 }));
  const toggleInList = (key, value) => setFilters((f) => {
    const list = f[key];
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    return { ...f, [key]: next, page: 1 };
  });
  const clearFilters = () => { setFilters(EMPTY_FILTERS); setSearchText(''); };

  const rows = resp?.data || [];

  // Virtualize the rendered rows.
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 41,
    overscan: 12,
  });
  const virtualItems = rowVirtualizer.getVirtualItems();
  const paddingTop = virtualItems.length ? virtualItems[0].start : 0;
  const paddingBottom = virtualItems.length
    ? rowVirtualizer.getTotalSize() - virtualItems[virtualItems.length - 1].end
    : 0;

  const COL_COUNT = 12;
  const activeFilterCount = useMemo(() => (
    filters.layers.length + filters.banks.length
    + (filters.payment_mode ? 1 : 0) + (filters.date_from ? 1 : 0) + (filters.date_to ? 1 : 0)
    + (filters.min_amount !== '' ? 1 : 0) + (filters.max_amount !== '' ? 1 : 0) + (filters.search ? 1 : 0)
  ), [filters]);

  const exportCsv = () => {
    const header = ['Date', 'Account', 'Name', 'Bank', 'IFSC', 'Amount', 'Disputed', 'Mode', 'Layer', 'UTR', 'City', 'State'];
    const lines = [header.join(',')];
    for (const t of rows) {
      lines.push([t.transaction_date, t.beneficiary_account, t.beneficiary_name, t.beneficiary_bank, t.ifsc_code, t.transaction_amount, t.disputed_amount, t.payment_mode, t.layer_no, t.utr_no, t.city, t.state]
        .map((c) => `"${String(c ?? '')}"`).join(','));
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'transactions.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>All Transactions</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load transactions"
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
        <h1>All Transactions</h1>
        <p className="subtitle">{resp ? `${formatNumber(resp.total)} transactions` : 'Loading…'} · cashout rows tinted red, ⚡ marks same-day cashouts</p>
      </header>

      {/* Collapsible filter panel */}
      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <div className="table-toolbar" style={{ marginBottom: showFilters ? 14 : 0 }}>
          <button type="button" className="btn btn-sm" onClick={() => setShowFilters((s) => !s)}>
            {showFilters ? '▾' : '▸'} Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ''}
          </button>
          <input
            className="input"
            placeholder="Search account / name / UTR / IFSC…"
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            style={{ minWidth: 280 }}
          />
          <span className="spacer" />
          {activeFilterCount > 0 && <button type="button" className="btn btn-sm" onClick={clearFilters}>Clear all</button>}
          <button type="button" className="btn btn-sm" onClick={exportCsv} disabled={rows.length === 0}>⬇ Export CSV</button>
        </div>

        {showFilters && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 16 }}>
            <FilterGroup label="Layer">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {[0, 1, 2, 3, 4].map((l) => (
                  <Chip key={l} active={filters.layers.includes(l)} onClick={() => toggleInList('layers', l)}>L{l}</Chip>
                ))}
              </div>
            </FilterGroup>

            <FilterGroup label="Bank">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {BANKS.map((b) => (
                  <Chip key={b} active={filters.banks.includes(b)} onClick={() => toggleInList('banks', b)}>{b}</Chip>
                ))}
              </div>
            </FilterGroup>

            <FilterGroup label="Payment Mode">
              <select className="select" value={filters.payment_mode} onChange={(e) => setFilter({ payment_mode: e.target.value })}>
                <option value="">All modes</option>
                {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </FilterGroup>

            <FilterGroup label="Date Range">
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="date" className="input" value={filters.date_from} onChange={(e) => setFilter({ date_from: e.target.value })} />
                <input type="date" className="input" value={filters.date_to} onChange={(e) => setFilter({ date_to: e.target.value })} />
              </div>
            </FilterGroup>

            <FilterGroup label="Amount Range (₹)">
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" className="input" placeholder="Min" value={filters.min_amount} onChange={(e) => setFilter({ min_amount: e.target.value })} style={{ width: 100 }} />
                <input type="number" className="input" placeholder="Max" value={filters.max_amount} onChange={(e) => setFilter({ max_amount: e.target.value })} style={{ width: 100 }} />
              </div>
            </FilterGroup>
          </div>
        )}
      </div>

      {/* Virtualized table */}
      <div className="card card-pad">
        {loading && !resp ? (
          <LoadingSpinner block label="Loading transactions…" />
        ) : rows.length === 0 ? (
          <div className="empty-state">
            No transactions match the current filters. Try widening the date range or clearing filters.
          </div>
        ) : (
          <>
            <div ref={scrollRef} style={{ height: 560, overflow: 'auto', opacity: loading ? 0.6 : 1 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    {['Date', 'Account', 'Name', 'Bank', 'IFSC', 'Amount', 'Disputed', 'Mode', 'Layer', 'UTR', 'City', 'State'].map((h) => (
                      <th key={h} style={{ position: 'sticky', top: 0, zIndex: 1 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {paddingTop > 0 && <tr style={{ height: paddingTop }}><td colSpan={COL_COUNT} /></tr>}
                  {virtualItems.map((vi) => {
                    const t = rows[vi.index];
                    const isCashout = CASH_EXIT_MODES.has(t.payment_mode) || t.cashout_mode === 'ATM_WITHDRAWAL' || t.cashout_mode === 'POS_PURCHASE';
                    return (
                      <tr key={t.id} style={isCashout ? { background: '#FFF5F5' } : undefined}>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {t.same_day_cashout ? <span title="Same-day cashout" style={{ marginRight: 4 }}>⚡</span> : null}
                          {formatDateTime(t.transaction_date)}
                        </td>
                        <td>{t.beneficiary_account}</td>
                        <td>{t.beneficiary_name}</td>
                        <td>{t.beneficiary_bank}</td>
                        <td>{t.ifsc_code}</td>
                        <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatINR(t.transaction_amount)}</td>
                        <td style={{ textAlign: 'right' }}>{formatINR(t.disputed_amount)}</td>
                        <td>{t.payment_mode}</td>
                        <td>L{t.layer_no}</td>
                        <td>{t.utr_no}</td>
                        <td>{t.city}</td>
                        <td>{t.state}</td>
                      </tr>
                    );
                  })}
                  {paddingBottom > 0 && <tr style={{ height: paddingBottom }}><td colSpan={COL_COUNT} /></tr>}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="table-footer">
              <span>
                Page {resp.page} of {Math.max(1, resp.total_pages)} · {formatNumber(resp.total)} rows
              </span>
              <span className="spacer" />
              <label>
                Rows:{' '}
                <select className="select" value={filters.limit} onChange={(e) => setFilters((f) => ({ ...f, limit: Number(e.target.value), page: 1 }))}>
                  {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              <button type="button" className="btn btn-sm" disabled={resp.page <= 1} onClick={() => setFilters((f) => ({ ...f, page: f.page - 1 }))}>‹ Prev</button>
              <button type="button" className="btn btn-sm" disabled={resp.page >= resp.total_pages} onClick={() => setFilters((f) => ({ ...f, page: f.page + 1 }))}>Next ›</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Filter UI helpers ───────────────────────────────────────────────────────

function FilterGroup({ label, children }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>{label}</div>
      {children}
    </div>
  );
}

function Chip({ active, onClick, children }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${active ? 'var(--brand)' : 'var(--border)'}`,
        background: active ? 'var(--brand)' : 'var(--card-bg)',
        color: active ? '#fff' : 'var(--text)',
      }}
    >
      {children}
    </button>
  );
}
