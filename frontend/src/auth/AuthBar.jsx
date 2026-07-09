/**
 * AuthBar (Phase 1 Sub-step D) — a slim strip above the app shell showing the
 * signed-in user + role, with logout, self-service password change, and (for
 * System Admins) the user-management modal. Rendered by the AuthGate so NONE of
 * the off-limits shell code (src/shell) is touched.
 */

import { useState } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { PERMISSIONS, roleLabel } from './permissions.js';
import UserManagement from './UserManagement.jsx';
import BackupManager from './BackupManager.jsx';
import ChangePasswordScreen from './ChangePasswordScreen.jsx';
import './auth.css';

export default function AuthBar() {
  const { user, logout, can } = useAuth();
  const [showUsers, setShowUsers] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  const [showChange, setShowChange] = useState(false);
  if (!user) return null;

  return (
    <>
      <div className="auth-bar">
        <span className="auth-user">
          <span aria-hidden="true">👤</span>
          <strong>{user.username}</strong>
          <span className="auth-role">{roleLabel(user.role)}</span>
        </span>
        <span className="spacer" />
        {can(PERMISSIONS.MANAGE_USERS) && (
          <button type="button" className="btn btn-sm" onClick={() => setShowUsers(true)}>
            Users
          </button>
        )}
        {can(PERMISSIONS.MANAGE_BACKUPS) && (
          <button type="button" className="btn btn-sm" onClick={() => setShowBackups(true)}>
            Backups
          </button>
        )}
        <button type="button" className="btn btn-sm" onClick={() => setShowChange(true)}>
          Change password
        </button>
        <button type="button" className="btn btn-sm" onClick={logout}>
          Sign out
        </button>
      </div>

      {showUsers && <UserManagement onClose={() => setShowUsers(false)} />}
      {showBackups && <BackupManager onClose={() => setShowBackups(false)} />}
      {showChange && (
        <div style={{ position: 'fixed', inset: 0, zIndex: 1000 }}>
          <ChangePasswordScreen
            forced={false}
            onDone={() => setShowChange(false)}
            onCancel={() => setShowChange(false)}
          />
        </div>
      )}
    </>
  );
}
