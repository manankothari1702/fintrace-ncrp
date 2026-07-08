'use strict';

/**
 * FinTrace NCRP — auth context (Phase 1 Sub-step B).
 *
 * The single object that owns authentication state for one running backend:
 * the session store, the key store (wrapped DEK per user), the DB path, and
 * the current open DB handle. It is passed to the auth routes, the requireAuth
 * middleware (Sub-step C), and the app assembly.
 *
 * Two lifecycles share this one context:
 *   • REAL app (locked start): the DB is NOT opened at boot. `bootstrap()`
 *     guarantees a seeded admin + keystore exist (creating the encrypted DB on
 *     first run, or migrating a legacy plaintext one). `login()` then unlocks
 *     the DEK from the keystore with the user's password, opens the DB, and
 *     holds the handle for the process lifetime. App close = logout (memory
 *     sessions vanish, DB handle dies).
 *   • TEST / in-process (open start): constructed with an already-open `db`
 *     (e.g. the :memory: harness). `login()` then authenticates against the
 *     users table directly (bcrypt) without touching the keystore/DEK — the
 *     DB is already open. This is why the 460 existing tests are unaffected.
 *
 * The DB key is therefore derived from the admin credential (Sub-step A seam
 * fulfilled): on first run the DEK is wrapped under the admin's password, and
 * nothing can open the DB at rest without a valid user password.
 *
 * @module backend/src/auth/authContext
 */

const { initializeDatabase } = require('../db/schema');
const { createSessionStore, hashPassword, verifyPassword, validatePassword } = require('../lib/authStore');
const { createKeystore, keystorePathFor } = require('../lib/keystore');
const { generateDek } = require('../lib/dbKey');
const { ROLES, isValidRole } = require('../lib/roles');
const authQ = require('../db/authQueries');

/** Documented default admin credentials (first run only). The admin is forced
 *  to change this on first login (must_change_password=1). Operators may
 *  override the seed password via FINTRACE_ADMIN_PASSWORD before first run. */
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = 'ChangeMe!2026';

/**
 * @param {object} opts
 * @param {string} [opts.dbPath] - Encrypted DB path (real app). Omit for the
 *   open-db test path.
 * @param {import('better-sqlite3-multiple-ciphers').Database} [opts.db] -
 *   Already-open DB (test/in-process path).
 * @param {string|null} [opts.keystorePath] - Override keystore path. Defaults
 *   to `<dbPath>.keystore.json`, or in-memory (null) when only `db` is given.
 */
