/**
 * LoginScreen (Phase 1 Sub-step D). The whole app is gated behind this until a
 * successful login. Reuses the app theme tokens (.input/.btn/.auth-*).
 */

import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { friendlyErrorMessage } from '../utils/api.js';
import './auth.css';

export default function LoginScreen() {
  const { login, expiredNotice } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(username.trim(), password);
      // On success the gate re-renders into the app (or forced-change screen).
    } catch (err) {
      setError(friendlyErrorMessage(err) || err.message || 'Sign in failed.');
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-brand">
          <span className="auth-brand-mark" aria-hidden="true">🛡️</span>
          <span>FinTrace NCRP</span>
        </div>
        <p className="auth-subtitle">Sign in to continue</p>

        {expiredNotice && !error && (
          <div className="auth-notice" role="status">
            Your session ended. Please sign in again.
          </div>
        )}
        {error && <div className="auth-error" role="alert">{error}</div>}

        <div className="auth-field">
          <label htmlFor="login-username">Username</label>
          <input
            id="login-username"
            className="input"
            type="text"
            autoComplete="username"
            autoFocus
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>

        <div className="auth-field">
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>

        <div className="auth-actions">
          <button type="submit" className="btn btn-primary" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
