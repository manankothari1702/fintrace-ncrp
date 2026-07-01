/**
 * Bank Statement module — root.
 *
 * A fully self-contained workspace mounted by the app shell (shell/AppRoot).
 * It composes its own sidebar with a routed content area and is deliberately
 * isolated from the NCRP module:
 *
 *   • Routing uses MemoryRouter — an in-memory history that never touches
 *     window.location.hash — so it can never collide with the NCRP module's
 *     HashRouter. (The two modules are also never mounted at the same time.)
 *   • It imports no NCRP component. It reuses only the shared, app-wide CSS
 *     primitives (.app-shell, .app-main, .sidebar, .card, .btn, .badge, …) so
 *     it matches the existing look without a second design system.
 *
 * Only Upload is a real page in this pass; the rest are navigable placeholders.
 */
import { lazy, Suspense } from 'react';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';

import BankStatementSidebar from './components/BankStatementSidebar.jsx';
import UploadPage from './pages/Upload.jsx';
import './bankStatement.css';

// Upload is the entry point and stays in the main chunk; the placeholder pages
// are trivial but code-split anyway to mirror the NCRP module's convention.
const AccountsPage = lazy(() => import('./pages/Accounts.jsx'));
const TransactionsPage = lazy(() => import('./pages/Transactions.jsx'));
const CounterpartyPage = lazy(() => import('./pages/Counterparty.jsx'));
const FundTrailPage = lazy(() => import('./pages/FundTrail.jsx'));
const CircularFlowPage = lazy(() => import('./pages/CircularFlow.jsx'));
const ReportsPage = lazy(() => import('./pages/Reports.jsx'));

export default function BankStatementApp() {
  return (
    // Same v7 future flags the NCRP router opts into, so the two modules behave
    // identically and neither logs a future-flag warning.
    <MemoryRouter
      initialEntries={['/upload']}
      future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
    >
      <div className="app-shell bs-shell">
        <BankStatementSidebar />
        <main className="app-main">
          <Suspense fallback={<div className="page"><div className="loading-block">Loading…</div></div>}>
            <Routes>
              <Route path="/" element={<Navigate to="/upload" replace />} />
              <Route path="/upload" element={<UploadPage />} />
              <Route path="/accounts" element={<AccountsPage />} />
              <Route path="/transactions" element={<TransactionsPage />} />
              <Route path="/counterparty" element={<CounterpartyPage />} />
              <Route path="/fund-trail" element={<FundTrailPage />} />
              <Route path="/circular-flow" element={<CircularFlowPage />} />
              <Route path="/reports" element={<ReportsPage />} />
              <Route path="*" element={<Navigate to="/upload" replace />} />
            </Routes>
          </Suspense>
        </main>
      </div>
    </MemoryRouter>
  );
}