function createAuthContext(opts = {}) {
  const dbPath = opts.dbPath || null;
  const keystorePath = opts.keystorePath !== undefined
    ? opts.keystorePath
    : (dbPath ? keystorePathFor(dbPath) : null);

  const sessions = createSessionStore();
  const keystore = createKeystore(keystorePath);
  let db = opts.db || null;

  /** @returns {import('better-sqlite3-multiple-ciphers').Database|null} */
  function getDb() { return db; }
  function isLocked() { return db === null; }

  /**
   * Seed the default admin idempotently and guarantee the app is never in an
   * auth-less state. Safe to call on every boot.
   *
   * @param {object} [o]
   * @param {string} [o.adminPassword] - Override the seed password.
   * @returns {{ seeded: boolean }}
   */
  function bootstrap(o = {}) {
    const adminPassword = o.adminPassword
      || process.env.FINTRACE_ADMIN_PASSWORD
      || DEFAULT_ADMIN_PASSWORD;

    // Open-db path (tests / in-process): seed straight into the given DB.
    if (db) {
      if (authQ.countUsersByRole(db, ROLES.SYSTEM_ADMIN) > 0) return { seeded: false };
      authQ.insertUser(db, {
        username: DEFAULT_ADMIN_USERNAME,
        password_hash: hashPassword(adminPassword),
        role: ROLES.SYSTEM_ADMIN,
        must_change_password: 1,
      });
      return { seeded: true };
    }

    // Locked/real path: if a keystore already exists we are past first run.
    if (keystore.exists()) return { seeded: false };

    // First run (fresh install or upgrading a pre-auth plaintext DB): create
    // the DEK, open/create/migrate the encrypted DB with it, seed the admin,
    // and wrap the DEK under the admin password. Then relock (require login).
    const dek = generateDek();
    const freshDb = initializeDatabase(dbPath, { key: dek });
    try {
      if (authQ.countUsersByRole(freshDb, ROLES.SYSTEM_ADMIN) === 0) {
        authQ.insertUser(freshDb, {
          username: DEFAULT_ADMIN_USERNAME,
          password_hash: hashPassword(adminPassword),
          role: ROLES.SYSTEM_ADMIN,
          must_change_password: 1,
        });
      }
    } finally {
      freshDb.close();
    }
    keystore.addEntry(DEFAULT_ADMIN_USERNAME, dek, adminPassword);
    return { seeded: true };
  }

  /**
   * Authenticate a user and start a session.
   *
   * @param {string} username
   * @param {string} password
   * @returns {{ token: string, user: object }}
   * @throws {Error} with .code = 'INVALID_CREDENTIALS' on any failure (uniform
   *   message — never reveals whether the username exists).
   */
  function login(username, password) {
    const fail = () => {
      const e = new Error('Invalid username or password.');
      e.code = 'INVALID_CREDENTIALS';
      return e;
    };
    if (typeof username !== 'string' || typeof password !== 'string'
        || username === '' || password === '') {
      throw fail();
    }

    let dekHex = null;

    // Locked/real path: unlock the DEK (this validates the password at the
    // at-rest layer) and open the DB.
    if (isLocked()) {
      if (!keystore.hasEntry(username)) throw fail();
      try {
        dekHex = keystore.unlock(username, password);
      } catch (_e) {
        throw fail();
      }
      db = initializeDatabase(dbPath, { key: dekHex });
    }

    // Authoritative credential + role check against the users table.
    const user = authQ.getUserByUsername(db, username);
    if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
      throw fail();
    }

    authQ.updateLastLogin(db, user.id);
    const token = sessions.create({
      userId: user.id,
      username: user.username,
      role: user.role,
      mustChange: !!user.must_change_password, // requireAuth gates on this
      dekHex, // null in the open-db path; the DEK in the locked path
    });
    return { token, user: publicUser(user) };
  }

  /**
   * End a session.
   * @param {string} token
   * @returns {boolean}
   */
  function logout(token) {
    return sessions.destroy(token);
  }

  /**
   * Change the password for the currently-authenticated user, clearing the
   * forced-change flag. Re-wraps the DEK under the new password when a keystore
   * entry exists (locked/real path).
   *
   * @param {object} session - session data from the store (has userId, dekHex).
   * @param {string} oldPassword
   * @param {string} newPassword
   * @returns {object} updated public user
   * @throws {Error} code OLD_PASSWORD_WRONG | WEAK_PASSWORD | SAME_PASSWORD
   */
  function changePassword(session, oldPassword, newPassword) {
    const user = authQ.getUserById(db, session.userId);
    if (!user) { const e = new Error('User not found.'); e.code = 'NOT_FOUND'; throw e; }
    if (!verifyPassword(oldPassword, user.password_hash)) {
      const e = new Error('Current password is incorrect.'); e.code = 'OLD_PASSWORD_WRONG'; throw e;
    }
    if (verifyPassword(newPassword, user.password_hash)) {
      const e = new Error('New password must differ from the current one.'); e.code = 'SAME_PASSWORD'; throw e;
    }
    const check = validatePassword(newPassword);
    if (!check.ok) { const e = new Error(check.errors.join(' ')); e.code = 'WEAK_PASSWORD'; throw e; }

    authQ.updateUserPassword(db, user.id, hashPassword(newPassword), false);
    // Re-wrap the DEK so the keystore entry is unlockable with the new password.
    if (session.dekHex && keystore.hasEntry(user.username)) {
      keystore.addEntry(user.username, session.dekHex, newPassword);
    }
    // Clear the forced-change gate on the live session (requireAuth reads this).
    session.mustChange = false;
    return publicUser(authQ.getUserById(db, user.id));
  }

  /**
   * Create a new user (System-Admin action). Wraps the DEK for the new user
   * when running the locked/real path so they can unlock the DB at login.
   *
   * @param {object} actingSession - the admin's session (source of the DEK).
   * @param {{username:string, role:string, password:string}} spec
   * @returns {object} public user
   * @throws {Error} code USERNAME_TAKEN | INVALID_ROLE | WEAK_PASSWORD | INVALID_USERNAME
   */
  function createUser(actingSession, spec) {
    const username = String(spec.username || '').trim();
    if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
      const e = new Error('Username must be 3–32 chars: letters, digits, . _ -'); e.code = 'INVALID_USERNAME'; throw e;
    }
    if (!isValidRole(spec.role)) { const e = new Error('Unknown role.'); e.code = 'INVALID_ROLE'; throw e; }
    if (authQ.getUserByUsername(db, username)) {
      const e = new Error('That username is already taken.'); e.code = 'USERNAME_TAKEN'; throw e;
    }
    const check = validatePassword(spec.password);
    if (!check.ok) { const e = new Error(check.errors.join(' ')); e.code = 'WEAK_PASSWORD'; throw e; }

    authQ.insertUser(db, {
      username,
      password_hash: hashPassword(spec.password),
      role: spec.role,
      must_change_password: 1,
    });
    if (actingSession && actingSession.dekHex && keystorePath !== null) {
      keystore.addEntry(username, actingSession.dekHex, spec.password);
    }
    return publicUser(authQ.getUserByUsername(db, username));
  }

  return {
    sessions,
    keystore,
    getDb,
    isLocked,
    bootstrap,
    login,
    logout,
    changePassword,
    createUser,
    // exposed for user-management (Sub-step D) + audit wiring (Sub-step C)
    authQ,
  };
}

/** Strip secrets from a user row for API responses. */
function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    must_change_password: !!u.must_change_password,
    is_active: !!u.is_active,
    created_at: u.created_at,
    last_login: u.last_login,
  };
}

module.exports = {
  createAuthContext,
  publicUser,
  DEFAULT_ADMIN_USERNAME,
  DEFAULT_ADMIN_PASSWORD,
};
