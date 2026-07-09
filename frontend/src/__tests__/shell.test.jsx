/**
 * App-shell smoke tests — the workspace mode toggle and module routing.
 *
 * Tests ONLY (per the Phase 0 ground rules): the shell source is imported
 * unchanged, never modified. The network layer is mocked so mounting the NCRP
 * module's Upload page (its default route) makes no HTTP calls.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import AppRoot from '../shell/AppRoot.jsx';

// The NCRP Upload page lists previous reports on mount; the bankStatement
// module is mock-backed and makes no network calls. Everything else in the
// api module (formatters, URL builders) keeps its real implementation.
vi.mock('../utils/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    listReports: vi.fn().mockResolvedValue([]),
    checkHealth: vi.fn().mockResolvedValue({ status: 'ok' }),
  };
});

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  window.location.hash = '';
});

describe('AppRoot workspace shell', () => {
  test('renders the brand and the two-workspace toggle, NCRP active by default', async () => {
    render(<AppRoot />);

    // The brand lives only in the active module's sidebar header now, never the
    // top bar. NCRP is active by default → its sidebar shows the FinTrace mark.
    expect(screen.getByText('FinTrace')).toBeInTheDocument();
    // No combined brand label survives in the top bar.
    expect(screen.queryByText('FinTrace NCRP')).not.toBeInTheDocument();

    const group = screen.getByRole('radiogroup', { name: 'Workspace' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /NCRP report/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Bank statements/ })).toHaveAttribute('aria-checked', 'false');

    // Default module + default route: the NCRP Upload page.
    expect(await screen.findByRole('heading', { name: 'Upload NCRP Report' })).toBeInTheDocument();
  });

  test('toggling to Bank statements swaps the module and persists the choice', async () => {
    const user = userEvent.setup();
    render(<AppRoot />);
    await screen.findByRole('heading', { name: 'Upload NCRP Report' });

    await user.click(screen.getByRole('radio', { name: /Bank statements/ }));

    expect(await screen.findByRole('heading', { name: 'Upload Bank Statements' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Upload NCRP Report' })).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Bank statements/ })).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('fintrace-active-module')).toBe('bankStatement');

    // The brand follows the module: the Bank Statements sidebar shows "FinTrace"
    // + "STATEMENTS"; the NCRP sidebar (and its "NCRP" sub) is unmounted.
    expect(screen.getByText('FinTrace')).toBeInTheDocument();
    expect(screen.getByText('STATEMENTS')).toBeInTheDocument();
    expect(screen.queryByText('NCRP')).not.toBeInTheDocument();
  });

  test('toggling back re-mounts the NCRP module', async () => {
    const user = userEvent.setup();
    render(<AppRoot />);
    await screen.findByRole('heading', { name: 'Upload NCRP Report' });

    await user.click(screen.getByRole('radio', { name: /Bank statements/ }));
    await screen.findByRole('heading', { name: 'Upload Bank Statements' });

    await user.click(screen.getByRole('radio', { name: /NCRP report/ }));
    expect(await screen.findByRole('heading', { name: 'Upload NCRP Report' })).toBeInTheDocument();
    expect(localStorage.getItem('fintrace-active-module')).toBe('ncrp');
  });

  test('a persisted bankStatement choice survives a fresh mount', async () => {
    localStorage.setItem('fintrace-active-module', 'bankStatement');
    render(<AppRoot />);

    expect(await screen.findByRole('heading', { name: 'Upload Bank Statements' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Bank statements/ })).toHaveAttribute('aria-checked', 'true');
  });

  test('an unknown persisted id falls back to the default module', async () => {
    localStorage.setItem('fintrace-active-module', 'not-a-module');
    render(<AppRoot />);

    expect(await screen.findByRole('heading', { name: 'Upload NCRP Report' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole('radio', { name: /NCRP report/ })).toHaveAttribute('aria-checked', 'true');
    });
  });
});
