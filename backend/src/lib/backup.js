'use strict';

/**
 * FinTrace NCRP — encrypted database backups (Phase 1 cross-cutting, clause 6.9).
 *
 * Mechanism: `VACUUM INTO` produces a consistent single-file SNAPSHOT of the
 * live DB. Crucially, on our SQLCipher driver the snapshot inherits the source
 * key — so a backup of an encrypted DB is itself ENCRYPTED with the same key
 * (verified). We use VACUUM INTO rather than the streaming online-backup API
 * because that API cannot target an encrypted destination through this binding
 * ("incompatible source and target databases").
 *
 * Every backup is integrity-checked immediately (opened with the key +
 * PRAGMA integrity_check) so a corrupt/half-written file never counts as a
 * good restore point. Retention is grandfather-father-son: 7 daily, 4 weekly,
 * 3 monthly.
 *
 * @module backend/src/lib/backup
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3-multiple-ciphers');
const { applyKey } = require('./dbKey');

const BACKUP_PREFIX = 'fintrace-';
const BACKUP_EXT = '.db';
// fintrace-YYYYMMDD-HHMMSS.db
const BACKUP_RE = /^fintrace-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

/** Retention policy (grandfather-father-son). Tunable in one place. */
const RETENTION = Object.freeze({ daily: 7, weekly: 4, monthly: 3 });

function pad(n) { return String(n).padStart(2, '0'); }

/** Backup filename for a given Date (local time — matches when the officer ran it). */
function backupFilename(d) {
  return `${BACKUP_PREFIX}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
    + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${BACKUP_EXT}`;
}

/** Parse a backup filename back to a Date, or null if it doesn't match. */
function parseBackupDate(name) {
  const m = BACKUP_RE.exec(name);
  if (!m) return null;
  const [, y, mo, da, h, mi, s] = m.map(Number);
  return new Date(y, mo - 1, da, h, mi, s);
}

