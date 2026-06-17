'use strict';

/**
 * FinTrace NCRP — evidentiary provenance helpers.
 *
 * Court-grade traceability: every report records the SHA-256 of the exact raw
 * NCRP file it was built from, so a dossier can be tied back to its source
 * byte-for-byte. This module centralises the hash computation and the FinTrace
 * version string that get stamped into the case record, the audit log, and the
 * PDF dossier. Uses Node's built-in crypto — no new crypto handler.
 *
 * @module backend/src/lib/provenance
 */

const fs = require('fs');
const crypto = require('crypto');

/**
 * SHA-256 (lowercase hex) of a file's raw bytes. Reads the whole file (uploads
 * are capped at 50 MB upstream), so the hash is over the exact bytes on disk —
 * the same input always yields the same digest.
 *
 * @param {string} filePath - Absolute path to the file to hash.
 * @returns {string} 64-char lowercase hex SHA-256 digest.
 */
function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * SHA-256 (lowercase hex) of an in-memory buffer/string. Exposed for tests and
 * callers that already hold the bytes.
 *
 * @param {Buffer|string} data
 * @returns {string} 64-char lowercase hex SHA-256 digest.
 */
function sha256Buffer(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * The FinTrace version string stamped onto provenance records. Prefers an
 * explicit override (set by the Electron main process at launch), then the
 * backend package version, then a safe fallback.
 *
 * @returns {string}
 */
function appVersion() {
  if (process.env.FINTRACE_VERSION && process.env.FINTRACE_VERSION.trim() !== '') {
    return process.env.FINTRACE_VERSION.trim();
  }
  try {
    // backend/package.json — two levels up from src/lib.
    const pkg = require('../../package.json');
    if (pkg && pkg.version) return String(pkg.version);
  } catch (_e) { /* fall through */ }
  if (process.env.npm_package_version && process.env.npm_package_version.trim() !== '') {
    return process.env.npm_package_version.trim();
  }
  // Never surface a bare "unknown" on a court document — 'dev' makes an
  // unversioned build obvious without reading like missing data.
  return 'dev';
}

module.exports = { sha256File, sha256Buffer, appVersion };
