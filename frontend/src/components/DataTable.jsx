/**
 * Generic client-side table built on TanStack Table v8.
 *
 * Features (all opt-in via props):
 *   • Click-to-sort column headers (toggles asc → desc → none).
 *   • Per-column text filters (set `enableColumnFilters`).
 *   • Pagination with a 25 / 50 / 100 rows-per-page selector.
 *   • Export-to-CSV of the currently filtered+sorted rows.
 *   • Loading skeleton and empty-state messaging.
 *
 * This wraps purely-client data. Server-paginated views (the big
 * transactions table) drive their own fetch and can still reuse this for the
 * current page by passing `manualPagination`-shaped data with paging disabled.
 *
 * @param {object} props
 * @param {import('@tanstack/react-table').ColumnDef<any>[]} props.columns
 * @param {any[]} props.data
 * @param {boolean} [props.loading=false]
 * @param {string} [props.emptyMessage='No records to display.']
 * @param {boolean} [props.enableColumnFilters=false]
 * @param {boolean} [props.enablePagination=true]
 * @param {boolean} [props.enableExport=true]
 * @param {string} [props.exportFilename='fintrace-export.csv']
 * @param {React.ReactNode} [props.toolbar] - Extra controls rendered left of the export button.
 * @param {(rowData: any) => React.ReactNode} [props.renderExpanded] - When set,
 *   rows become click-to-expand and this renders the detail panel below a row.
 */
import { Fragment, useMemo, useState } from 'react';
import {
  flexRender,
  getCoreRowModel,
  getExpandedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
} from '@tanstack/react-table';

const PAGE_SIZES = [25, 50, 100];

/** Quote a single CSV field per RFC 4180 (wrap + double embedded quotes). */
function csvField(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Serialise the given rows to CSV using each column's header text and its
 * accessor value, then trigger a browser download.
 */
function exportRowsToCsv(rows, columns, filename) {
  const cols = columns.filter((c) => c.id !== 'actions' && c.enableCsv !== false);
  const header = cols.map((c) => csvField(typeof c.columnDef.header === 'string'
    ? c.columnDef.header
    : c.id));
  const lines = [header.join(',')];

  for (const row of rows) {
    const cells = cols.map((c) => csvField(row.getValue(c.id)));
    lines.push(cells.join(','));
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function SkeletonBody({ columnCount, rows = 8 }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, r) => (
        <tr key={r}>
          {Array.from({ length: columnCount }).map((__, c) => (
            <td key={c}>
              <div className="skeleton-row" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export default function DataTable({
  columns,
  data,
  loading = false,
  emptyMessage = 'No records to display.',
  enableColumnFilters = false,
  enablePagination = true,
  enableExport = true,
  exportFilename = 'fintrace-export.csv',
  toolbar,
  renderExpanded,
}) {
  const [sorting, setSorting] = useState([]);
  const [columnFilters, setColumnFilters] = useState([]);
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize: 25 });
  const [expanded, setExpanded] = useState({});

  const safeData = useMemo(() => (Array.isArray(data) ? data : []), [data]);
  const expandable = typeof renderExpanded === 'function';

  const table = useReactTable({
    data: safeData,
    columns,
    state: { sorting, columnFilters, pagination, expanded },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onPaginationChange: setPagination,
    onExpandedChange: setExpanded,
    getRowCanExpand: () => expandable,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getExpandedRowModel: expandable ? getExpandedRowModel() : undefined,
    getPaginationRowModel: enablePagination ? getPaginationRowModel() : undefined,
  });

  const columnCount = columns.length || 1;
  const visibleRows = table.getRowModel().rows;
  const filteredRows = table.getFilteredRowModel().rows;

  return (
    <div className="card card-pad">
      {(toolbar || enableExport) && (
        <div className="table-toolbar">
          {toolbar}
          <span className="spacer" />
          {enableExport && (
            <button
              type="button"
              className="btn btn-sm"
              disabled={loading || filteredRows.length === 0}
              onClick={() => exportRowsToCsv(filteredRows, table.getAllLeafColumns(), exportFilename)}
            >
              ⬇ Export CSV
            </button>
          )}
        </div>
      )}

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sortDir = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      className={canSort ? 'sortable' : undefined}
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                      style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                    >
                      {flexRender(header.column.columnDef.header, header.getContext())}
                      {canSort && (
                        <span className="sort-indicator">
                          {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '↕'}
                        </span>
                      )}
                      {enableColumnFilters && header.column.getCanFilter() && (
                        <input
                          className="input col-filter"
                          placeholder="Filter…"
                          value={(header.column.getFilterValue() ?? '')}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => header.column.setFilterValue(e.target.value)}
                        />
                      )}
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          {loading ? (
            <SkeletonBody columnCount={columnCount} />
          ) : (
            <tbody>
              {visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={columnCount}>
                    <div className="empty-state">{emptyMessage}</div>
                  </td>
                </tr>
              ) : (
                visibleRows.map((row) => (
                  <Fragment key={row.id}>
                    <tr
                      onClick={expandable ? () => row.toggleExpanded() : undefined}
                      style={expandable ? { cursor: 'pointer' } : undefined}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>
                    {expandable && row.getIsExpanded() && (
                      <tr>
                        <td colSpan={columnCount} style={{ background: '#fafbfd', padding: 0 }}>
                          {renderExpanded(row.original)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          )}
        </table>
      </div>

      {enablePagination && !loading && filteredRows.length > 0 && (
        <div className="table-footer">
          <span>
            Showing {table.getState().pagination.pageIndex * table.getState().pagination.pageSize + 1}
            –
            {Math.min(
              (table.getState().pagination.pageIndex + 1) * table.getState().pagination.pageSize,
              filteredRows.length,
            )}{' '}
            of {filteredRows.length}
          </span>

          <span className="spacer" />

          <label>
            Rows:{' '}
            <select
              className="select"
              value={table.getState().pagination.pageSize}
              onChange={(e) => table.setPageSize(Number(e.target.value))}
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>{size}</option>
              ))}
            </select>
          </label>

          <button
            type="button"
            className="btn btn-sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            ‹ Prev
          </button>
          <span>
            Page {table.getState().pagination.pageIndex + 1} of {Math.max(1, table.getPageCount())}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
