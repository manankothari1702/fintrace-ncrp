'use strict';

/**
 * FinTrace NCRP — backup management routes (Phase 1 cross-cutting, clause 6.9).
 *
 * System-Admin-only (requirePermission MANAGE_BACKUPS). Backups are encrypted
 * snapshots (lib/backup — VACUUM INTO inherits the DB key). All routes are
 * path-scoped to /backups so the gate never leaks onto other /api/* routes.
 *
 *   GET  /backups                list snapshots + retention policy
 *   POST /backups                create a snapshot now (+ prune per retention)
 *   POST /backups/restore        restore a named snapshot (requires app restart)
 *
 * @module backend/src/routes/backups
 */

const express = require('express');
const path = require('path');
const { createRequireAuth, createRequirePermission } = require('../middleware/requireAuth');
const { PERMISSIONS } = require('../lib/roles');
const { insertAuditLog } = require('../db/queries');
const {
  createBackup, listBackups, applyRetention, restoreBackup, RETENTION,
} = require('../lib/backup');

/**
 * @param {object} authCtx - from createAuthContext.
 * @returns {import('express').Router}
 */
function createBackupRouter(authCtx) {
  const router = express.Router();
  router.use('/backups', express.json({ limit: '64kb' }));
  router.use('/backups', createRequireAuth(authCtx));
  router.use('/backups', createRequirePermission(PERMISSIONS.MANAGE_BACKUPS));

  const audit = (req, action, details) => {
    const db = authCtx.getDb();
    if (!db) return;
    insertAuditLog(db, {
      action, details,
      user_id: req.user ? req.user.userId : null,
      username: req.user ? req.user.username : null,
    });
  };
  const sendErr = (res, status, code, message) => res.status(status).json({ error: { code, message } });

  const publicItem = (b) => ({ file: b.file, size: b.size, created_at: b.created_at });

  router.get('/backups', (_req, res) => {
    const dir = authCtx.getBackupDir();
    if (!dir) return sendErr(res, 503, 'DB_LOCKED', 'No database is open.');
    return res.json({ backups: listBackups(dir).map(publicItem), retention: RETENTION });
  });

  router.post('/backups', (req, res) => {
    const dir = authCtx.getBackupDir();
    const db = authCtx.getDb();
    if (!dir || !db) return sendErr(res, 503, 'DB_LOCKED', 'No database is open.');
    try {
      const backup = createBackup(db, dir, { key: req.user.dekHex || null });
      const retention = applyRetention(dir);
      audit(req, 'backup.created', { file: backup.file, size: backup.size, pruned: retention.deleted.length });
      return res.status(201).json({ backup: publicItem(backup), retention });
    } catch (err) {
      return sendErr(res, 500, 'BACKUP_FAILED', err.message);
    }
  });

  router.post('/backups/restore', (req, res) => {
    const dir = authCtx.getBackupDir();
    const dbPath = authCtx.getDbPath();
    if (!dir || !dbPath) return sendErr(res, 503, 'DB_LOCKED', 'No database is open.');

    const file = String((req.body || {}).file || '');
    // Only a bare backup filename from our own directory — no path traversal.
    if (!/^fintrace-\d{8}-\d{6}\.db$/.test(file)) {
      return sendErr(res, 400, 'VALIDATION_FAILED', 'Invalid backup filename.');
    }
    const backupPath = path.join(dir, file);
    try {
      // Audit BEFORE swapping the file (the audit row must land in the live DB,
      // not the restored one). Then close+relock so the file can be swapped.
      audit(req, 'backup.restored', { file });
      const key = req.user.dekHex || null;
      authCtx.lockDb(); // closes the live connection and relocks
      const result = restoreBackup(backupPath, dbPath, { key });
      // Every session's DB handle is now stale — force a fresh sign-in, which
      // re-opens the RESTORED file with the credential-derived key.
      authCtx.sessions.destroyAll();
      return res.json({ ...result, note: 'Database restored. Please sign in again.' });
    } catch (err) {
      return sendErr(res, 500, 'RESTORE_FAILED', err.message);
    }
  });

  return router;
}

module.exports = { createBackupRouter };
