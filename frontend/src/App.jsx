/**
 * FinTrace NCRP — application root.
 *
 * Composes the fixed sidebar with a routed main content area (React Router v6)
 * and wraps the whole tree in a global error boundary so a render failure in
 * one page shows a recoverable fallback instead of a blank screen.
 *
 * Routes (8 pages, mirroring the sidebar):
 *   /upload  /dashboard  /layers  /mules  /lien  /transactions  /emails  /timeline
 * `/` redirects to /upload — the natural entry point of the workflow.
 */

import { Component, useState } from 'react';
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom';

import Sidebar from './components/Sidebar.jsx';
import { ReportProvider } from './context/ReportContext.jsx';

import UploadPage from './pages/Upload.jsx';
import DashboardPage from './pages/Dashboard.jsx';
import LayersPage from './pages/Layers.jsx';
import MulesPage from './pages/Mules.jsx';
import LienPage from './pages/Lien.jsx';
import TransactionsPage from './pages/Transactions.jsx';
import EmailsPage from './pages/Emails.jsx';
import TimelinePage from './pages/Timeline.jsx';

// ─── Global error boundary ───────────────────────────────────────────

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // Surfaced in the dev console; in production this is the place to forward
    // to the main process via window.fintrace.* if/when a log channel exists.
    // eslint-disable-next-line no-console
    console.error('FinTrace render error:', error, info);
  }

  handleReset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <div className="boundary-fallback">
          <div className="card card-pad">
            <h2 style={{ marginBottom: 8 }}>The view crashed</h2>
            <p style={{ color: 'var(--text-muted)', marginBottom: 16 }}>
              {this.state.error.message || 'An unexpected error occurred while rendering this page.'}
            </p>
            <button type="button" className="btn btn-primary" onClick={this.handleReset}>
              Reload view
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ─── App ──────────────────────────────────────────────────────────────

export default function App() {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <ErrorBoundary>
      <HashRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ReportProvider>
          <div className="app-shell">
            <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
            <main className={`app-main${collapsed ? ' is-collapsed' : ''}`}>
              <Routes>
                <Route path="/" element={<Navigate to="/upload" replace />} />
                <Route path="/upload" element={<UploadPage />} />
                <Route path="/dashboard" element={<DashboardPage />} />
                <Route path="/layers" element={<LayersPage />} />
                <Route path="/mules" element={<MulesPage />} />
                <Route path="/lien" element={<LienPage />} />
                <Route path="/transactions" element={<TransactionsPage />} />
                <Route path="/emails" element={<EmailsPage />} />
                <Route path="/timeline" element={<TimelinePage />} />
                <Route path="*" element={<Navigate to="/upload" replace />} />
              </Routes>
            </main>
          </div>
        </ReportProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}
