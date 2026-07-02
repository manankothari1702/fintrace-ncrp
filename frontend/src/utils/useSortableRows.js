import { useMemo, useState } from 'react';

/**
 * Lightweight client-side sorting for the RAW-table pages (Lien Tracker, Cash/Exit)
 * that don't use the DataTable component (they carry inline controls / dynamic
 * columns). DataTable-based tables already sort themselves; this is the shared
 * helper so the raw tables get the same click-to-sort behaviour without each
 * page re-implementing it.
 *
 * Nulls always sort last; numbers compare numerically; everything else compares
 * with a numeric-aware locale collation. Presentation only — it reorders the rows
 * it is given, never mutating or recomputing values.
 *
 * @param {Array<object>} rows
 * @param {{ key: string|null, dir: 'asc'|'desc' }} [initial]
 * @returns {{ sorted: Array<object>, sortKey: string|null, sortDir: string,
 *   toggle: (key:string)=>void, indicator: (key:string)=>string }}
 */
export function useSortableRows(rows, initial = { key: null, dir: 'asc' }) {
  const [sort, setSort] = useState(initial);

  const sorted = useMemo(() => {
    if (!sort.key) return rows;
    const dir = sort.dir === 'desc' ? -1 : 1;
    return [...rows].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      const aEmpty = av == null || av === '';
      const bEmpty = bv == null || bv === '';
      if (aEmpty && bEmpty) return 0;
      if (aEmpty) return 1; // nulls last regardless of direction
      if (bEmpty) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
    });
  }, [rows, sort]);

  const toggle = (key) => setSort((s) => (
    s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' }
  ));
  const indicator = (key) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ' ↕');

  return { sorted, sortKey: sort.key, sortDir: sort.dir, toggle, indicator };
}
