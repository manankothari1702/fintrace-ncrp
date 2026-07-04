/**
 * DetailModal — the ONE shared row drill-down modal (Row Drill-Down Modal spec).
 *
 * Layout, top→bottom: breadcrumb (nested drills) → header (icon · title ·
 * subtitle · Export · ✕) → summary chips → optional "why flagged" notes →
 * toolbar (search + rows-per-page) → sortable detail table → footer totals.
 *
 * Purely presentational: the entity payload, column definitions, and export
 * handler come from DetailModalContext + the per-type adapter. Sorting reuses
 * useSortableRows (the Lien/Cash-Exit hook) with the same .th-sort header
 * convention; search filters client-side over the backend-declared
 * `searchable` fields with the SAME rule the export endpoint applies
 * (lowercase substring), so the export always matches the view.
 *
 * Accessibility: role=dialog + aria-modal, labelled by the title; focus moves
 * into the modal on open and returns to the trigger on close; Tab is trapped;
 * Esc and backdrop-click close; ↑/↓ walk the table rows.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import LoadingSpinner from './LoadingSpinner.jsx';
import ErrorAlert from './ErrorAlert.jsx';
import { friendlyErrorMessage } from '../utils/api.js';
import { formatNumber } from '../utils/format.js';
import { useSortableRows } from '../utils/useSortableRows.js';

const PAGE_SIZES = [20, 50, 100];

/**
 * Client-side twin of the backend's entityDetail.filterRows: case-insensitive
 * substring over the entity's `searchable` fields. Keep the two in lockstep —
 * the Excel export re-applies the server copy of this rule.
 */
