'use strict';

/**
 * FinTrace NCRP — authentication choke-point (Phase 1 Sub-step B).
 *
 * THE single place route protection funnels through. Sub-step C applies this
 * (plus a permission check) to every /api/ncrp/* route; a future LAN mode
 * swaps ONLY this layer for JWT without touching any route. Nothing else may
 * validate sessions.
 *
 * Extracts the session token from `Authorization: Bearer <token>` (or the
 * `X-Session-Token` header), validates it against the in-memory session store,
 * attaches `req.user`, and — because a forced-password-change user must not
 * reach any real functionality — rejects with 403 PASSWORD_CHANGE_REQUIRED
 * until they change it (the change-password endpoint uses {@link getSession}
 * directly, so it stays reachable).
 *
 * @module backend/src/middleware/requireAuth
 */

/**
 * Pull the bearer/session token off a request, or null.
 * @param {import('express').Request} req
 * @returns {string|null}
 */
function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim();
  const x = req.headers['x-session-token'];
  if (typeof x === 'string' && x.trim() !== '') return x.trim();
  return null;
}

/**
 * Resolve the session for a request without enforcing the must-change gate.
 * Used by the auth routes (logout / me / change-password).
 *
 * @param {import('express').Request} req
 * @param {object} authCtx
 * @returns {{ token: string, session: object }|null}
 */
function getSession(req, authCtx) {
  const token = extractToken(req);
  if (!token) return null;
  const session = authCtx.sessions.get(token);
  if (!session) return null;
  return { token, session };
}

/**
 * Build the auth-enforcing middleware bound to an auth context.
 *
 * @param {object} authCtx - from createAuthContext.
 * @returns {import('express').RequestHandler}
 */
function createRequireAuth(authCtx) {
  return function requireAuth(req, res, next) {
    const resolved = getSession(req, authCtx);
    if (!resolved) {
      return res.status(401).json({
        error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' },
      });
    }
    if (resolved.session.mustChange) {
      return res.status(403).json({
        error: {
          code: 'PASSWORD_CHANGE_REQUIRED',
          message: 'You must change your password before continuing.',
        },
      });
    }
    req.user = resolved.session;
    req.sessionToken = resolved.token;
    return next();
  };
}

module.exports = { createRequireAuth, getSession, extractToken };
