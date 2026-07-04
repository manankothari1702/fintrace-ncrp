/**
 * FinTrace NCRP — application root.
 *
 * Composes the fixed sidebar with a routed main content area (React Router v6)
 * and wraps the whole tree in a global error boundary so a render failure in
 * one page shows a recoverable fallback instead of a blank screen.
 *
 * Routes (10 pages, mirroring the sidebar):
 *   /upload  /dashboard  /layers  /money-flow  /mules  /lien  /data-quality
 *   /transactions  /emails  /timeline
 * `/` redirects to /upload — the natural entry point of the workflow.
 */

import { Component, Suspense, lazy, useState } from 'react';
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom';

import Sidebar from './components/Sidebar.jsx';
import LoadingSpinner from './components/LoadingSpinner.jsx';
import { ReportProvider } from './context/ReportContext.jsx';
import { DetailModalProvider } from './context/DetailModalContext.jsx';

// Upload is the entry point (`/` redirects here), so it stays in the main
// chunk — first paint must never wait on a lazy fetch. Every other page is
// code-split into its own chunk, so the heavy chart/table libraries (recharts,
// TanStack) load only when their page is first opened instead of bloating the
// initial bundle.
import UploadPage from './pages/Upload.jsx';

const DashboardPage = lazy(() => import('./pages/Dashboard.jsx'));
const LayersPage = lazy(() => import('./pages/Layers.jsx'));
const MoneyFlowPage = lazy(() => import('./pages/MoneyFlow.jsx'));
const MulesPage = lazy(() => import('./pages/Mules.jsx'));
const CashExitPage = lazy(() => import('./pages/CashExit.jsx'));
const LienPage = lazy(() => import('./pages/Lien.jsx'));
const DataQualityPage = lazy(() => import('./pages/DataQuality.jsx'));
const TransactionsPage = lazy(() => import('./pages/Transactions.jsx'));
const EmailsPage = lazy(() => import('./pages/Emails.jsx'));
const TimelinePage = lazy(() => import('./pages/Timeline.jsx'));

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
          {/* Row drill-down modal: one provider so every page (and every nested
              counterparty inside the modal itself) opens the SAME <DetailModal>. */}
          <DetailModalProvider>
          <div className="app-shell">
            <Sidebar collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} />
            <main className={`app-main${collapsed ? ' is-collapsed' : ''}`}>
              <Suspense fallback={(
                <div className="page">
                  <LoadingSpinner block label="Loading…" />
                </div>
              )}
              >
                <Routes>
                  <Route path="/" element={<Navigate to="/upload" replace />} />
                  <Route path="/upload" element={<UploadPage />} />
                  <Route path="/dashboard" element={<DashboardPage />} />
                  <Route path="/layers" element={<LayersPage />} />
                  <Route path="/money-flow" element={<MoneyFlowPage />} />
                  <Route path="/mules" element={<MulesPage />} />
                  <Route path="/cash-exit" element={<CashExitPage />} />
                  <Route path="/lien" element={<LienPage />} />
                  <Route path="/data-quality" element={<DataQualityPage />} />
                  <Route path="/transactions" element={<TransactionsPage />} />
                  <Route path="/emails" element={<EmailsPage />} />
                  <Route path="/timeline" element={<TimelinePage />} />
                  <Route path="*" element={<Navigate to="/upload" replace />} />
                </Routes>
              </Suspense>
            </main>
          </div>
          </DetailModalProvider>
        </ReportProvider>
      </HashRouter>
    </ErrorBoundary>
  );
}
