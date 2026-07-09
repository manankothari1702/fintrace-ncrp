/**
 * ChangePasswordScreen (Phase 1 Sub-step D).
 *
 * Shown when the authenticated user has must_change_password set (forced first-
 * login change) — nothing else in the app is reachable until they change it.
 * Also usable as a voluntary change (see `forced` prop). Fetches the live
 * password policy to show the rules.
 */

import { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { authPolicy, friendlyErrorMessage } from '../utils/api.js';
import './auth.css';

export default function ChangePasswordScreen({ forced = true, onDone, onCancel }) {
  const { changePassword, logout, user } = useAuth();
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const [policy, setPolicy] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    authPolicy().then((r) => { if (alive) setPolicy(r.policy); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const onSubmit = async (e) => {
    e.preventDefault();
    if (busy) return;
    if (newPassword !== confirm) { setError('New password and confirmation do not match.'); return; }
    setBusy(true);
    setError(null);
    try {
      await changePassword(oldPassword, newPassword);
      if (onDone) onDone();
    } catch (err) {
      setError(friendlyErrorMessage(err) || err.message || 'Could not change password.');
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-brand">
          <span className="auth-brand-mark" aria-hidden="true">🔑</span>
          <span>Change password</span>
        </div>
        <p className="auth-subtitle">
          {forced
            ? `Welcome, ${user ? user.username : ''}. Set a new password to continue.`
            : 'Update your password.'}
        </p>

        {error && <div className="auth-error" role="alert">{error}</div>}

        <div className="auth-field">
          <label htmlFor="cp-old">Current password</label>
          <input id="cp-old" className="input" type="password" autoComplete="current-password"
            value={oldPassword} onChange={(e) => setOld(e.target.value)} required autoFocus />
        </div>
        <div className="auth-field">
          <label htmlFor="cp-new">New password</label>
          <input id="cp-new" className="input" type="password" autoComplete="new-password"
            value={newPassword} onChange={(e) => setNew(e.target.value)} required />
          {policy && <div className="auth-policy">{policy.description}</div>}
        </div>
        <div className="auth-field">
          <label htmlFor="cp-confirm">Confirm new password</label>
          <input id="cp-confirm" className="input" type="password" autoComplete="new-password"
            value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </div>

        <div className="auth-actions">
          <button type="submit" className="btn btn-primary"
            disabled={busy || !oldPassword || !newPassword || !confirm}>
            {busy ? 'Saving…' : 'Change password'}
          </button>
        </div>
        <div className="auth-actions" style={{ marginTop: 10 }}>
          {forced ? (
            <button type="button" className="btn" onClick={logout} disabled={busy}>
              Sign out
            </button>
          ) : (
            <button type="button" className="btn" onClick={onCancel} disabled={busy}>
              Cancel
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
