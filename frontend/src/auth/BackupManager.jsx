/**
 * BackupManager (Phase 1 cross-cutting) — System-Admin-only modal.
 *
 * List encrypted DB snapshots, create one on demand, and restore. Backups are
 * encrypted with the same key as the live DB (backend VACUUM INTO); the backend
 * re-checks MANAGE_BACKUPS. Restore signs everyone out (the DB file is swapped),
 * so the UI warns and then returns to the login screen.
 */

import { useEffect, useState, useCallback } from 'react';
import { useAuth } from '../context/AuthContext.jsx';
import {
  getBackups, createBackupNow, restoreBackup, friendlyErrorMessage,
} from '../utils/api.js';
import './auth.css';

function fmtSize(bytes) {
  if (!bytes) return '—';
  const kb = bytes / 1024;
  return kb < 1024 ? `${kb.toFixed(0)} KB` : `${(kb / 1024).toFixed(1)} MB`;
}

export default function BackupManager({ onClose }) {
  const { logout } = useAuth();
  const [backups, setBackups] = useState([]);
  const [retention, setRetention] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try { const r = await getBackups(); setBackups(r.backups); setRetention(r.retention); setError(null); } catch (err) {
      setError(friendlyErrorMessage(err) || err.message);
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  const onBackupNow = async () => {
    setBusy(true);
    try { await createBackupNow(); await refresh(); setError(null); } catch (err) {
      setError(friendlyErrorMessage(err) || err.message);
    } finally { setBusy(false); }
  };

  const onRestore = async (file) => {
    if (!window.confirm(`Restore "${file}"? This replaces the current database and signs everyone out.`)) return;
    setBusy(true);
    try {
      await restoreBackup(file);
      // The DB was swapped and sessions destroyed — return to login.
      await logout();
    } catch (err) {
      setError(friendlyErrorMessage(err) || err.message);
      setBusy(false);
    }
  };

  return (
    <div className="um-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="um-modal" role="dialog" aria-modal="true" aria-label="Backups">
        <div className="um-head">
          <h2>Backups</h2>
          <button type="button" className="btn btn-sm" onClick={onClose}>✕ Close</button>
        </div>

        {error && <div className="auth-error" role="alert">{error}</div>}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
          <button type="button" className="btn btn-primary" onClick={onBackupNow} disabled={busy}>
            {busy ? 'Working…' : 'Back up now'}
          </button>
          {retention && (
            <span className="auth-policy" style={{ margin: 0 }}>
              Keeps {retention.daily} daily, {retention.weekly} weekly, {retention.monthly} monthly. Backups are encrypted.
            </span>
          )}
        </div>

        {loading ? (
          <p style={{ color: 'var(--text-muted)' }}>Loading backups…</p>
        ) : backups.length === 0 ? (
          <p style={{ color: 'var(--text-muted)' }}>No backups yet. One is created automatically on first sign-in each day.</p>
        ) : (
          <table className="um-table">
            <thead><tr><th>Snapshot</th><th>Size</th><th>Created</th><th>Actions</th></tr></thead>
            <tbody>
              {backups.map((b) => (
                <tr key={b.file}>
                  <td style={{ fontFamily: 'var(--font-mono)' }}>{b.file}</td>
                  <td>{fmtSize(b.size)}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{new Date(b.created_at).toLocaleString()}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => onRestore(b.file)} disabled={busy}>
                      Restore
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
