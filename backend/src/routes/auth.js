'use strict';

/**
 * FinTrace NCRP — authentication routes (Phase 1 Sub-step B).
 *
 * Mounted at /api/auth. These are the ONLY endpoints reachable without a
 * fully-provisioned session:
 *   POST /auth/login            — credentials → session token
 *   POST /auth/logout           — end the current session
 *   GET  /auth/me               — current user (valid session; must-change OK)
 *   POST /auth/change-password  — change own password (reachable while forced)
 *   GET  /auth/policy           — password policy (for the UI)
 *
 * User-management endpoints (admin) are added in Sub-step D.
 *
 * @module backend/src/routes/auth
 */

const express = require('express');
const { getSession } = require('../middleware/requireAuth');
const { PASSWORD_POLICY } = require('../lib/authStore');
const { publicUser } = require('../auth/authContext');

// Optional login rate-limit (same optional-dep pattern as routes/ncrp.js).
let rateLimit;
try { rateLimit = require('express-rate-limit'); } catch (_e) { rateLimit = () => (_q, _s, n) => n(); }

/**
 * @param {object} authCtx - from createAuthContext.
 * @returns {import('express').Router}
 */
function createAuthRouter(authCtx) {
  const router = express.Router();

  // Throttle credential stuffing: 10 login attempts/min/IP (loopback, so this
  // is really per-machine). Disabled under test to keep the suite deterministic.
  const loginLimiter = process.env.NODE_ENV === 'test'
    ? (_q, _s, n) => n()
    : rateLimit({ windowMs: 60 * 1000, max: 10, standardHeaders: true, legacyHeaders: false });

  router.post('/auth/login', loginLimiter, express.json(), (req, res) => {
    const { username, password } = req.body || {};
    try {
      const { token, user } = authCtx.login(username, password);
      return res.json({ token, user });
    } catch (err) {
      return res.status(401).json({
        error: { code: err.code || 'INVALID_CREDENTIALS', message: err.message },
      });
    }
  });

  router.post('/auth/logout', (req, res) => {
    const resolved = getSession(req, authCtx);
    if (resolved) authCtx.logout(resolved.token);
    return res.json({ ok: true });
  });

  router.get('/auth/me', (req, res) => {
    const resolved = getSession(req, authCtx);
    if (!resolved) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    }
    const db = authCtx.getDb();
    const row = db ? authCtx.authQ.getUserById(db, resolved.session.userId) : null;
    if (!row) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Session no longer valid.' } });
    }
    return res.json({ user: publicUser(row), must_change_password: !!resolved.session.mustChange });
  });

  router.post('/auth/change-password', express.json(), (req, res) => {
    const resolved = getSession(req, authCtx);
    if (!resolved) {
      return res.status(401).json({ error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    }
    const { oldPassword, newPassword } = req.body || {};
    try {
      const user = authCtx.changePassword(resolved.session, oldPassword, newPassword);
      // Clear the forced-change gate on the live session object.
      resolved.session.mustChange = false;
      return res.json({ user });
    } catch (err) {
      const status = err.code === 'OLD_PASSWORD_WRONG' ? 403 : 400;
      return res.status(status).json({ error: { code: err.code || 'CHANGE_FAILED', message: err.message } });
    }
  });

  router.get('/auth/policy', (_req, res) => {
    return res.json({ policy: PASSWORD_POLICY });
  });

  return router;
}

module.exports = { createAuthRouter };