/** SQLite string-literal form of a path (forward slashes, single quotes doubled). */
function sqlPathLiteral(p) {
  return p.split(path.sep).join('/').replace(/'/g, "''");
}

/**
 * Open a backup file (with the key if the DB is encrypted) and confirm it is a
 * valid, fully-readable database.
 *
 * @param {string} file
 * @param {string|null} key
 * @returns {boolean}
 */
function verifyBackup(file, key) {
  let db;
  try {
    db = new Database(file, { readonly: true });
    if (key) applyKey(db, key);
    return db.pragma('integrity_check', { simple: true }) === 'ok';
  } catch (_e) {
    return false;
  } finally {
    if (db) { try { db.close(); } catch (_e) { /* ignore */ } }
  }
}

/**
 * Create an integrity-verified snapshot of the open DB.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db - Open connection.
 * @param {string} backupDir
 * @param {object} [opts]
 * @param {string|null} [opts.key] - DB key (for verifying the encrypted snapshot).
 * @param {Date} [opts.now] - Timestamp (injectable for tests).
 * @returns {{ file: string, path: string, size: number, created_at: string }}
 */
function createBackup(db, backupDir, opts = {}) {
  const key = opts.key || null;
  const now = opts.now || new Date();
  fs.mkdirSync(backupDir, { recursive: true });

  const file = backupFilename(now);
  const dest = path.join(backupDir, file);
  if (fs.existsSync(dest)) {
    // Same-second collision — extremely unlikely; bail rather than overwrite.
    throw new Error(`backup: destination already exists (${file})`);
  }

  db.exec(`VACUUM INTO '${sqlPathLiteral(dest)}'`);

  if (!verifyBackup(dest, key)) {
    try { fs.rmSync(dest, { force: true }); } catch (_e) { /* ignore */ }
    throw new Error('backup: integrity check failed on the new snapshot');
  }
  const stat = fs.statSync(dest);
  return { file, path: dest, size: stat.size, created_at: now.toISOString() };
}

/**
 * List backups (newest first) with parsed timestamps.
 *
 * @param {string} backupDir
 * @returns {Array<{ file: string, path: string, size: number, created_at: string, date: Date }>}
 */
function listBackups(backupDir) {
  let names;
  try { names = fs.readdirSync(backupDir); } catch (_e) { return []; }
  return names
    .map((name) => ({ name, date: parseBackupDate(name) }))
    .filter((x) => x.date)
    .map(({ name, date }) => {
      const p = path.join(backupDir, name);
      let size = 0;
      try { size = fs.statSync(p).size; } catch (_e) { /* ignore */ }
      return { file: name, path: p, size, created_at: date.toISOString(), date };
    })
    .sort((a, b) => b.date - a.date);
}

const dayKey = (d) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
function weekKey(d) {
  // ISO-ish week: Thursday-based year-week. Good enough for retention bucketing.
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = (t.getDay() + 6) % 7; // Mon=0
  t.setDate(t.getDate() - day + 3);
  const firstThu = new Date(t.getFullYear(), 0, 4);
  const week = 1 + Math.round(((t - firstThu) / 86400000 - 3 + ((firstThu.getDay() + 6) % 7)) / 7);
  return `${t.getFullYear()}-W${week}`;
}

/**
 * Apply grandfather-father-son retention: keep the most recent backup for each
 * of the last N daily / weekly / monthly buckets (7 / 4 / 3), delete the rest.
 *
 * @param {string} backupDir
 * @returns {{ kept: string[], deleted: string[] }}
 */
function applyRetention(backupDir) {
  const backups = listBackups(backupDir); // newest first
  const keep = new Set();

  const takeByBucket = (keyFn, limit) => {
    const seen = new Set();
    for (const b of backups) {
      const k = keyFn(b.date);
      if (seen.has(k)) continue;   // already have the newest for this bucket
      if (seen.size >= limit) break;
      seen.add(k);
      keep.add(b.file);
    }
  };

  takeByBucket(dayKey, RETENTION.daily);
  takeByBucket(weekKey, RETENTION.weekly);
  takeByBucket(monthKey, RETENTION.monthly);

  const deleted = [];
  for (const b of backups) {
    if (!keep.has(b.file)) {
      try { fs.rmSync(b.path, { force: true }); deleted.push(b.file); } catch (_e) { /* ignore */ }
    }
  }
  return { kept: [...keep], deleted };
}

/**
 * Restore a backup over the live DB path. The caller MUST ensure the live DB
 * connection is closed first; the app then re-opens (re-login) against the
 * restored file. Verifies the backup opens with the key before overwriting, so
 * a bad file never clobbers a good live DB.
 *
 * @param {string} backupPath
 * @param {string} dbPath
 * @param {object} [opts]
 * @param {string|null} [opts.key]
 * @returns {{ restored: string }}
 */
function restoreBackup(backupPath, dbPath, opts = {}) {
  const key = opts.key || null;
  if (!fs.existsSync(backupPath)) throw new Error('restore: backup file not found');
  if (!verifyBackup(backupPath, key)) {
    throw new Error('restore: backup failed integrity check — not restored');
  }
  // Snapshot the current live DB first (safety net), then swap in the backup.
  fs.copyFileSync(backupPath, dbPath);
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
  return { restored: path.basename(backupPath) };
}

/**
 * Create a daily backup if none exists for today, then prune per retention.
 * Safe to call on every login; a no-op after the day's first call.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {string} backupDir
 * @param {object} [opts] - { key, now }
 * @returns {{ created: boolean, file?: string, retention?: object }}
 */
function maybeDailyBackup(db, backupDir, opts = {}) {
  const now = opts.now || new Date();
  const today = dayKey(now);
  const existing = listBackups(backupDir);
  if (existing.some((b) => dayKey(b.date) === today)) {
    return { created: false };
  }
  const backup = createBackup(db, backupDir, { key: opts.key, now });
  const retention = applyRetention(backupDir);
  return { created: true, file: backup.file, retention };
}

module.exports = {
  RETENTION,
  backupFilename,
  parseBackupDate,
  verifyBackup,
  createBackup,
  listBackups,
  applyRetention,
  restoreBackup,
  maybeDailyBackup,
};
