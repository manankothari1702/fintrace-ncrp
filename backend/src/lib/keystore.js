'use strict';

/**
 * FinTrace NCRP — key store (Phase 1 Sub-step B).
 *
 * Holds the DB's Data Encryption Key (DEK) WRAPPED once per user under that
 * user's password (AES-256-GCM via lib/dbKey). Lives in a sidecar file next
 * to the DB (`<db>.keystore.json`) — deliberately OUTSIDE the encrypted DB,
 * because you need it to derive the key that opens the DB (chicken-and-egg).
 * The file only ever contains wrapped blobs + salts; the DEK and passwords
 * are never written.
 *
 *   unlock(username, password) → PBKDF2(password,salt) → AES-GCM-decrypt → DEK
 *
 * A wrong password fails the GCM auth tag, so unlock throws — that IS the
 * at-rest credential gate. Every user's entry wraps the SAME DEK, so any
 * authorised user opens the same database.
 *
 * Pass keystorePath=null for an in-memory store (used by the :memory: test
 * harness, where there is no file and the DB is already open).
 *
 * @module backend/src/lib/keystore
 */

const fs = require('fs');
const path = require('path');
const { wrapDek, unwrapDek } = require('./dbKey');

const KEYSTORE_VERSION = 1;

/**
 * @param {string} dbPath
 * @returns {string} sidecar path
 */
function keystorePathFor(dbPath) {
  return `${dbPath}.keystore.json`;
}

/**
 * Create a keystore bound to a file (or in-memory when path is null).
 *
 * @param {string|null} keystorePath
 */
function createKeystore(keystorePath) {
  /** @type {{version:number, entries:Record<string,object>}} */
  let mem = null; // in-memory cache / store

  function load() {
    if (keystorePath === null) {
      if (!mem) mem = { version: KEYSTORE_VERSION, entries: {} };
      return mem;
    }
    try {
      const raw = fs.readFileSync(keystorePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed.entries) parsed.entries = {};
      return parsed;
    } catch (_e) {
      return { version: KEYSTORE_VERSION, entries: {} };
    }
  }

  function save(store) {
    if (keystorePath === null) { mem = store; return; }
    fs.mkdirSync(path.dirname(keystorePath), { recursive: true });
    fs.writeFileSync(keystorePath, JSON.stringify(store, null, 2), { mode: 0o600 });
  }

  return {
    /** @returns {boolean} true if at least one user entry exists */
    exists() {
      const s = load();
      return Object.keys(s.entries).length > 0;
    },
    /** @param {string} username @returns {boolean} */
    hasEntry(username) {
      return Object.prototype.hasOwnProperty.call(load().entries, username);
    },
    /** @returns {string[]} */
    usernames() {
      return Object.keys(load().entries);
    },
    /**
     * Wrap the DEK under this user's password and store it (overwrites any
     * existing entry — also used to re-wrap on password change).
     * @param {string} username @param {string} dekHex @param {string} password
     */
    addEntry(username, dekHex, password) {
      const s = load();
      s.entries[username] = wrapDek(dekHex, password);
      save(s);
    },
    /**
     * Recover the DEK for a user given the password. Throws if the entry is
     * missing or the password is wrong (GCM tag mismatch).
     * @param {string} username @param {string} password @returns {string} dekHex
     */
    unlock(username, password) {
      const s = load();
      const entry = s.entries[username];
      if (!entry) throw new Error('keystore: no entry for user');
      return unwrapDek(entry, password);
    },
    /** @param {string} username @returns {boolean} removed? */
    removeEntry(username) {
      const s = load();
      if (!s.entries[username]) return false;
      delete s.entries[username];
      save(s);
      return true;
    },
    /** @param {string} oldName @param {string} newName */
    renameEntry(oldName, newName) {
      const s = load();
      if (!s.entries[oldName]) return false;
      s.entries[newName] = s.entries[oldName];
      delete s.entries[oldName];
      save(s);
      return true;
    },
  };
}

module.exports = { createKeystore, keystorePathFor, KEYSTORE_VERSION };
