// @refresh reset

/**
 * AuthContext — the frontend's single source of auth state (Phase 1 Sub-step D).
 *
 * Holds the session token + current user IN MEMORY (never persisted), mirroring
 * the backend's in-memory session: closing or reloading the app = logout. Wires
 * the api client so every request carries the token and any 401 (expired/invalid
 * session) drops the whole app back to the login screen.
 */

import {
  createContext, useContext, useState, useEffect, useCallback, useMemo,
} from 'react';

import {
  authLogin, authLogout, authChangePassword,
  setAuthToken, setUnauthorizedHandler,
} from '../utils/api.js';
import { roleHasPermission } from '../auth/permissions.js';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null);
  const [user, setUser] = useState(null);
  const [expiredNotice, setExpiredNotice] = useState(false);

  const clearSession = useCallback(() => {
    setAuthToken(null);
    setToken(null);
    setUser(null);
  }, []);

  // A 401 from anywhere (other than the login call) means the session is gone.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      clearSession();
      setExpiredNotice(true);
    });
    return () => setUnauthorizedHandler(null);
  }, [clearSession]);

  const login = useCallback(async (username, password) => {
    const res = await authLogin(username, password);
    setAuthToken(res.token);
    setToken(res.token);
    setUser(res.user);
    setExpiredNotice(false);
    return res.user;
  }, []);

  const logout = useCallback(async () => {
    try { await authLogout(); } catch (_e) { /* best effort — clear locally regardless */ }
    clearSession();
  }, [clearSession]);

  const changePassword = useCallback(async (oldPassword, newPassword) => {
    const res = await authChangePassword(oldPassword, newPassword);
    setUser(res.user); // must_change_password now false
    return res.user;
  }, []);

  const value = useMemo(() => ({
    token,
    user,
    isAuthenticated: !!token && !!user,
    mustChangePassword: !!(user && user.must_change_password),
    expiredNotice,
    dismissExpiredNotice: () => setExpiredNotice(false),
    login,
    logout,
    changePassword,
    /** UI-only capability check (backend still enforces). */
    can: (permission) => roleHasPermission(user && user.role, permission),
  }), [token, user, expiredNotice, login, logout, changePassword]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

/** Access auth state/actions. Throws outside an AuthProvider. */
export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an <AuthProvider>.');
  return ctx;
}
