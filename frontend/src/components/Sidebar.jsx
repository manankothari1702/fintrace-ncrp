/**
 * Fixed left navigation. Collapsible (icon-only) for officers who want more
 * room for the wide transaction tables. The collapsed flag is lifted to App
 * so the main content margin tracks it.
 *
 * Nav order mirrors the investigative workflow: ingest the file, read the
 * dashboard, then drill into layers → mules → liens → transactions, and
 * finally act (draft letters) and review (timeline).
 *
 * @param {object} props
 * @param {boolean} props.collapsed
 * @param {() => void} props.onToggle
 */
import { NavLink } from 'react-router-dom';

import { useReportContext } from '../context/ReportContext.jsx';

const APP_VERSION = '0.1.0';

const NAV_ITEMS = [
  { to: '/upload', icon: '📤', label: 'Upload' },
  { to: '/dashboard', icon: '📊', label: 'Dashboard' },
  { to: '/layers', icon: '🔢', label: 'Layers' },
  { to: '/mules', icon: '🎯', label: 'Mule Accounts' },
  { to: '/lien', icon: '💰', label: 'Lien Tracker' },
  { to: '/transactions', icon: '📋', label: 'Transactions' },
  { to: '/emails', icon: '✉️', label: 'Draft Emails' },
  { to: '/timeline', icon: '📅', label: 'Timeline' },
];

export default function Sidebar({ collapsed, onToggle }) {
  const { activeReportId } = useReportContext();
  // Carry the active report through navigation so a deep-linked / refreshed
  // page resolves the same report. Upload never needs it.
  const query = activeReportId ? `?reportId=${activeReportId}` : '';

  return (
    <aside className={`sidebar${collapsed ? ' is-collapsed' : ''}`}>
      <div className="sidebar-logo">
        <span className="mark" aria-hidden="true">🛡️</span>
        {!collapsed && (
          <div>
            <div className="brand-name">FinTrace</div>
            <div className="brand-sub">NCRP</div>
          </div>
        )}
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
            {!collapsed && <span>{item.label}</span>}
          </NavLink>
        ))}
      </nav>

      <button
        type="button"
        className="collapse-btn"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
      >
        {collapsed ? '»' : '« Collapse'}
      </button>

      <div className="sidebar-footer">
        {!collapsed && <span className="mint">MINTERGRAPH</span>}
        <span>v{APP_VERSION}</span>
      </div>
    </aside>
  );
}
