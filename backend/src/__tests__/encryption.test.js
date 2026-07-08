'use strict';

/**
 * SQLCipher encryption-at-rest tests (Sub-step A).
 *
 * These use real temp FILES (not :memory:) because the guarantee under test is
 * "at rest": the bytes on disk must be ciphertext, a wrong key must be rejected,
 * and a legacy plaintext DB must migrate transparently. Key derivation is
 * exercised through lib/dbKey.js — the same seam the auth layer wires into.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const Database = require('better-sqlite3-multiple-ciphers');
const {
  initializeDatabase,
  migratePlaintextToEncrypted,
} = require('../db/schema');
const {
  deriveDbKey,
  resolveDbKey,
  loadOrCreateSalt,
  applyKey,
} = require('../lib/dbKey');

/** Unique temp DB path per test; tracked for cleanup. */
const made = [];
function tmpDbPath(tag) {
  const p = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), `fintrace-enc-${tag}-`)),
    'fintrace.db',
  );
  made.push(p);
  return p;
}

function rmDbFamily(p) {
  for (const suffix of ['', '-wal', '-shm', '.salt', '.enc-migrate']) {
    try { fs.rmSync(`${p}${suffix}`, { force: true }); } catch (_e) { /* ignore */ }
  }
}

afterAll(() => {
  for (const p of made) {
    rmDbFamily(p);
    try { fs.rmdirSync(path.dirname(p)); } catch (_e) { /* ignore */ }
  }
});

const HEXKEY = deriveDbKey('unit-test-secret', 'a'.repeat(32));

describe('key derivation (lib/dbKey)', () => {
  test('derives a 256-bit (64 hex char) key, deterministic for same secret+salt', () => {
    const salt = 'b'.repeat(32);
    const k1 = deriveDbKey('secret', salt);
    const k2 = deriveDbKey('secret', salt);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k1).toBe(k2);
  });

  test('different secret or salt yields a different key', () => {
    expect(deriveDbKey('secretA', 'c'.repeat(32)))
      .not.toBe(deriveDbKey('secretB', 'c'.repeat(32)));
    expect(deriveDbKey('secret', 'c'.repeat(32)))
      .not.toBe(deriveDbKey('secret', 'd'.repeat(32)));
  });

  test('resolveDbKey creates a persistent salt sidecar and is stable across calls', () => {
    const p = tmpDbPath('salt');
    const k1 = resolveDbKey(p, 'secret');
    expect(fs.existsSync(`${p}.salt`)).toBe(true);
    const k2 = resolveDbKey(p, 'secret'); // reuses the salt file
    expect(k1).toBe(k2);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
  });

  test('deriveDbKey rejects empty inputs', () => {
    expect(() => deriveDbKey('', 'aa')).toThrow(TypeError);
    expect(() => deriveDbKey('s', '')).toThrow(TypeError);
  });
});

describe('encryption at rest', () => {
  test('a keyed DB is ciphertext on disk — no plaintext header, no leaked values', () => {
    const p = tmpDbPath('atrest');
    const db = initializeDatabase(p, { key: HEXKEY });
    db.prepare(`INSERT INTO ncrp_reports (filename, original_filename, upload_date)
                VALUES (?, ?, ?)`).run('SECRETFILE.xlsx', 'SECRETFILE.xlsx', '2024-01-01');
    db.close();

    const raw = fs.readFileSync(p);
    expect(raw.slice(0, 16).toString('latin1').startsWith('SQLite format 3')).toBe(false);
    expect(raw.includes(Buffer.from('SECRETFILE.xlsx'))).toBe(false);
  });

  test('the correct key reopens and reads the data back', () => {
    const p = tmpDbPath('reopen');
    let db = initializeDatabase(p, { key: HEXKEY });
    db.prepare(`INSERT INTO ncrp_reports (filename, original_filename, upload_date)
                VALUES (?, ?, ?)`).run('a.xlsx', 'a.xlsx', '2024-01-01');
    db.close();

    db = initializeDatabase(p, { key: HEXKEY });
    const row = db.prepare('SELECT filename FROM ncrp_reports').get();
    expect(row.filename).toBe('a.xlsx');
    db.close();
  });

  test('a wrong key is rejected as a fatal, non-plaintext file', () => {
    const p = tmpDbPath('wrongkey');
    const db = initializeDatabase(p, { key: HEXKEY });
    db.close();

    const otherKey = deriveDbKey('a-different-secret', 'e'.repeat(32));
    expect(() => initializeDatabase(p, { key: otherKey }))
      .toThrow(/wrong encryption credential or corrupt file/i);
  });

  test('raw byte-level check: SQLCipher rejects the file without any key', () => {
    const p = tmpDbPath('nokey');
    const db = initializeDatabase(p, { key: HEXKEY });
    db.close();

    const bare = new Database(p);
    expect(() => bare.prepare('SELECT count(*) FROM sqlite_master').get()).toThrow();
    bare.close();
  });
});

describe('legacy plaintext → encrypted migration', () => {
  test('an existing plaintext DB is migrated in place and data survives', () => {
    const p = tmpDbPath('migrate');

    // 1. Create a PLAINTEXT DB (no key) with real data — a pre-encryption install.
    let db = initializeDatabase(p);
    const rid = db.prepare(`INSERT INTO ncrp_reports (filename, original_filename, upload_date)
                            VALUES (?, ?, ?)`).run('legacy.xlsx', 'legacy.xlsx', '2024-01-01').lastInsertRowid;
    db.prepare(`INSERT INTO ncrp_transactions (report_id, beneficiary_account, transaction_amount, layer_no)
                VALUES (?, ?, ?, ?)`).run(rid, 'ACC-LEGACY', 5000, 1);
    db.close();
    // Confirm it really is plaintext on disk before migration.
    expect(fs.readFileSync(p).slice(0, 16).toString('latin1').startsWith('SQLite format 3')).toBe(true);

    // 2. Open WITH a key → initializeDatabase migrates transparently.
    db = initializeDatabase(p, { key: HEXKEY });
    const rep = db.prepare('SELECT filename FROM ncrp_reports').get();
    const txn = db.prepare('SELECT beneficiary_account, transaction_amount FROM ncrp_transactions').get();
    expect(rep.filename).toBe('legacy.xlsx');
    expect(txn.beneficiary_account).toBe('ACC-LEGACY');
    expect(txn.transaction_amount).toBe(5000);
    db.close();

    // 3. On disk it is now ciphertext, and the temp migration artifact is gone.
    expect(fs.readFileSync(p).slice(0, 16).toString('latin1').startsWith('SQLite format 3')).toBe(false);
    expect(fs.existsSync(`${p}.enc-migrate`)).toBe(false);

    // 4. Reopening with the key still works (idempotent — no re-migration).
    db = initializeDatabase(p, { key: HEXKEY });
    expect(db.prepare('SELECT count(*) AS n FROM ncrp_transactions').get().n).toBe(1);
    db.close();
  });

  test('migratePlaintextToEncrypted is a no-op-safe direct call', () => {
    const p = tmpDbPath('migrate-direct');
    let db = initializeDatabase(p); // plaintext
    db.prepare(`INSERT INTO ncrp_reports (filename, original_filename, upload_date)
                VALUES (?, ?, ?)`).run('d.xlsx', 'd.xlsx', '2024-01-01');
    db.close();

    migratePlaintextToEncrypted(p, HEXKEY);

    db = new Database(p);
    applyKey(db, HEXKEY);
    expect(db.prepare('SELECT filename FROM ncrp_reports').get().filename).toBe('d.xlsx');
    db.close();
  });
});
