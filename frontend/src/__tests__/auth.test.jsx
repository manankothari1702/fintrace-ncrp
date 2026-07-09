/**
 * Frontend auth tests (Phase 1 Sub-step D): the auth gate blocks unauthenticated
 * access, login renders + submits, and role gates the admin-only UI. The api
 * client is mocked so no real backend is needed; tests drive the real
 * AuthProvider/AuthGate/AuthBar code.
 */

import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { AuthProvider } from '../context/AuthContext.jsx';
import AuthGate from '../auth/AuthGate.jsx';
import AuthBar from '../auth/AuthBar.jsx';
import { ROLES } from '../auth/permissions.js';
import * as api from '../utils/api.js';

vi.mock('../utils/api.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    authLogin: vi.fn(),
    authLogout: vi.fn().mockResolvedValue({ ok: true }),
    authChangePassword: vi.fn(),
    authPolicy: vi.fn().mockResolvedValue({ policy: { description: 'policy text', minLength: 10 } }),
    listUsers: vi.fn().mockResolvedValue([]),
    setAuthToken: vi.fn(),
    setUnauthorizedHandler: vi.fn(),
  };
});

function Protected() {
  return <div data-testid="protected">Secret case data</div>;
}

describe('AuthGate', () => {
  test('unauthenticated → shows login, hides protected content', () => {
    render(
      <AuthProvider>
        <AuthGate><Protected /></AuthGate>
      </AuthProvider>,
    );
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  test('successful login reveals the protected app', async () => {
    api.authLogin.mockResolvedValue({
      token: 'tok-1',
      user: { id: 1, username: 'io1', role: ROLES.IO, must_change_password: false },
    });
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <AuthGate><Protected /></AuthGate>
      </AuthProvider>,
    );

    await user.type(screen.getByLabelText(/username/i), 'io1');
    await user.type(screen.getByLabelText(/password/i), 'Secret!2026');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByTestId('protected')).toBeInTheDocument();
    expect(api.setAuthToken).toHaveBeenCalledWith('tok-1');
  });

  test('bad credentials surface a friendly error, no protected content', async () => {
    const err = new api.ApiError('Invalid username or password.', { code: 'INVALID_CREDENTIALS', status: 401 });
    api.authLogin.mockRejectedValue(err);
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <AuthGate><Protected /></AuthGate>
      </AuthProvider>,
    );
    await user.type(screen.getByLabelText(/username/i), 'io1');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/invalid username or password/i);
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });

  test('must_change_password → forced change screen, not the app', async () => {
    api.authLogin.mockResolvedValue({
      token: 'tok-2',
      user: { id: 2, username: 'admin', role: ROLES.SYSTEM_ADMIN, must_change_password: true },
    });
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <AuthGate><Protected /></AuthGate>
      </AuthProvider>,
    );
    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/^password$/i), 'ChangeMe!2026');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    // Forced-change screen shows its unique subtitle; the app stays hidden.
    expect(await screen.findByText(/set a new password to continue/i)).toBeInTheDocument();
    expect(screen.queryByTestId('protected')).not.toBeInTheDocument();
  });
});

describe('AuthBar role-based UI', () => {
  // Log a user of the given role into a provider, then render AuthBar within it.
  async function renderBarAs(role) {
    api.authLogin.mockResolvedValue({
      token: 't', user: { id: 9, username: `u_${role}`, role, must_change_password: false },
    });
    const user = userEvent.setup();
    render(
      <AuthProvider>
        <AuthGate><AuthBar /></AuthGate>
      </AuthProvider>,
    );
    await user.type(screen.getByLabelText(/username/i), `u_${role}`);
    await user.type(screen.getByLabelText(/password/i), 'Secret!2026');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    // Wait until the bar (sign out) is present.
    await screen.findAllByRole('button', { name: /sign out/i });
    return user;
  }

  test('System Admin sees the Users (management) button', async () => {
    await renderBarAs(ROLES.SYSTEM_ADMIN);
    expect(screen.getAllByRole('button', { name: /^users$/i }).length).toBeGreaterThan(0);
  });

  test('non-admin (IO) does NOT see the Users button', async () => {
    await renderBarAs(ROLES.IO);
    expect(screen.queryByRole('button', { name: /^users$/i })).not.toBeInTheDocument();
  });

  test('shows the current user and role, and logout clears the session', async () => {
    const user = await renderBarAs(ROLES.IO);
    expect(screen.getAllByText('u_io').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/investigating officer/i).length).toBeGreaterThan(0);

    await user.click(screen.getAllByRole('button', { name: /sign out/i })[0]);
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
  });
});
