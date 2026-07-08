'use strict';

/**
 * FinTrace NCRP — database encryption key derivation (SQLCipher, Sub-step A).
 *
 * The at-rest database is encrypted with SQLCipher (via
 * better-sqlite3-multiple-ciphers). The raw 256-bit key handed to
 * `PRAGMA key` is DERIVED from a credential + a per-install salt — never
 * hardcoded and never stored on disk in the clear.
 *
 * ── Key flow (and the Sub-step B seam) ─────────────────────────────────
 *
 *   credential secret ──PBKDF2(salt)──▶ 32-byte raw key ──▶ PRAGMA key="x'…'"
 *
 * • The SALT is a random 16 bytes persisted next to the DB in a sidecar file
 *   (`<db>.salt`). It is not secret; it only ensures the derived key is unique
 *   per install so two machines with the same credential get different keys.
 *
 * • The CREDENTIAL SECRET is the single thing Sub-step B replaces. Today
 *   (auth does not exist yet) it comes from {@link getCredentialSecret}:
 *   the FINTRACE_DB_KEY env var, or a documented bootstrap default so the
 *   dev app runs out of the box. Sub-step B will instead pass the secret it
 *   derives from the authenticated admin's password — the DB will then open
 *   only AFTER a successful admin login, and `PRAGMA rekey` re-derives when
 *   the admin changes password. Nothing else in the chain changes: callers
 *   already funnel through {@link resolveDbKey}, and the schema layer already
 *   accepts an explicit key, so wiring B in is a one-call swap here.
 *
 * The derived key is expressed as 64 hex chars and applied with SQLCipher's
 * raw-key form (`PRAGMA key = "x'…'"`), which bypasses SQLCipher's own KDF —
 * we have already stretched the credential with PBKDF2, and the raw form
 * avoids passphrase-escaping pitfalls.
 *
 * @module backend/src/lib/dbKey
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/** PBKDF2 parameters. Tunable in one place; changing them re-derives the key
 *  (which for an existing DB means a rekey — see Sub-step B). */
const KDF = Object.freeze({
  iterations: 210000,      // OWASP 2023 floor for PBKDF2-HMAC-SHA256
  keyLenBytes: 32,         // 256-bit SQLCipher key
  digest: 'sha256',
  saltLenBytes: 16,
});

/**
 * Bootstrap credential secret used to derive the DB key BEFORE auth exists
 * (Sub-step A). Sub-step B supersedes this with the admin-password-derived
 * secret and this default becomes unreachable in the real login flow.
 *
 * Documented default (dev / first boot): the app must run without manual
 * setup, so absent an env override we use a fixed bootstrap phrase. This is
 * NOT a security boundary on its own — the security boundary is the OS file
 * ACL on %APPDATA% plus (from Sub-step B) the admin password. Operators who
 * want a machine-specific key before B can set FINTRACE_DB_KEY.
 *
 * @returns {string}
 */
function getCredentialSecret() {
  const fromEnv = process.env.FINTRACE_DB_KEY;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv.trim();
  // Sub-step A bootstrap default. Replaced by the admin credential in B.
  return 'fintrace-bootstrap-v1';
}

/**
 * Path of the salt sidecar for a given DB file.
 * @param {string} dbPath
 * @returns {string}
 */
function saltPathFor(dbPath) {
  return `${dbPath}.salt`;
}

/**
 * Load the per-install salt sitting next to the DB, creating it (16 random
 * bytes, hex) on first run. The salt is not secret.
 *
 * @param {string} dbPath - Absolute DB file path (never ':memory:').
 * @returns {string} salt as hex.
 */
function loadOrCreateSalt(dbPath) {
  const sp = saltPathFor(dbPath);
  try {
    const existing = fs.readFileSync(sp, 'utf8').trim();
    if (/^[0-9a-f]{32,}$/i.test(existing)) return existing;
  } catch (_e) {
    /* missing / unreadable → create below */
  }
  const salt = crypto.randomBytes(KDF.saltLenBytes).toString('hex');
  fs.mkdirSync(path.dirname(sp), { recursive: true });
  // 0o600 where supported; on Windows the ACL on %APPDATA% is the real guard.
  fs.writeFileSync(sp, salt, { encoding: 'utf8', mode: 0o600 });
  return salt;
}

/**
 * Derive the 32-byte SQLCipher key (hex) from a credential secret + salt.
 *
 * @param {string} secret - Credential secret (bootstrap now; admin-derived in B).
 * @param {string} saltHex - Per-install salt (hex), from {@link loadOrCreateSalt}.
 * @returns {string} 64-char hex key for the raw-key PRAGMA.
 */
