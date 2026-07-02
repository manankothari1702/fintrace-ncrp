/**
 * Fixed left navigation. Collapsible (icon-only) for officers who want more
 * room for the wide transaction tables. The collapsed flag is lifted to App
 * so the main content margin tracks it.
 *
 * Nav order mirrors the investigative workflow: ingest the file, read the
 * dashboard, then drill into layers → mules → liens → transactions, and
 * finally act (draft letters) and review (timeline).
 *
 * Labels (nav items, brand text, footer) stay mounted in every state and are
 * shown/hidden purely with CSS (opacity + max-width) so collapse/expand
 * animates smoothly instead of snapping. In the collapsed state a `title`
 * tooltip surfaces each item's name on hover.
 *
 * @param {object} props
 * @param {boolean} props.collapsed
 * @param {() => void} props.onToggle
 */
import { useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';

import { useReportContext } from '../context/ReportContext.jsx';
import { useTheme } from '../utils/theme.js';
import { getReportBadges } from '../utils/api.js';

const APP_VERSION = '0.4.0';

// `badge` names the count field from GET /badges to show as a right-aligned
// count pill (Features 3/4). `flag` marks items that carry a risk indicator when
// their count > 0 (Cash/Exit), so the pill reads as a red alert, not a tally.
const NAV_ITEMS = [
  { to: '/upload', icon: '📤', label: 'Upload' },
  { to: '/dashboard', icon: '📊', label: 'Dashboard' },
  { to: '/layers', icon: '🔢', label: 'Layers' },
  { to: '/money-flow', icon: '🕸️', label: 'Money Flow' },
  { to: '/mules', icon: '🎯', label: 'Mule Accounts', badge: 'aggregators' },
  { to: '/cash-exit', icon: '🏧', label: 'Cash / Exit', badge: 'cash_exit_flags', flag: true },
  { to: '/lien', icon: '💰', label: 'Lien Tracker' },
  { to: '/data-quality', icon: '🔎', label: 'Data Quality' },
  { to: '/transactions', icon: '📋', label: 'Transactions' },
  { to: '/emails', icon: '✉️', label: 'Draft Emails' },
  { to: '/timeline', icon: '📅', label: 'Timeline' },
];

export default function Sidebar({ collapsed, onToggle }) {
  const { activeReportId } = useReportContext();
  const [theme, toggleTheme] = useTheme();
  // Carry the active report through navigation so a deep-linked / refreshed
  // page resolves the same report. Upload never needs it.
  const query = activeReportId ? `?reportId=${activeReportId}` : '';

  // Lightweight actionable counts for the count badges (aggregators on Mule
  // Accounts, risk flags on Cash/Exit). Fetched once per active report from the
  // cached snapshot; failures leave the badges hidden rather than blocking nav.
  const [badges, setBadges] = useState({ aggregators: 0, cash_exit_flags: 0 });
  useEffect(() => {
    let cancelled = false;
    if (!activeReportId) { setBadges({ aggregators: 0, cash_exit_flags: 0 }); return undefined; }
    getReportBadges(activeReportId)
      .then((b) => { if (!cancelled && b) setBadges({ aggregators: b.aggregators || 0, cash_exit_flags: b.cash_exit_flags || 0 }); })
      .catch(() => { if (!cancelled) setBadges({ aggregators: 0, cash_exit_flags: 0 }); });
    return () => { cancelled = true; };
  }, [activeReportId]);

  const isDark = theme === 'dark';

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar-logo">
        <span className="mark" aria-hidden="true">🛡️</span>
        <div className="brand-text">
          <div className="brand-name">FinTrace</div>
          <div className="brand-sub">NCRP</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => {
          const count = item.badge ? (badges[item.badge] || 0) : 0;
          return (
            <NavLink
              key={item.to}
              to={`${item.to}${item.to === '/upload' ? '' : query}`}
              className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              title={collapsed ? item.label : undefined}
            >
              <span className="nav-icon" aria-hidden="true">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {count > 0 && (
                <span
                  className={`nav-count${item.flag ? ' flag' : ''}`}
                  title={item.flag
                    ? `${count} risk ${count === 1 ? 'flag' : 'flags'}`
                    : `${count} ${count === 1 ? 'aggregator' : 'aggregators'} detected`}
                  aria-label={item.flag
                    ? `${count} risk flags`
                    : `${count} aggregators detected`}
                >
                  {item.flag ? `⚑${count}` : count}
                </span>
              )}
            </NavLink>
          );
        })}
      </nav>

      <div className="sidebar-controls">
        <button
          type="button"
          className="ctrl-btn theme-toggle"
          onClick={toggleTheme}
          title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
          aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          <span className="ctrl-icon" aria-hidden="true">{isDark ? '☽' : '☀'}</span>
          <span className="nav-label">{isDark ? 'Dark' : 'Light'}</span>
        </button>

        <button
          type="button"
          className="ctrl-btn collapse-btn"
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <span className="ctrl-icon chevron" aria-hidden="true">{collapsed ? '›' : '‹'}</span>
          <span className="nav-label">Collapse</span>
        </button>
      </div>

      <div className="sidebar-footer">
        <span className="mint nav-label">MINTERGRAPH</span>
        <span>v{APP_VERSION}</span>
      </div>
    </aside>
  );
}
