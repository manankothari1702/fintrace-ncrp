/**
 * Dashboard smoke test — the heaviest data page (recharts + a dozen analysis
 * sections) rendered against a mocked, analysis-complete report.
 *
 * Goal: a regression net proving the page mounts and shows its headline
 * content given a realistic analysis_json shape — NOT pixel/value assertions.
 * jsdom has no layout, so charts render their zero-size fallbacks (the
 * ResizeObserver stub lives in src/test/setup.js).
 */

import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import Dashboard from '../pages/Dashboard.jsx';
import { ReportProvider } from '../context/ReportContext.jsx';
import { DetailModalProvider } from '../context/DetailModalContext.jsx';
import { getReport, getPaymentModes } from '../utils/api.js';

vi.mock('../utils/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getReport: vi.fn(),
    getPaymentModes: vi.fn(),
  };
});

const MOCK_ANALYSIS = {
  summary: {
    total_transactions: 4,
    unique_transactions: 4,
    duplicate_count: 0,
    total_disputed_amount: 100000,
    victim_loss: 100000,
    total_layers: 3,
    total_beneficiary_accounts: 3,
    fraud_start_date: '2024-01-15T05:00:00.000Z',
  },
  layer_analysis: [
    { layer_no: 1, transaction_count: 1, total_amount: 100000, disputed_amount: 100000, account_count: 1, cashout_count: 0 },
    { layer_no: 2, transaction_count: 1, total_amount: 90000, disputed_amount: 100000, account_count: 1, cashout_count: 0 },
    { layer_no: 3, transaction_count: 2, total_amount: 105000, disputed_amount: 100000, account_count: 1, cashout_count: 1 },
  ],
  mule_detection: [
    {
      account_no: 'M0001', bank_name: 'ICICI Bank', mule_score: 85, risk_label: 'HIGH',
      total_received: 100000, total_forwarded: 90000, pass_through_ratio: 0.9,
      appears_in_cases: 1, txn_count: 2, suspicion_reasons: ['High pass-through (90% of inflow moved on)'],
    },
    {
      account_no: 'M0003', bank_name: 'Axis Bank', mule_score: 45, risk_label: 'MEDIUM',
      total_received: 80000, total_forwarded: 0, pass_through_ratio: 0,
      appears_in_cases: 1, txn_count: 2, suspicion_reasons: [],
    },
  ],
  lien_calculation: [
    { account_no: 'M0003', bank_name: 'Axis Bank', lien_eligible_amount: 55000 },
  ],
  recovery_status: {
    victim_loss: 100000, cashed_out: 25000, on_hold: 0, refunded: 0, recoverable: 55000,
  },
  cashout_analysis: {
    same_day_cashouts: 1, total_cashed_out: 25000, cashout_count: 1,
  },
  investigation_roadmap: [
    { priority: 'P0', title: 'Send lien letters to Axis Bank', description: 'Freeze the recoverable residual.' },
  ],
  key_findings: ['₹1.0 L moved through 3 layers; ₹25,000 cashed out same-day.'],
  data_quality: [],
};

const MOCK_REPORT = {
  id: 1,
  original_filename: 'case_32712250107145.xlsx',
  upload_date: '2024-02-01T10:00:00.000Z',
  analysis_status: 'complete',
  total_transactions: 4,
  total_disputed_amount: 100000,
  total_layers: 3,
  fraud_start_date: '2024-01-15T05:00:00.000Z',
  analysis_json: MOCK_ANALYSIS,
};

function renderDashboard() {
  return render(
    <MemoryRouter initialEntries={['/dashboard?reportId=1']}>
      <ReportProvider>
        <DetailModalProvider>
          <Dashboard />
        </DetailModalProvider>
      </ReportProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  sessionStorage.clear();
  getReport.mockResolvedValue(MOCK_REPORT);
  getPaymentModes.mockResolvedValue({
    modes: [
      { mode: 'IMPS', count: 2 },
      { mode: 'NEFT', count: 1 },
      { mode: 'ATM', count: 1 },
    ],
  });
});

describe('Dashboard (analysis-complete report)', () => {
  test('mounts without crashing and shows the headline sections', async () => {
    renderDashboard();

    // Wait for the page to settle (loading → data → follow-up payment-split
    // render), THEN assert with fresh queries — the settling re-render can
    // replace the exact nodes an early findBy* resolved to.
    await screen.findByRole('heading', { name: /dashboard/i });
    await screen.findByText(/Investigation Roadmap/i);

    expect(screen.getByRole('heading', { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByText(/Send lien letters to Axis Bank/)).toBeInTheDocument();
    expect(getReport).toHaveBeenCalledWith('1');
  });

  test('renders the high-risk mule count from mule_detection', async () => {
    renderDashboard();
    await screen.findByRole('heading', { name: /dashboard/i });

    // One HIGH-risk account in the mock — the headline mule stat reflects it.
    expect(screen.getAllByText(/high/i).length).toBeGreaterThan(0);
  });
});
