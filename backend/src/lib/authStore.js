'use strict';

/**
 * FinTrace NCRP — auth primitives (Phase 1 Sub-step B): password policy,
 * password hashing (bcryptjs — pure JS, no native/ABI dependency), and the
 * in-memory session store.
 *
 * Sessions live ONLY in this process's memory (a Map). They are never written
 * to disk, so closing the app = logout. Each session also carries the unlocked
 * DEK (hex) so the process can keep the encrypted DB open for its lifetime
 * without re-deriving it; the DEK never leaves memory.
 *
 * @module backend/src/lib/authStore
 */

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

// ─── Password policy (tunable in one place) ──────────────────────────
const PASSWORD_POLICY = Object.freeze({
  minLength: 10,
  requireLowercase: true,
  requireUppercase: true,
  requireDigit: true,
  requireSymbol: true,
  description:
    'At least 10 characters, including an uppercase letter, a lowercase '
    + 'letter, a digit, and a symbol.',
});

/**
 * Validate a candidate password against {@link PASSWORD_POLICY}.
 *
 * @param {unknown} pw
 * @returns {{ ok: boolean, errors: string[] }}
 */
function validatePassword(pw) {
  const errors = [];
  if (typeof pw !== 'string' || pw.length === 0) {
    return { ok: false, errors: ['Password is required.'] };
  }
  if (pw.length < PASSWORD_POLICY.minLength) {
    errors.push(`Must be at least ${PASSWORD_POLICY.minLength} characters.`);
  }
  if (PASSWORD_POLICY.requireLowercase && !/[a-z]/.test(pw)) {
    errors.push('Must include a lowercase letter.');
  }
  if (PASSWORD_POLICY.requireUppercase && !/[A-Z]/.test(pw)) {
    errors.push('Must include an uppercase letter.');
  }
  if (PASSWORD_POLICY.requireDigit && !/[0-9]/.test(pw)) {
    errors.push('Must include a digit.');
  }
  if (PASSWORD_POLICY.requireSymbol && !/[^A-Za-z0-9]/.test(pw)) {
    errors.push('Must include a symbol.');
  }
  return { ok: errors.length === 0, errors };
}

// ─── Password hashing (bcryptjs) ─────────────────────────────────────
const BCRYPT_ROUNDS = 12;

/** @param {string} pw @returns {string} bcrypt hash */
function hashPassword(pw) {
  return bcrypt.hashSync(pw, BCRYPT_ROUNDS);
}

/** @param {string} pw @param {string} hash @returns {boolean} */
function verifyPassword(pw, hash) {
  try {
    return bcrypt.compareSync(pw, hash);
  } catch (_e) {
    return false;
  }
}

// ─── Session store (in-memory only) ──────────────────────────────────

/** Idle timeout — a session unused this long is treated as expired. Generous
 *  by design (a desktop investigator session); app close clears everything. */
const SESSION_IDLE_MS = 12 * 60 * 60 * 1000; // 12h

/**
 * Create an isolated in-memory session store. One per app instance so tests
 * (and, later, multiple windows) never share session state.
 *
 * @returns {{
 *   create: (data: object) => string,
 *   get: (token: string) => object|null,
 *   destroy: (token: string) => boolean,
 *   destroyAll: () => void,
 *   size: () => number,
 * }}
 */
function createSessionStore() {
  /** @type {Map<string, { data: object, createdAt: number, lastSeen: number }>} */
  const sessions = new Map();

  return {
    /**
     * @param {object} data - { userId, username, role, dekHex? }
     * @returns {string} opaque session token
     */
    create(data) {
      const token = crypto.randomBytes(32).toString('hex');
      const now = Date.now();
      sessions.set(token, { data: { ...data }, createdAt: now, lastSeen: now });
      return token;
    },
    /**
     * @param {string} token
     * @returns {object|null} the session data, or null if unknown/expired
     */
    get(token) {
      const entry = sessions.get(token);
      if (!entry) return null;
      if (Date.now() - entry.lastSeen > SESSION_IDLE_MS) {
        sessions.delete(token);
        return null;
      }
      entry.lastSeen = Date.now();
      return entry.data;
    },
    destroy(token) {
      return sessions.delete(token);
    },
    destroyAll() {
      sessions.clear();
    },
    size() {
      return sessions.size;
    },
  };
}

module.exports = {
  PASSWORD_POLICY,
  validatePassword,
  hashPassword,
  verifyPassword,
  BCRYPT_ROUNDS,
  SESSION_IDLE_MS,
  createSessionStore,
};
