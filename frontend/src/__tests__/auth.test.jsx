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

describe('AuthBar profile dropdown + role-based UI', () => {
  // Log a user of the given role into a provider, then render AuthBar within it.
  async function renderBarAs(role) {
    api.authLogin.mockResolvedValue({
      token: 't', user: { id: 9, username: `u_${role}`, role, must_change_password: false },
    });
    const user = userEvent.setup();
    // AuthGate renders AuthBar itself, so pass a plain child (not another
    // AuthBar) — otherwise the bar would be duplicated in the DOM.
    render(
      <AuthProvider>
        <AuthGate><div data-testid="app-body" /></AuthGate>
      </AuthProvider>,
    );
    await user.type(screen.getByLabelText(/username/i), `u_${role}`);
    await user.type(screen.getByLabelText(/password/i), 'Secret!2026');
    await user.click(screen.getByRole('button', { name: /sign in/i }));
    // Wait until the profile control (name + role) is present.
    await screen.findByRole('button', { name: new RegExp(`account menu for u_${role}`, 'i') });
    return user;
  }

  // Log in, then open the profile dropdown so its menuitems are queryable.
  async function openMenuAs(role) {
    const user = await renderBarAs(role);
    await user.click(screen.getByRole('button', { name: new RegExp(`account menu for u_${role}`, 'i') }));
    await screen.findByRole('menu');
    return user;
  }

  test('System Admin sees Change password + Users + Backups + Sign out in the menu', async () => {
    await openMenuAs(ROLES.SYSTEM_ADMIN);
    expect(screen.getByRole('menuitem', { name: /change password/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^users$/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /^backups$/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
  });

  test('non-admin (IO) menu shows only Change password + Sign out', async () => {
    await openMenuAs(ROLES.IO);
    expect(screen.getByRole('menuitem', { name: /change password/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /sign out/i })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^users$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /^backups$/i })).not.toBeInTheDocument();
  });

  test('the profile control shows the current user and role even when closed', async () => {
    await renderBarAs(ROLES.IO);
    expect(screen.getByText('u_io')).toBeInTheDocument();
    expect(screen.getByText(/investigating officer/i)).toBeInTheDocument();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  test('Escape closes the dropdown', async () => {
    const user = await openMenuAs(ROLES.IO);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument());
  });

  test('Sign out from the menu clears the session', async () => {
    const user = await openMenuAs(ROLES.IO);
    await user.click(screen.getByRole('menuitem', { name: /sign out/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument());
  });
});
