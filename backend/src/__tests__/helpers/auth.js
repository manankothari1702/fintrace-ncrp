'use strict';

/**
 * Test helper: authenticate against the REAL auth path (Sub-step C).
 *
 * The route protection added in Sub-step C means every /api/ncrp/* request now
 * needs a valid session. Tests must therefore authenticate — NOT bypass auth.
 * These helpers seed a user of the desired role (with must_change cleared so it
 * can immediately use the app), perform a real POST /api/auth/login, and return
 * a token; `authed(app, token)` wraps supertest so existing `agent.get/post/...`
 * calls carry the Authorization header unchanged.
 *
 * @module backend/src/__tests__/helpers/auth
 */

const request = require('supertest');
const { hashPassword } = require('../../lib/authStore');
const { ROLES } = require('../../lib/roles');
const authQ = require('../../db/authQueries');

const TEST_PASSWORD = 'TestPass!2026';

/**
 * Ensure a user with the given role exists (password TEST_PASSWORD, no forced
 * change). Inserts directly so a role's fixture is deterministic; login itself
 * still goes through the real auth path.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {string} username
 * @param {string} role
 * @returns {object} user row
 */
function ensureUser(db, username, role) {
  let u = authQ.getUserByUsername(db, username);
  if (!u) {
    authQ.insertUser(db, {
      username,
      password_hash: hashPassword(TEST_PASSWORD),
      role,
      must_change_password: 0,
    });
    u = authQ.getUserByUsername(db, username);
  }
  return u;
}

/**
 * Seed (if needed) + log in a user of `role`, returning the session token.
 * Requires an app built via createApp(db) (exposes app.locals.authContext with
 * an open DB).
 *
 * @param {import('express').Express} app
 * @param {string} [role=system_admin]
 * @param {string} [username]
 * @returns {Promise<string>} session token
 */
async function loginAs(app, role = ROLES.SYSTEM_ADMIN, username) {
  const ctx = app.locals.authContext;
  if (!ctx) throw new Error('loginAs: app has no authContext (build with createApp(db))');
  const db = ctx.getDb();
  if (!db) throw new Error('loginAs: authContext DB is not open');
  const uname = username || `test_${role}`;
  ensureUser(db, uname, role);
  const res = await request(app).post('/api/auth/login').send({ username: uname, password: TEST_PASSWORD });
  if (res.status !== 200) {
    throw new Error(`loginAs: login failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  return res.body.token;
}

/**
 * Wrap supertest so method calls carry the bearer token — a drop-in for
 * `agent = request(app)` (`agent.get/post/put/delete` unchanged; `.attach`,
 * `.query`, `.send` all chain).
 *
 * @param {import('express').Express} app
 * @param {string} token
 */
function authed(app, token) {
  const h = { Authorization: `Bearer ${token}` };
  return {
    get: (u) => request(app).get(u).set(h),
    post: (u) => request(app).post(u).set(h),
    put: (u) => request(app).put(u).set(h),
    delete: (u) => request(app).delete(u).set(h),
    options: (u) => request(app).options(u).set(h),
  };
}

module.exports = {
  TEST_PASSWORD, ensureUser, loginAs, authed,
};