function filterRows(rows, searchable, search) {
  const q = String(search == null ? '' : search).trim().toLowerCase();
  if (q === '') return rows;
  return rows.filter((row) => searchable.some((f) => {
    const v = row[f];
    return v !== null && v !== undefined && String(v).toLowerCase().includes(q);
  }));
}

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function DetailModal({
  open,
  onClose,
  onBack,                    // pops one breadcrumb level (nested drill)
  breadcrumb = [],           // [{ key, label }] — trail INCLUDING the current entity
  icon = null,
  title = '',
  titleMono = false,
  subtitle = null,
  badges = null,             // ReactNode row next to the title (risk/aggregator/victim)
  chips = [],                // [{ label, value, tone?, hint? }]
  notes = null,              // { title, items: string[] } — e.g. mule suspicion reasons
  columns = [],              // [{ key, header, align?, mono?, sortable?, render? }]
  rows = [],
  searchable = [],
  searchPlaceholder = 'Search…',
  loading = false,
  error = null,
  onRetry = null,
  emptyMessage = 'No records behind this entity in the uploaded file.',
  onExport = null,           // (search) => Promise<void>
  exporting = false,
  exportError = null,
  totals = null,             // (visibleRows) => [{ label, value }]
}) {
  const [search, setSearch] = useState('');
  const [pageSize, setPageSize] = useState(20);
  const [page, setPage] = useState(1);
  const dialogRef = useRef(null);
  const bodyRef = useRef(null);
  const titleId = useRef(`detail-modal-title-${Math.random().toString(36).slice(2, 8)}`).current;

  const filtered = useMemo(
    () => filterRows(rows, searchable, search),
    [rows, searchable, search],
  );
  const { sorted, toggle, indicator, sortKey } = useSortableRows(filtered);

  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const paged = useMemo(
    () => sorted.slice((safePage - 1) * pageSize, safePage * pageSize),
    [sorted, safePage, pageSize],
  );

  const footerTotals = useMemo(
    () => (typeof totals === 'function' ? totals(filtered) : []),
    [totals, filtered],
  );

  // Move focus into the dialog and lock body scroll while open. Restoring focus
  // to the ORIGINAL trigger is the provider's job (it survives nested drills,
  // which remount this component per entity).
  useEffect(() => {
    if (!open) return undefined;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Focus the dialog container itself so Esc/Tab handling engages immediately.
    const t = setTimeout(() => { dialogRef.current?.focus(); }, 0);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  // Keyboard: Esc closes (or steps back on a nested drill? Esc always CLOSES per
  // spec §3; the breadcrumb's ‹ button steps back). Tab cycles within the dialog.
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = dialogRef.current
        ? [...dialogRef.current.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.offsetParent !== null)
        : [];
      if (focusables.length === 0) { e.preventDefault(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  // ↑/↓ walk the rendered table rows (each row is focusable via tabIndex=-1).
  const onTableKeyDown = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const rowEls = bodyRef.current ? [...bodyRef.current.querySelectorAll('tbody tr')] : [];
    if (!rowEls.length) return;
    const idx = rowEls.indexOf(e.target.closest('tr'));
    const next = e.key === 'ArrowDown' ? Math.min(idx + 1, rowEls.length - 1) : Math.max(idx - 1, 0);
    if (rowEls[next]) {
      e.preventDefault();
      rowEls[next].focus();
    }
  };

  if (!open) return null;

  const searchActive = search.trim() !== '';

  return createPortal(
    <div
      className="detail-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="detail-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {breadcrumb.length > 1 && (
          <nav className="detail-breadcrumb" aria-label="Drill-down trail">
            <button type="button" className="btn btn-sm" onClick={onBack} aria-label="Back to previous entity">
              ‹ Back
            </button>
            {breadcrumb.map((b, i) => (
              <span key={b.key} className="detail-crumb">
                {i > 0 && <span aria-hidden="true"> › </span>}
                <span className={i === breadcrumb.length - 1 ? 'detail-crumb-current' : undefined}>
                  {b.label}
                </span>
              </span>
            ))}
          </nav>
        )}

        <header className="detail-modal-head">
          {icon && <span className="detail-modal-icon" aria-hidden="true">{icon}</span>}
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <h2
                id={titleId}
                className="detail-modal-title"
                style={titleMono ? { fontFamily: 'var(--font-mono)' } : undefined}
              >
                {title}
              </h2>
              {badges}
            </div>
            {subtitle && <p className="detail-modal-subtitle">{subtitle}</p>}
          </div>
          {onExport && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onExport(search.trim() || undefined)}
              disabled={exporting || loading || !!error || filtered.length === 0}
              title="Export the rows currently shown (respecting the search filter) as an Excel workbook"
            >
              {exporting ? '… Exporting' : '⬇ Export'}
            </button>
          )}
          <button type="button" className="btn btn-sm detail-modal-close" onClick={onClose} aria-label="Close details">
            ✕ Close
          </button>
        </header>

        {exportError && (
          <div style={{ padding: '10px 20px 0' }}>
            <ErrorAlert error={exportError} title="Export failed" message={friendlyErrorMessage(exportError)} />
          </div>
        )}

        {loading ? (
          <div className="detail-body" style={{ padding: 40 }}>
            <LoadingSpinner block label="Loading details…" />
          </div>
        ) : error ? (
          <div className="detail-body" style={{ padding: 20 }}>
            <ErrorAlert
              error={error}
              title="Couldn't load details"
              message={friendlyErrorMessage(error)}
              onRetry={onRetry}
            />
          </div>
        ) : (
          <>
            {chips.length > 0 && (
              <div className="detail-chips" role="group" aria-label="Entity summary">
                {chips.map((c) => (
                  <div key={c.label} className={`detail-chip${c.tone ? ` tone-${c.tone}` : ''}`}>
                    <div className="detail-chip-label">
                      {c.label}
                      {c.hint && (
                        <span className="info-dot" title={c.hint} tabIndex={0} role="img" aria-label={c.hint}>i</span>
                      )}
                    </div>
                    <div className="detail-chip-value">{c.value}</div>
                  </div>
                ))}
              </div>
            )}

            {notes && notes.items && notes.items.length > 0 && (
              <div className="detail-notes">
                <h4>{notes.title}</h4>
                <ul>
                  {notes.items.map((n, i) => (
                    <li key={i}>
                      <span style={{ color: 'var(--risk-high)' }} aria-hidden="true">▸</span> {n}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="detail-toolbar">
              <input
                className="input"
                type="search"
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                value={search}
                onChange={(e) => { setSearch(e.target.value); setPage(1); }}
                style={{ flex: 1, minWidth: 200 }}
              />
              <label style={{ fontSize: 13, color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
                Rows:{' '}
                <select
                  className="select"
                  value={pageSize}
                  onChange={(e) => { setPageSize(Number(e.target.value)); setPage(1); }}
                  aria-label="Rows per page"
                >
                  {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </div>

            <div className="detail-body" ref={bodyRef}>
              {sorted.length === 0 ? (
                <div className="empty-state" style={{ padding: 28 }}>
                  {searchActive
                    ? <>No rows match &ldquo;{search.trim()}&rdquo;. Clear the search to see all {formatNumber(rows.length)} records.</>
                    : emptyMessage}
                </div>
              ) : (
                  <table className="data-table" onKeyDown={onTableKeyDown}>
                    <thead>
                      <tr>
                        {columns.map((col) => {
                          const sortable = col.sortable !== false;
                          return (
                            <th
                              key={col.key}
                              className={sortable ? 'th-sort' : undefined}
                              style={col.align === 'right' ? { textAlign: 'right' } : undefined}
                              onClick={sortable ? () => toggle(col.key) : undefined}
                              aria-sort={sortable && sortKey === col.key ? (indicator(col.key).includes('▲') ? 'ascending' : 'descending') : undefined}
                            >
                              {col.header}
                              {sortable && <span className="sort-ind">{indicator(col.key)}</span>}
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody>
                      {paged.map((row, ri) => (
                        <tr key={row.id ?? ri} tabIndex={-1}>
                          {columns.map((col) => (
                            <td
                              key={col.key}
                              style={{
                                ...(col.align === 'right' ? { textAlign: 'right' } : null),
                                ...(col.mono ? { fontFamily: 'var(--font-mono)' } : null),
                              }}
                            >
                              {col.render ? col.render(row) : (row[col.key] ?? '—')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
              )}
            </div>

            <footer className="detail-foot">
              {footerTotals.map((t) => (
                <span key={t.label}>
                  {t.label}: <strong>{t.value}</strong>
                </span>
              ))}
              <span className="spacer" style={{ flex: 1 }} />
              <span style={{ color: 'var(--text-muted)' }}>
                {formatNumber(sorted.length)} record{sorted.length === 1 ? '' : 's'}
                {searchActive && <> (filtered from {formatNumber(rows.length)})</>}
              </span>
              {totalPages > 1 && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <button type="button" className="btn btn-sm" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>‹ Prev</button>
                  <span style={{ color: 'var(--text-muted)' }}>{safePage}/{totalPages}</span>
                  <button type="button" className="btn btn-sm" disabled={safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next ›</button>
                </span>
              )}
            </footer>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