function deriveDbKey(secret, saltHex) {
  if (typeof secret !== 'string' || secret === '') {
    throw new TypeError('deriveDbKey: secret must be a non-empty string');
  }
  if (typeof saltHex !== 'string' || saltHex === '') {
    throw new TypeError('deriveDbKey: saltHex must be a non-empty string');
  }
  const salt = Buffer.from(saltHex, 'hex');
  const key = crypto.pbkdf2Sync(secret, salt, KDF.iterations, KDF.keyLenBytes, KDF.digest);
  return key.toString('hex');
}

/**
 * Resolve the DB key for a file path: load/create its salt, derive from the
 * given (or bootstrap) credential secret. This is the ONE call the server and
 * (later) the auth layer use — Sub-step B just passes the admin-derived secret.
 *
 * @param {string} dbPath - Absolute DB file path.
 * @param {string} [secret] - Credential secret; defaults to {@link getCredentialSecret}.
 * @returns {string} 64-char hex key.
 */
function resolveDbKey(dbPath, secret) {
  const salt = loadOrCreateSalt(dbPath);
  return deriveDbKey(secret || getCredentialSecret(), salt);
}

/**
 * Apply a derived key to an open SQLCipher connection using the raw-key form.
 * MUST be the first statement on the connection, before any other pragma/DDL.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {string} keyHex - 64-char hex key.
 */
function applyKey(db, keyHex) {
  if (!/^[0-9a-f]{64}$/i.test(keyHex)) {
    throw new TypeError('applyKey: keyHex must be 64 hex characters (256-bit)');
  }
  db.pragma(`key="x'${keyHex}'"`);
}

// ─── Envelope encryption of the DB key (Sub-step B) ──────────────────
//
// Auth ties DB access to a credential without ever storing the DB key in the
// clear. A single random 256-bit Data Encryption Key (DEK) encrypts the DB.
// Per user, the DEK is WRAPPED (AES-256-GCM) under a Key-Encryption-Key
// derived from that user's password + a per-user salt, and the wrapped blob
// lives in a keystore sidecar OUTSIDE the encrypted DB (lib/authStore.js).
//
//   login: KEK = PBKDF2(password, userSalt) → AES-GCM-decrypt(wrapped) → DEK
//          → PRAGMA key = DEK → DB opens (wrong password ⇒ GCM tag fails)
//
// So every authorised user unlocks the SAME DEK; the admin password is no
// longer a hardcoded/bootstrap secret — it is the credential the key derives
// from. New users (Sub-step D) get the DEK re-wrapped under their password.

/** Generate a fresh random 256-bit DEK as 64 hex chars. */
function generateDek() {
  return crypto.randomBytes(KDF.keyLenBytes).toString('hex');
}

/**
 * Wrap (encrypt) a DEK under a password. Returns everything needed to unwrap
 * except the password: a fresh salt, IV, ciphertext, and GCM auth tag (all hex).
 *
 * @param {string} dekHex - 64-char hex DEK to protect.
 * @param {string} password - Credential the wrap is bound to.
 * @returns {{salt:string, iv:string, ct:string, tag:string}}
 */
function wrapDek(dekHex, password) {
  if (!/^[0-9a-f]{64}$/i.test(dekHex)) {
    throw new TypeError('wrapDek: dekHex must be 64 hex characters');
  }
  const salt = crypto.randomBytes(KDF.saltLenBytes);
  const kek = crypto.pbkdf2Sync(password, salt, KDF.iterations, KDF.keyLenBytes, KDF.digest);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(dekHex, 'hex')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    salt: salt.toString('hex'),
    iv: iv.toString('hex'),
    ct: ct.toString('hex'),
    tag: tag.toString('hex'),
  };
}

/**
 * Unwrap a DEK using the password. Throws if the password is wrong (the GCM
 * auth tag will not verify) or the blob is malformed.
 *
 * @param {{salt:string, iv:string, ct:string, tag:string}} wrapped
 * @param {string} password
 * @returns {string} 64-char hex DEK.
 */
function unwrapDek(wrapped, password) {
  if (!wrapped || !wrapped.salt || !wrapped.iv || !wrapped.ct || !wrapped.tag) {
    throw new TypeError('unwrapDek: malformed wrapped-key blob');
  }
  const kek = crypto.pbkdf2Sync(
    password, Buffer.from(wrapped.salt, 'hex'),
    KDF.iterations, KDF.keyLenBytes, KDF.digest,
  );
  const decipher = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(wrapped.iv, 'hex'));
  decipher.setAuthTag(Buffer.from(wrapped.tag, 'hex'));
  const out = Buffer.concat([decipher.update(Buffer.from(wrapped.ct, 'hex')), decipher.final()]);
  return out.toString('hex');
}

module.exports = {
  KDF,
  getCredentialSecret,
  saltPathFor,
  loadOrCreateSalt,
  deriveDbKey,
  resolveDbKey,
  applyKey,
  generateDek,
  wrapDek,
  unwrapDek,
};
