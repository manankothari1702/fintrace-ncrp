'use strict';

/**
 * FinTrace NCRP — user management routes (Phase 1 Sub-step C).
 *
 * Mounted at /api/users. EVERY route is System-Admin-only: they funnel through
 * the requireAuth choke-point plus requirePermission(MANAGE_USERS), so the
 * permission map (lib/roles.js) is the single place that decides who may
 * manage users. The screens that drive these land in Sub-step D.
 *
 *   GET    /users               list users (no hashes)
 *   POST   /users               create a user (temp password, must-change)
 *   PUT    /users/:id/role      change a user's role
 *   PUT    /users/:id/active    activate / deactivate
 *   POST   /users/:id/reset-password  set a new temp password (force change)
 *
 * @module backend/src/routes/users
 */

const express = require('express');
const { createRequireAuth, createRequirePermission } = require('../middleware/requireAuth');
const { PERMISSIONS } = require('../lib/roles');
const { insertAuditLog } = require('../db/queries');

/**
 * @param {object} authCtx - from createAuthContext.
 * @returns {import('express').Router}
 */
function createUserRouter(authCtx) {
  const router = express.Router();
  // Scope ALL middleware to the /users path prefix. The router is mounted at
  // '/api', so an unscoped router.use(...) would intercept every /api/* request
  // (health, /ncrp/*, /auth/*) — not what we want. Path-scoping keeps the
  // auth + MANAGE_USERS gate on user-management endpoints only.
  router.use('/users', express.json({ limit: '256kb' }));
  router.use('/users', createRequireAuth(authCtx));
  router.use('/users', createRequirePermission(PERMISSIONS.MANAGE_USERS));

  const audit = (req, action, details) => {
    const db = authCtx.getDb();
    if (!db) return;
    insertAuditLog(db, {
      action,
      details,
      user_id: req.user ? req.user.userId : null,
      username: req.user ? req.user.username : null,
    });
  };

  const parseId = (raw) => {
    const n = Number(raw);
    return Number.isInteger(n) && n > 0 ? n : null;
  };
  const sendErr = (res, status, code, message) => res.status(status).json({ error: { code, message } });

  router.get('/users', (_req, res) => {
    res.json({ users: authCtx.listUsers() });
  });

  router.post('/users', (req, res) => {
    const { username, role, password } = req.body || {};
    try {
      const user = authCtx.createUser(req.user, { username, role, password });
      audit(req, 'user.created', { username: user.username, role: user.role });
      res.status(201).json({ user });
    } catch (err) {
      sendErr(res, 400, err.code || 'CREATE_FAILED', err.message);
    }
  });

  router.put('/users/:id/role', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return sendErr(res, 400, 'VALIDATION_FAILED', 'Invalid user id.');
    try {
      const user = authCtx.setUserRole(req.user, id, (req.body || {}).role);
      audit(req, 'user.role_changed', { id, role: user.role });
      return res.json({ user });
    } catch (err) {
      const status = err.code === 'NOT_FOUND' ? 404 : (err.code === 'LAST_ADMIN' ? 409 : 400);
      return sendErr(res, status, err.code || 'UPDATE_FAILED', err.message);
    }
  });

  router.put('/users/:id/active', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return sendErr(res, 400, 'VALIDATION_FAILED', 'Invalid user id.');
    const active = !!(req.body || {}).active;
    try {
      const user = authCtx.setUserActive(req.user, id, active);
      audit(req, active ? 'user.activated' : 'user.deactivated', { id });
      return res.json({ user });
    } catch (err) {
      const status = err.code === 'NOT_FOUND' ? 404 : (err.code === 'LAST_ADMIN' ? 409 : 400);
      return sendErr(res, status, err.code || 'UPDATE_FAILED', err.message);
    }
  });

  router.post('/users/:id/reset-password', (req, res) => {
    const id = parseId(req.params.id);
    if (!id) return sendErr(res, 400, 'VALIDATION_FAILED', 'Invalid user id.');
    try {
      const user = authCtx.resetUserPassword(req.user, id, (req.body || {}).newPassword);
      audit(req, 'user.password_reset', { id });
      return res.json({ user });
    } catch (err) {
      const status = err.code === 'NOT_FOUND' ? 404 : 400;
      return sendErr(res, status, err.code || 'RESET_FAILED', err.message);
    }
  });

  return router;
}

module.exports = { createUserRouter };
