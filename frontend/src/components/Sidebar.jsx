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
import { NavLink } from 'react-router-dom';

import { useReportContext } from '../context/ReportContext.jsx';
import { useTheme } from '../utils/theme.js';

const APP_VERSION = '0.3.0';

const NAV_ITEMS = [
  { to: '/upload', icon: '📤', label: 'Upload' },
  { to: '/dashboard', icon: '📊', label: 'Dashboard' },
  { to: '/layers', icon: '🔢', label: 'Layers' },
  { to: '/money-flow', icon: '🕸️', label: 'Money Flow' },
  { to: '/mules', icon: '🎯', label: 'Mule Accounts' },
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
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={`${item.to}${item.to === '/upload' ? '' : query}`}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            title={collapsed ? item.label : undefined}
          >
            <span className="nav-icon" aria-hidden="true">{item.icon}</span>
            <span className="nav-label">{item.label}</span>
          </NavLink>
        ))}
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
