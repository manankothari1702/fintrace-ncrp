/**
 * AuthBar (Phase 1 Sub-step D) — a slim strip above the app shell. Account and
 * admin actions are consolidated into a single profile dropdown (name + role +
 * user icon) instead of a row of flat buttons. The menu holds self-service
 * password change, and — for the roles that hold the permission — user
 * management and backups, with sign-out separated at the bottom. Rendered by the
 * AuthGate so NONE of the off-limits shell code (src/shell) is touched.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import { PERMISSIONS, roleLabel } from './permissions.js';
import UserManagement from './UserManagement.jsx';
import BackupManager from './BackupManager.jsx';
import ChangePasswordScreen from './ChangePasswordScreen.jsx';
import './auth.css';

export default function AuthBar() {
  const { user, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const [showUsers, setShowUsers] = useState(false);
  const [showBackups, setShowBackups] = useState(false);
  const [showChange, setShowChange] = useState(false);
  const menuRef = useRef(null);
  const triggerRef = useRef(null);

  const close = useCallback(() => setOpen(false), []);

  // Click-outside + Esc close the menu (mirrors the bank-more-popover pattern).
  // Esc also returns focus to the trigger; opening focuses the first item.
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target)
        && triggerRef.current && !triggerRef.current.contains(e.target)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    menuRef.current?.querySelector('[role="menuitem"]')?.focus();
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!user) return null;

  // Run a menu action then collapse the dropdown.
  const pick = (fn) => () => { setOpen(false); fn(); };

  return (
    <>
      <div className="auth-bar">
        <span className="spacer" />
        <div className="auth-menu" ref={menuRef}>
          <button
            type="button"
            ref={triggerRef}
            className="auth-profile-btn"
            aria-haspopup="menu"
            aria-expanded={open}
            aria-label={`Account menu for ${user.username}`}
            onClick={() => setOpen((o) => !o)}
          >
            <span aria-hidden="true">👤</span>
            <span className="auth-profile-name">
              <strong>{user.username}</strong>
              <span className="auth-role">{roleLabel(user.role)}</span>
            </span>
            <span className="auth-caret" aria-hidden="true">▾</span>
          </button>

          {open && (
            <div className="auth-menu-popover" role="menu" aria-label="Account menu">
              <button
                type="button"
                role="menuitem"
                className="auth-menu-item"
                onClick={pick(() => setShowChange(true))}
              >
                Change password
              </button>
              {can(PERMISSIONS.MANAGE_USERS) && (
                <button
                  type="button"
                  role="menuitem"
                  className="auth-menu-item"
                  onClick={pick(() => setShowUsers(true))}
                >
                  Users
                </button>
              )}
              {can(PERMISSIONS.MANAGE_BACKUPS) && (
                <button
                  type="button"
                  role="menuitem"
                  className="auth-menu-item"
                  onClick={pick(() => setShowBackups(true))}
                >
                  Backups
                </button>
              )}
              <div className="auth-menu-sep" role="separator" />
              <button
                type="button"
                role="menuitem"
                className="auth-menu-item auth-menu-danger"
                onClick={pick(logout)}
              >
                Sign out
              </button>
            </div>
          )}
        </div>
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
