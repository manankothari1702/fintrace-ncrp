'use strict';

/**
 * FinTrace NCRP — user/auth table queries (Phase 1 Sub-step B).
 *
 * Small, synchronous helpers over the `users` table. Kept separate from
 * queries.js (NCRP domain data) so the auth surface is self-contained.
 * All statements use bound parameters — no string concatenation of input.
 *
 * @module backend/src/db/authQueries
 */

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {string} username
 * @returns {object|undefined} user row
 */
function getUserByUsername(db, username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} id
 * @returns {object|undefined}
 */
function getUserById(db, id) {
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @returns {number}
 */
function countUsers(db) {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {string} role
 * @returns {number}
 */
function countUsersByRole(db, role) {
  return db.prepare('SELECT COUNT(*) AS n FROM users WHERE role = ?').get(role).n;
}

/**
 * Insert a user. Caller supplies an already-hashed password.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {{username:string, password_hash:string, role:string,
 *   must_change_password?:boolean|number, is_active?:boolean|number}} u
 * @returns {number} new user id
 */
function insertUser(db, u) {
  const info = db.prepare(`
    INSERT INTO users (username, password_hash, role, must_change_password, is_active)
    VALUES (@username, @password_hash, @role, @must_change_password, @is_active)
  `).run({
    username: u.username,
    password_hash: u.password_hash,
    role: u.role,
    must_change_password: u.must_change_password ? 1 : 0,
    is_active: u.is_active === undefined ? 1 : (u.is_active ? 1 : 0),
  });
  return Number(info.lastInsertRowid);
}

/**
 * Update a user's password hash and clear/set the must_change flag.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} id
 * @param {string} passwordHash
 * @param {boolean} [mustChange=false]
 * @returns {number} rows affected
 */
function updateUserPassword(db, id, passwordHash, mustChange = false) {
  return db.prepare(`
    UPDATE users SET password_hash = @h, must_change_password = @m WHERE id = @id
  `).run({ h: passwordHash, m: mustChange ? 1 : 0, id }).changes;
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} id
 * @returns {number} rows affected
 */
function updateLastLogin(db, id) {
  return db.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').run(id).changes;
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} id
 * @param {string} role
 * @returns {number} rows affected
 */
function updateUserRole(db, id, role) {
  return db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id).changes;
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} id
 * @param {boolean} isActive
 * @returns {number} rows affected
 */
function setUserActive(db, id, isActive) {
  return db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, id).changes;
}

/**
 * List users (no password hashes) for the admin management screen.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @returns {Array<object>}
 */
function listUsers(db) {
  return db.prepare(`
    SELECT id, username, role, must_change_password, is_active, created_at, last_login
      FROM users ORDER BY id ASC
  `).all();
}

module.exports = {
  getUserByUsername,
  getUserById,
  countUsers,
  countUsersByRole,
  insertUser,
  updateUserPassword,
  updateLastLogin,
  updateUserRole,
  setUserActive,
  listUsers,
};
