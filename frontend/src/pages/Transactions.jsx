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

import ErrorAlert from '../components/ErrorAlert.jsx';
import { SkeletonLine } from '../components/Skeleton.jsx';
import { formatINR, formatDateTimeUTC, formatNumber } from '../utils/format.js';
import { getTransactions, getTransactionFacets, getAggregators, friendlyErrorMessage, ApiError } from '../utils/api.js';

// Canonical account key (mirrors the backend's canonicalAccountKey): all-digit
// accounts have leading zeros stripped so "0000X" and "X" match one aggregator.
function canonAcct(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, '') : s;
}
import { useActiveReportId } from '../context/ReportContext.jsx';

const PAGE_SIZES = [100, 250, 500];
const PAYMENT_MODES = ['UPI', 'IMPS', 'NEFT', 'RTGS', 'ATM', 'POS', 'AEPS', 'HOLD'];
const CASH_EXIT_MODES = new Set(['ATM', 'POS']);
// Page size used to stream the FULL filtered set into the CSV export (server cap
// is 500). Kept separate from the on-screen PAGE_SIZES so a UI change never
// silently shrinks an export.
const EXPORT_PAGE_SIZE = 500;
// High-value transactions (over ₹1,00,000) are tinted orange so an officer can
// spot the big movements at a glance while scanning a long trail.
const HIGH_AMOUNT_THRESHOLD = 100000;

// Monospace for identifier columns (account / IFSC / UTR) — fixed advance keeps
// digits column-aligned, matching the Lien / Money Flow tables.
const MONO = { fontFamily: 'var(--font-mono)' };
// Single-line ellipsis for long free-text cells (bank, name); pair with a title
// tooltip — same pattern as the Mules / Lien / Data Quality tables.
const TRUNC_CELL = {
  display: 'inline-block', maxWidth: 190, overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom',
};

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
  sort: 'transaction_date', // Batch 2 Area 3 — column sort (backend-whitelisted)
  dir: 'desc',
};

// Column header label → backend sort key (whitelist mirrors the server route).
const SORT_KEYS = {
  Date: 'transaction_date',
  Account: 'beneficiary_account',
  Name: 'beneficiary_name',
  Bank: 'beneficiary_bank',
  IFSC: 'ifsc_code',
  Amount: 'transaction_amount',
  Disputed: 'disputed_amount',
  Mode: 'payment_mode',
  Layer: 'layer_no',
  UTR: 'utr_no',
  City: 'city',
  State: 'state',
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
    sort: sp.get('sort') || 'transaction_date',
    dir: sp.get('dir') === 'asc' ? 'asc' : 'desc',
  };
}

