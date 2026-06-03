/**
 * Shape-matched loading placeholders.
 *
 * Every data page shows one of these while its first fetch is in flight, so the
 * layout reserves its real shape (cards, charts, table rows) and settles in
 * place instead of flashing a bare centred spinner. All pieces are pure CSS
 * (`.skeleton` + the shimmer keyframes in index.css) — no animation JS — and
 * collapse to a static block when the user prefers reduced motion.
 *
 * Compose them directly in a page's `loading` branch, e.g.
 *   if (loading) return <div className="page">…<SkeletonStats /><SkeletonTable /></div>;
 */

import { memo } from 'react';

/** A single shimmering bar. `width`/`height` accept any CSS length. */
function SkeletonLine({ width = '100%', height = 12, style }) {
  return <div className="skeleton skeleton-line" style={{ width, height, ...style }} />;
}

/** A row of metric-card placeholders matching the `.grid-stats` layout. */
function SkeletonStats({ count = 4 }) {
  return (
    <div className="grid grid-stats" style={{ marginBottom: 20 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton skeleton-stat" />
      ))}
    </div>
  );
}

/** A card holding a chart-sized placeholder. */
function SkeletonChart({ height = 280, title = true }) {
  return (
    <div className="card card-pad">
      {title && <SkeletonLine width="40%" height={16} style={{ marginBottom: 14 }} />}
      <div className="skeleton skeleton-chart" style={{ height }} />
    </div>
  );
}

/** A card holding a header bar plus a stack of table-row placeholders. */
function SkeletonTable({ rows = 8, title = true }) {
  return (
    <div className="card card-pad">
      {title && <SkeletonLine width="30%" height={16} style={{ marginBottom: 16 }} />}
      <SkeletonLine height={28} style={{ marginBottom: 10 }} />
      {Array.from({ length: rows }).map((_, i) => (
        <SkeletonLine key={i} height={18} style={{ margin: '10px 0' }} />
      ))}
    </div>
  );
}

/** A stack of expandable-card placeholders (Layers / Emails accordions). */
function SkeletonCards({ count = 4 }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 56 }} />
      ))}
    </div>
  );
}

export { SkeletonLine, SkeletonStats, SkeletonChart, SkeletonTable, SkeletonCards };

export default memo(SkeletonStats);
