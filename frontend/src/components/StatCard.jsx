import { memo } from 'react';

/**
 * Metric tile for dashboards. White card with a coloured left border that
 * keys the metric to the app's colour grammar (money green, risk orange, …).
 *
 * Memoised: dashboards render four–eight of these in a grid and re-render on
 * every poll tick / filter change while their own props rarely move.
 *
 * @param {object} props
 * @param {string} props.title - Short metric label (rendered uppercase).
 * @param {React.ReactNode} props.value - The big number (pre-formatted).
 * @param {string} [props.subtitle] - Caption under the value.
 * @param {React.ReactNode} [props.icon] - Emoji / glyph in the top-right.
 * @param {string} [props.color] - Left-border + value tint (CSS colour).
 * @param {{ direction: 'up'|'down', label: string }} [props.trend]
 */
function StatCard({ title, value, subtitle, icon, color = 'var(--brand)', trend }) {
  return (
    <div className="stat-card" style={{ borderLeftColor: color }}>
      <div className="stat-head">
        <span className="stat-title">{title}</span>
        {icon && <span className="stat-icon" aria-hidden="true">{icon}</span>}
      </div>

      <div className="stat-value" style={{ color }}>
        {value}
      </div>

      {(subtitle || trend) && (
        <div className="stat-footer">
          {trend && (
            <span className={`stat-trend ${trend.direction === 'down' ? 'down' : 'up'}`}>
              {trend.direction === 'down' ? '↓' : '↑'} {trend.label}
            </span>
          )}
          {subtitle && <span>{subtitle}</span>}
        </div>
      )}
    </div>
  );
}

export default memo(StatCard);
