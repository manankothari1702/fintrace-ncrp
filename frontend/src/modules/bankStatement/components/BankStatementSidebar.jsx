/**
 * Bank Statement module — left navigation.
 *
 * Structurally and visually a sibling of the NCRP sidebar, but it is its own
 * component and reuses only the shared, app-wide CSS primitives (.sidebar,
 * .nav-link, .ctrl-btn, …) from index.css — never the NCRP Sidebar component.
 * Navigation is driven by this module's own MemoryRouter, so it is fully
 * isolated from the NCRP HashRouter.
 *
 * The seven pages mirror the intended statement-analysis workflow: ingest the
 * files, review the accounts and transactions they contain, profile
 * counterparties, trace the fund trail, surface circular flows, and finally
 * export reports.
 */
import { NavLink } from 'react-router-dom';

import { useBankStatementTheme } from '../utils/theme.js';

const APP_VERSION = '0.4.0';

const NAV_ITEMS = [
  { to: '/upload', icon: '📤', label: 'Upload' },
  { to: '/accounts', icon: '🏦', label: 'Accounts' },
  { to: '/transactions', icon: '📋', label: 'Transactions' },
  { to: '/counterparty', icon: '👥', label: 'Counterparty' },
  { to: '/fund-trail', icon: '🔀', label: 'Fund Trail' },
  { to: '/circular-flow', icon: '🔁', label: 'Circular Flow' },
  { to: '/reports', icon: '📄', label: 'Reports' },
];

export default function BankStatementSidebar() {
  const [theme, toggleTheme] = useBankStatementTheme();
  const isDark = theme === 'dark';

  return (
    <aside className="sidebar bs-sidebar">
      <div className="sidebar-logo">
        <span className="mark" aria-hidden="true">🏦</span>
        <div className="brand-text">
          <div className="brand-name">FinTrace</div>
          <div className="brand-sub">STATEMENTS</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
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
      </div>

      <div className="sidebar-footer">
        <span className="mint nav-label">MINTERGRAPH</span>
        <span>v{APP_VERSION}</span>
      </div>
    </aside>
  );
}
