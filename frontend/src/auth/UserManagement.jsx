/**
 * UserManagement (Phase 1 Sub-step D) — System-Admin-only modal.
 *
 * Create / deactivate / reactivate users, change roles, and reset passwords.
 * All actions call the admin-only /api/users routes; the backend re-checks the
 * MANAGE_USERS permission, so this UI is a convenience, not the enforcement.
 */

import { useEffect, useState, useCallback } from 'react';
import {
  listUsers, createUser, setUserRole, setUserActive, resetUserPassword,
  friendlyErrorMessage,
} from '../utils/api.js';
import { ROLES, ROLE_LABELS, roleLabel } from './permissions.js';
import ModalShell from '../components/ModalShell.jsx';
import './auth.css';

const ROLE_OPTIONS = Object.values(ROLES);

export default function UserManagement({ onClose }) {
  const [users, setUsers] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // create form
  const [nu, setNu] = useState({ username: '', role: ROLES.IO, password: '' });
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { setUsers(await listUsers()); setError(null); } catch (err) {
      setError(friendlyErrorMessage(err) || err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const guard = async (fn) => {
    try { await fn(); await refresh(); setError(null); } catch (err) {
      setError(friendlyErrorMessage(err) || err.message);
    }
  };

  const onCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      await createUser({ username: nu.username.trim(), role: nu.role, password: nu.password });
      setNu({ username: '', role: ROLES.IO, password: '' });
      await refresh();
      setError(null);
    } catch (err) {
      setError(friendlyErrorMessage(err) || err.message);
    } finally { setCreating(false); }
  };

  const onReset = (u) => {
    const pw = window.prompt(`New temporary password for "${u.username}" (they will be forced to change it):`);
    if (pw) guard(() => resetUserPassword(u.id, pw));
  };

  return (
    <ModalShell onClose={onClose} ariaLabel="User management" panelClassName="um-modal">
      <div className="um-head">
        <h2>User management</h2>
        <button type="button" className="btn btn-sm" onClick={onClose}>✕ Close</button>
      </div>

        {error && <div className="auth-error" role="alert">{error}</div>}

        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading users…</p>
        ) : (
          <table className="um-table">
            <thead>
              <tr>
                <th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.is_active ? undefined : 'um-inactive'}>
                  <td>
                    {u.username}
                    {u.must_change_password && (
                      <span title="Must change password at next login" style={{ marginLeft: 6 }}>🔑</span>
                    )}
                  </td>
                  <td>
                    <select
                      className="select"
                      value={u.role}
                      aria-label={`Role for ${u.username}`}
                      onChange={(e) => guard(() => setUserRole(u.id, e.target.value))}
                    >
                      {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                    </select>
                  </td>
                  <td>{u.is_active ? 'Active' : 'Inactive'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{u.last_login || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button type="button" className="btn btn-sm" onClick={() => onReset(u)}>Reset pw</button>{' '}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => guard(() => setUserActive(u.id, !u.is_active))}
                    >
                      {u.is_active ? 'Deactivate' : 'Activate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <form className="um-create" onSubmit={onCreate}>
          <h3 style={{ fontSize: 14, marginBottom: 10 }}>Add a user</h3>
          <div className="um-create-row">
            <div className="auth-field">
              <label htmlFor="um-username">Username</label>
              <input id="um-username" className="input" value={nu.username}
                onChange={(e) => setNu({ ...nu, username: e.target.value })} required />
            </div>
            <div className="auth-field">
              <label htmlFor="um-role">Role</label>
              <select id="um-role" className="select" value={nu.role}
                onChange={(e) => setNu({ ...nu, role: e.target.value })}>
                {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
              </select>
            </div>
            <div className="auth-field">
              <label htmlFor="um-pw">Temp password</label>
              <input id="um-pw" className="input" type="text" value={nu.password}
                onChange={(e) => setNu({ ...nu, password: e.target.value })} required />
            </div>
            <button type="submit" className="btn btn-primary" disabled={creating}>
              {creating ? 'Adding…' : 'Add user'}
            </button>
          </div>
          <p className="auth-policy">New users must change this temporary password at first login.</p>
        </form>
    </ModalShell>
  );
}
