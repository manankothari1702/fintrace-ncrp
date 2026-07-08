/**
 * DetailModal smoke tests — the universal drill-down surface every page
 * shares, and the single riskiest component for later UI phases.
 *
 * Covers the contract, not the pixels: renders nothing while closed; shows
 * breadcrumb / title / chips / table when open; search filters rows with the
 * backend's lowercase-substring rule; Esc closes; ‹ Back pops one drill level.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import DetailModal from '../components/DetailModal.jsx';

const COLUMNS = [
  { key: 'utr_no', header: 'UTR', mono: true },
  { key: 'beneficiary_name', header: 'Beneficiary' },
  { key: 'amount', header: 'Amount', align: 'right' },
];

const ROWS = [
  { id: 1, utr_no: 'UTR0001', beneficiary_name: 'Mule One', amount: 1000 },
  { id: 2, utr_no: 'UTR0002', beneficiary_name: 'Mule Two', amount: 2000 },
  { id: 3, utr_no: 'XREF9', beneficiary_name: 'Collector', amount: 3000 },
];

function renderModal(overrides = {}) {
  const onClose = vi.fn();
  const onBack = vi.fn();
  const utils = render(
    <DetailModal
      open
      onClose={onClose}
      onBack={onBack}
      title="M0001"
      subtitle="Account drill-down"
      chips={[
        { label: 'Total received', value: '₹1.0 L' },
        { label: 'Risk', value: 'HIGH', tone: 'high' },
      ]}
      columns={COLUMNS}
      rows={ROWS}
      searchable={['utr_no', 'beneficiary_name']}
      searchPlaceholder="Search rows…"
      {...overrides}
    />,
  );
  return { onClose, onBack, ...utils };
}

describe('DetailModal', () => {
  test('renders nothing while closed', () => {
    render(
      <DetailModal open={false} onClose={() => {}} title="hidden" rows={ROWS} columns={COLUMNS} />,
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  test('open modal shows title, chips, and every row', () => {
    renderModal();

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: 'M0001' })).toBeInTheDocument();

    // Summary chips
    expect(screen.getByText('Total received')).toBeInTheDocument();
    expect(screen.getByText('₹1.0 L')).toBeInTheDocument();

    // Table: header + all three data rows
    expect(screen.getByRole('columnheader', { name: /UTR/ })).toBeInTheDocument();
    expect(screen.getByText('UTR0001')).toBeInTheDocument();
    expect(screen.getByText('Mule Two')).toBeInTheDocument();
    expect(screen.getByText(/3 records/)).toBeInTheDocument();
  });

  test('search filters rows over the searchable fields (lowercase substring)', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByRole('searchbox', { name: 'Search rows…' }), 'utr000');

    // UTR0001 + UTR0002 match; XREF9 must be filtered out.
    expect(screen.getByText('UTR0001')).toBeInTheDocument();
    expect(screen.getByText('UTR0002')).toBeInTheDocument();
    expect(screen.queryByText('XREF9')).not.toBeInTheDocument();
    expect(screen.getByText(/2 records \(filtered from 3\)/)).toBeInTheDocument();
  });

  test('a search with no hits shows the clear-search empty state, not the table', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByRole('searchbox', { name: 'Search rows…' }), 'zzz-no-hit');

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText(/No rows match/)).toBeInTheDocument();
  });

  test('Escape closes the modal', () => {
    const { onClose } = renderModal();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('nested drill shows the breadcrumb trail and ‹ Back pops one level', () => {
    const { onBack, onClose } = renderModal({
      breadcrumb: [
        { key: 'bank:HDFC', label: 'HDFC Bank' },
        { key: 'account:M0001', label: 'M0001' },
      ],
    });

    const nav = screen.getByRole('navigation', { name: 'Drill-down trail' });
    expect(nav).toHaveTextContent('HDFC Bank');
    expect(nav).toHaveTextContent('M0001');

    fireEvent.click(screen.getByRole('button', { name: 'Back to previous entity' }));
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('single-level drill renders no breadcrumb', () => {
    renderModal({ breadcrumb: [{ key: 'account:M0001', label: 'M0001' }] });
    expect(screen.queryByRole('navigation', { name: 'Drill-down trail' })).not.toBeInTheDocument();
  });
});