// Build the server-side filter params (everything except pagination) from the
// filter state. Shared by the on-screen fetch and the CSV export so the export
// can never apply a different filter than what is displayed.
function serverParams(filters) {
  return {
    layer: filters.layers.length ? filters.layers.join(',') : undefined,
    bank: filters.banks.length ? filters.banks.join(',') : undefined,
    payment_mode: filters.payment_mode || undefined,
    date_from: filters.date_from || undefined,
    // make date_to inclusive of the whole day (backend compares the raw string)
    date_to: filters.date_to ? `${filters.date_to}T23:59:59` : undefined,
    min_amount: filters.min_amount !== '' ? filters.min_amount : undefined,
    max_amount: filters.max_amount !== '' ? filters.max_amount : undefined,
    search: filters.search || undefined,
    sort: filters.sort || undefined,
    dir: filters.dir || undefined,
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
  // Filter options derived from the report's ACTUAL data (banks + layers).
  const [facets, setFacets] = useState({ banks: [], layers: [] });
  // Feature 3 — aggregator lookup (canonical account → {severity, senders}) so
  // rows whose beneficiary is a collection point carry an inline ⚑ marker.
  const [aggMap, setAggMap] = useState(() => new Map());
  const [bankSearch, setBankSearch] = useState('');
  // Bank multi-select dropdown open state.
  const [bankOpen, setBankOpen] = useState(false);
  // CSV export streams every filtered page, so it has its own busy flag.
  const [exporting, setExporting] = useState(false);

  const searchTimer = useRef(null);
  const scrollRef = useRef(null);
  const bankRef = useRef(null);

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
    // Only persist sort when it differs from the default chronological view.
    if (filters.sort && filters.sort !== 'transaction_date') next.set('sort', filters.sort);
    if (filters.dir && filters.dir !== 'desc') next.set('dir', filters.dir);
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

    const params = { ...serverParams(filters), page: filters.page, limit: filters.limit };

    getTransactions(reportId, params)
      .then((r) => { if (!cancelled) setResp(r); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [filters, reportId]);

  // Fetch the report's distinct banks + layers ONCE per report, so the Bank and
  // Layer filters offer the values that actually exist in the data (unfiltered)
  // — never a hardcoded option that matches zero rows.
  useEffect(() => {
    let cancelled = false;
    if (!reportId) { setFacets({ banks: [], layers: [] }); return undefined; }
    getTransactionFacets(reportId)
      .then((f) => { if (!cancelled) setFacets({ banks: f.banks || [], layers: f.layers || [] }); })
      .catch(() => { if (!cancelled) setFacets({ banks: [], layers: [] }); });
    return () => { cancelled = true; };
  }, [reportId]);

  // Feature 3 — load the aggregator set ONCE per report to badge rows inline.
  useEffect(() => {
    let cancelled = false;
    if (!reportId) { setAggMap(new Map()); return undefined; }
    getAggregators(reportId)
      .then((a) => {
        if (cancelled) return;
        const m = new Map();
        for (const acc of (a && a.accounts) || []) {
          m.set(canonAcct(acc.account_no), { severity: acc.severity, senders: acc.distinct_senders });
        }
        setAggMap(m);
      })
      .catch(() => { if (!cancelled) setAggMap(new Map()); });
    return () => { cancelled = true; };
  }, [reportId]);

  // Keyboard: Escape closes the bank dropdown first (if open), otherwise
  // collapses the filter panel — layered so one Escape never does both.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (bankOpen) { setBankOpen(false); return; }
      if (showFilters) setShowFilters(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showFilters, bankOpen]);

  // Close the bank dropdown on an outside click (standard popover behaviour).
  useEffect(() => {
    if (!bankOpen) return undefined;
    const onDown = (e) => {
      if (bankRef.current && !bankRef.current.contains(e.target)) setBankOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [bankOpen]);

  // Debounce the search box (300ms) → folds into filters.page = 1.
  const onSearchChange = (value) => {
    setSearchText(value);
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      setFilters((f) => ({ ...f, search: value, page: 1 }));
    }, 300);
  };

  // Enter applies the current search immediately instead of waiting out the
  // 300ms debounce — the expected "submit" affordance for a search box.
  const onSearchKeyDown = (e) => {
    if (e.key !== 'Enter') return;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    setFilters((f) => ({ ...f, search: e.target.value, page: 1 }));
  };

  const setFilter = (patch) => setFilters((f) => ({ ...f, ...patch, page: 1 }));
  const toggleInList = (key, value) => setFilters((f) => {
    const list = f[key];
    const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    return { ...f, [key]: next, page: 1 };
  });
  const clearFilters = () => { setFilters(EMPTY_FILTERS); setSearchText(''); setBankSearch(''); setBankOpen(false); };

  // Click a column header to sort: same column flips direction, a new column
  // starts descending. Resets to page 1 (the server re-sorts the whole set).
  const toggleSort = (col) => setFilters((f) => ({
    ...f,
    sort: col,
    dir: f.sort === col && f.dir === 'desc' ? 'asc' : 'desc',
    page: 1,
  }));
  const clearBanks = () => setFilters((f) => ({ ...f, banks: [], page: 1 }));

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

  // Banks shown in the filter list: matched by the search box, but ALWAYS keep
  // selected ones visible (so a selection never disappears when you type).
  const visibleBanks = useMemo(() => {
    const q = bankSearch.trim().toLowerCase();
    const list = facets.banks || [];
    if (!q) return list;
    return list.filter((b) => b.name.toLowerCase().includes(q) || filters.banks.includes(b.name));
  }, [facets.banks, bankSearch, filters.banks]);

  // Export the ENTIRE current filtered set, not just the visible page. Streams
  // every server page (limit 500) and assembles one CSV. Raw values are written
  // verbatim (exact paise preserved); a Duplicate column carries the exact-
  // duplicate flag so the exported evidence is self-documenting.
  const exportCsv = async () => {
    if (!reportId || exporting) return;
    setExporting(true);
    try {
      const header = ['Date', 'Account', 'Name', 'Bank', 'IFSC', 'Amount', 'Disputed', 'Mode', 'Layer', 'UTR', 'City', 'State', 'Duplicate'];
      const lines = [header.join(',')];
      const base = serverParams(filters);
      let page = 1;
      let total = Infinity;
      let fetched = 0;
      while (fetched < total) {
        // eslint-disable-next-line no-await-in-loop
        const r = await getTransactions(reportId, { ...base, page, limit: EXPORT_PAGE_SIZE });
        total = r.total;
        for (const t of r.data) {
          lines.push([
            t.transaction_date, t.beneficiary_account, t.beneficiary_name, t.beneficiary_bank,
            t.ifsc_code, t.transaction_amount, t.disputed_amount, t.payment_mode, t.layer_no,
            t.utr_no, t.city, t.state, t.is_duplicate ? 'YES' : '',
          ].map((c) => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','));
        }
        fetched += r.data.length;
        if (!r.data.length || page >= (r.total_pages || 1)) break;
        page += 1;
      }
      const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' }));
      const a = document.createElement('a');
      a.href = url; a.download = 'transactions.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e);
    } finally {
      setExporting(false);
    }
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
        <p className="subtitle">
          {!resp ? 'Loading…' : (
            activeFilterCount > 0
              ? `Showing ${formatNumber(resp.total)} of ${formatNumber(resp.report_total ?? resp.total)} ledger rows`
              : `${formatNumber(resp.report_total ?? resp.total)} ledger rows`
                + (resp.unique_hops != null ? ` · ${formatNumber(resp.unique_hops)} distinct hops` : '')
                + (resp.duplicate_total ? ` · ${formatNumber(resp.duplicate_total)} exact duplicate${resp.duplicate_total === 1 ? '' : 's'} ⧉` : '')
          )}
          {' · '}cashout rows tinted red, ⚡ same-day cashouts, ⧉ exact duplicates, amounts over ₹1L in orange
        </p>
        {resp && (
          <p className="subtitle" style={{ marginTop: 4, fontSize: 12, lineHeight: 1.45 }}>
            Raw evidence ledger — every leg from the source sheets, incl. ATM/POS/HOLD dispositions and
            {' '}the {formatNumber(resp.duplicate_total || 0)} exact-duplicate leg{(resp.duplicate_total || 0) === 1 ? '' : 's'} the
            {' '}dedup system flags (⧉) but excludes from every total. The Dashboard counts
            {' '}{resp.unique_hops != null ? formatNumber(resp.unique_hops) : 'the'} distinct hops; per-layer counts here are
            {' '}raw rows (incl. dispositions &amp; duplicates), so they read higher than the Layers page&rsquo;s deduped hop counts.
          </p>
        )}
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
            onKeyDown={onSearchKeyDown}
            style={{ minWidth: 280 }}
          />
          <span className="spacer" />
          {activeFilterCount > 0 && <button type="button" className="btn btn-sm" onClick={clearFilters}>Clear all</button>}
          <button
            type="button"
            className="btn btn-sm"
            onClick={exportCsv}
            disabled={exporting || !resp || resp.total === 0}
            title="Exports the full current filtered set (all pages), not just the visible page"
          >
            {exporting ? '… Exporting' : '⬇ Export CSV'}
          </button>
        </div>

        {showFilters && (
          <div className="txn-filter-grid">
            <FilterGroup label="Layer">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {facets.layers.length === 0 ? (
                  <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>—</span>
                ) : facets.layers.map(({ layer, count }) => (
                  <Chip
                    key={layer}
                    active={filters.layers.includes(layer)}
                    onClick={() => toggleInList('layers', layer)}
                    title={`${formatNumber(count)} row${count === 1 ? '' : 's'}`}
                  >
                    L{layer}
                  </Chip>
                ))}
              </div>
            </FilterGroup>

            <FilterGroup label="Bank">
              <div className="bank-select" ref={bankRef}>
                <button
                  type="button"
                  className={`bank-trigger${bankOpen ? ' is-open' : ''}${filters.banks.length === 0 ? ' is-placeholder' : ''}`}
                  onClick={() => setBankOpen((o) => !o)}
                  aria-expanded={bankOpen}
                  aria-haspopup="listbox"
                  disabled={facets.banks.length === 0}
                >
                  <span className="bank-trigger-label">
                    {filters.banks.length === 0
                      ? 'All banks'
                      : `${filters.banks.length} bank${filters.banks.length === 1 ? '' : 's'} selected`}
                  </span>
                  <span className="bank-trigger-chevron" aria-hidden="true">▾</span>
                </button>

                {bankOpen && (
                  <div className="bank-popover" role="listbox" aria-label="Filter by bank">
                    <div className="bank-search">
                      <SearchIcon />
                      <input
                        className="bank-search-input"
                        placeholder="Search banks…"
                        value={bankSearch}
                        onChange={(e) => setBankSearch(e.target.value)}
                        autoFocus
                      />
                      {bankSearch && (
                        <button type="button" className="bank-search-clear" onClick={() => setBankSearch('')} aria-label="Clear search">✕</button>
                      )}
                    </div>
                    <div className="bank-popover-head">
                      <span>{bankSearch ? `${visibleBanks.length} of ${formatNumber(facets.banks.length)}` : `${formatNumber(facets.banks.length)} banks`}</span>
                      {filters.banks.length > 0 && (
                        <button type="button" className="bank-clear-link" onClick={clearBanks}>Clear {filters.banks.length}</button>
                      )}
                    </div>
                    <div className="bank-list">
                      {visibleBanks.length === 0 ? (
                        <div className="bank-empty">No banks match &ldquo;{bankSearch}&rdquo;.</div>
                      ) : visibleBanks.map(({ name, count }) => (
                        <label key={name} className="bank-row">
                          <input type="checkbox" checked={filters.banks.includes(name)} onChange={() => toggleInList('banks', name)} />
                          <span className="bank-row-name" title={name}>{name}</span>
                          <span className="bank-row-count">{formatNumber(count)}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                )}

                {filters.banks.length > 0 && (
                  <div className="bank-chips">
                    {filters.banks.map((name) => (
                      <span key={name} className="bank-chip">
                        <span className="bank-chip-name" title={name}>{name}</span>
                        <button type="button" className="bank-chip-x" onClick={() => toggleInList('banks', name)} aria-label={`Remove ${name}`}>✕</button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </FilterGroup>

            <FilterGroup label="Payment Mode">
              <select className="select" value={filters.payment_mode} onChange={(e) => setFilter({ payment_mode: e.target.value })} style={{ width: '100%' }}>
                <option value="">All modes</option>
                {PAYMENT_MODES.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
            </FilterGroup>

            <FilterGroup label="Date Range">
              <div className="filter-range">
                <input type="date" className="input" aria-label="From date" value={filters.date_from} onChange={(e) => setFilter({ date_from: e.target.value })} />
                <input type="date" className="input" aria-label="To date" value={filters.date_to} onChange={(e) => setFilter({ date_to: e.target.value })} />
              </div>
            </FilterGroup>

            <FilterGroup label="Amount Range (₹)">
              <div className="filter-range" style={{ '--range-basis': '4.5rem' }}>
                <input type="number" className="input" placeholder="Min" aria-label="Minimum amount" value={filters.min_amount} onChange={(e) => setFilter({ min_amount: e.target.value })} />
                <input type="number" className="input" placeholder="Max" aria-label="Maximum amount" value={filters.max_amount} onChange={(e) => setFilter({ max_amount: e.target.value })} />
              </div>
            </FilterGroup>
          </div>
        )}
      </div>

      {/* Virtualized table */}
      <div className="card card-pad">
        {loading && !resp ? (
          <div>
            <SkeletonLine height={32} style={{ marginBottom: 12 }} />
            {Array.from({ length: 10 }).map((_, i) => (
              <SkeletonLine key={i} height={20} style={{ margin: '12px 0' }} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="empty-state">
            {activeFilterCount > 0 ? (
              <>
                No transactions match the current filters. Try widening the date range or removing a filter.
                <div style={{ marginTop: 12 }}>
                  <button type="button" className="btn btn-sm" onClick={clearFilters}>Clear all filters</button>
                </div>
              </>
            ) : (
              'This report has no transactions to display.'
            )}
          </div>
        ) : (
          <>
            <div ref={scrollRef} style={{ height: 560, overflow: 'auto', opacity: loading ? 0.6 : 1 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    {['Date', 'Account', 'Name', 'Bank', 'IFSC', 'Amount', 'Disputed', 'Mode', 'Layer', 'UTR', 'City', 'State'].map((h) => {
                      const col = SORT_KEYS[h];
                      const active = col && filters.sort === col;
                      return (
                        <th
                          key={h}
                          className={col ? 'th-sort' : undefined}
                          style={{ position: 'sticky', top: 0, zIndex: 1 }}
                          onClick={col ? () => toggleSort(col) : undefined}
                          aria-sort={active ? (filters.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                        >
                          {h}
                          {col && <span className="sort-ind">{active ? (filters.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕'}</span>}
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {paddingTop > 0 && <tr style={{ height: paddingTop }}><td colSpan={COL_COUNT} /></tr>}
                  {virtualItems.map((vi) => {
                    const t = rows[vi.index];
                    const isCashout = CASH_EXIT_MODES.has(t.payment_mode) || t.cashout_mode === 'ATM_WITHDRAWAL' || t.cashout_mode === 'POS_PURCHASE';
                    const isHighValue = Number(t.transaction_amount) > HIGH_AMOUNT_THRESHOLD;
                    const isDuplicate = !!t.is_duplicate;
                    // Cashout (red) wins the row tint when a row is both; a duplicate
                    // always carries the ⧉ badge + a left accent so it reads through.
                    const rowStyle = {};
                    if (isCashout) rowStyle.background = 'color-mix(in srgb, var(--danger) 8%, transparent)';
                    else if (isDuplicate) rowStyle.background = 'color-mix(in srgb, var(--text-muted) 12%, transparent)';
                    return (
                      <tr key={t.id} style={rowStyle}>
                        <td style={{ whiteSpace: 'nowrap', borderLeft: isDuplicate ? '3px solid var(--accent-orange)' : undefined }}>
                          {isDuplicate ? (
                            <span
                              className="dup-flag"
                              title="Exact duplicate — this leg is re-listed across NCRP sheets and is EXCLUDED from every total (shown here for completeness)."
                            >
                              ⧉
                            </span>
                          ) : null}
                          {t.same_day_cashout ? <span title="Same-day cashout — withdrawn the day it was received" style={{ marginRight: 4 }}>⚡</span> : null}
                          {formatDateTimeUTC(t.transaction_date)}
                        </td>
                        <td style={MONO}>
                          {t.beneficiary_account || '—'}
                          {(() => {
                            const a = aggMap.get(canonAcct(t.beneficiary_account));
                            if (!a) return null;
                            return (
                              <span
                                className={`agg-mark${a.severity === 'danger' ? ' danger' : ''}`}
                                title={`Aggregator — collected from ${a.senders} distinct senders`}
                                aria-label={`Aggregator, ${a.senders} senders`}
                              >
                                ⚑{a.senders}
                              </span>
                            );
                          })()}
                        </td>
                        <td>{t.beneficiary_name ? <span style={TRUNC_CELL} title={t.beneficiary_name}>{t.beneficiary_name}</span> : '—'}</td>
                        <td>{t.beneficiary_bank ? <span style={TRUNC_CELL} title={t.beneficiary_bank}>{t.beneficiary_bank}</span> : '—'}</td>
                        <td style={MONO}>{t.ifsc_code || '—'}</td>
                        <td
                          style={{ textAlign: 'right', fontWeight: 600, color: isHighValue ? 'var(--accent-orange-text)' : undefined }}
                          title={isHighValue ? 'High-value transaction (over ₹1,00,000)' : undefined}
                        >
                          {formatINR(t.transaction_amount)}
                        </td>
                        <td style={{ textAlign: 'right' }}>{formatINR(t.disputed_amount)}</td>
                        <td>{t.payment_mode || '—'}</td>
                        <td>L{t.layer_no}</td>
                        <td style={MONO}>{t.utr_no || '—'}</td>
                        <td>{t.city || '—'}</td>
                        <td>{t.state || '—'}</td>
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
      <div className="txn-filter-label">{label}</div>
      {children}
    </div>
  );
}

// Inline magnifier for the bank search field (no icon dependency).
function SearchIcon() {
  return (
    <svg className="bank-search-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" />
      <line x1="10.6" y1="10.6" x2="14" y2="14" strokeLinecap="round" />
    </svg>
  );
}

function Chip({ active, onClick, children, title }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`chip${active ? ' is-active' : ''}`}
    >
      {children}
    </button>
  );
}
