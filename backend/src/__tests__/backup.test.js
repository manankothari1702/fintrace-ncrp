'use strict';

/**
 * Backup engine + routes tests (Phase 1 cross-cutting, clause 6.9).
 *
 * Engine: encrypted snapshots via VACUUM INTO, integrity verification, GFS
 * retention (7 daily / 4 weekly / 3 monthly), and restore. Routes: admin-only
 * create/list/restore through the real auth path.
 */

process.env.NODE_ENV = 'test';

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const Database = require('better-sqlite3-multiple-ciphers');
const { initializeDatabase } = require('../db/schema');
const { deriveDbKey, applyKey } = require('../lib/dbKey');
const {
  createBackup, listBackups, applyRetention, restoreBackup, verifyBackup,
  backupFilename, maybeDailyBackup,
} = require('../lib/backup');
const { createApp, createServerApp } = require('../server');
const { createAuthContext, DEFAULT_ADMIN_PASSWORD } = require('../auth/authContext');
const { ROLES } = require('../lib/roles');
const { loginAs, authed } = require('./helpers/auth');

const dirs = [];
function tmpDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `fintrace-bk-${tag}-`));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ } }
});

const KEY = deriveDbKey('backup-test', 'a'.repeat(32));

function seedEncryptedDb(dbPath) {
  const db = initializeDatabase(dbPath, { key: KEY });
  db.prepare(`INSERT INTO ncrp_reports (filename, original_filename, upload_date)
              VALUES (?, ?, ?)`).run('SECRET_CASE.xlsx', 'SECRET_CASE.xlsx', '2024-01-01');
  return db;
}

describe('backup engine — encrypted snapshot + integrity', () => {
  test('createBackup makes an ENCRYPTED, integrity-verified snapshot', () => {
    const dir = tmpDir('enc');
    const db = seedEncryptedDb(path.join(dir, 'live.db'));
    const backupDir = path.join(dir, 'backups');
    const b = createBackup(db, backupDir, { key: KEY });
    db.close();

    expect(fs.existsSync(b.path)).toBe(true);
    const raw = fs.readFileSync(b.path);
    // Encrypted at rest: no SQLite header, no plaintext leak of the secret.
    expect(raw.slice(0, 16).toString('latin1').startsWith('SQLite format 3')).toBe(false);
    expect(raw.includes(Buffer.from('SECRET_CASE.xlsx'))).toBe(false);
    // Verifiable + readable with the key.
    expect(verifyBackup(b.path, KEY)).toBe(true);
    const v = new Database(b.path, { readonly: true }); applyKey(v, KEY);
    expect(v.prepare('SELECT filename FROM ncrp_reports').get().filename).toBe('SECRET_CASE.xlsx');
    v.close();
  });

  test('verifyBackup fails for a wrong key and for garbage', () => {
    const dir = tmpDir('verify');
    const db = seedEncryptedDb(path.join(dir, 'live.db'));
    const b = createBackup(db, path.join(dir, 'backups'), { key: KEY });
    db.close();
    expect(verifyBackup(b.path, deriveDbKey('other', 'b'.repeat(32)))).toBe(false);
    const garbage = path.join(dir, 'garbage.db');
    fs.writeFileSync(garbage, Buffer.alloc(2048, 0x41));
    expect(verifyBackup(garbage, KEY)).toBe(false);
  });

  test('restoreBackup verifies then swaps the file; data comes back', () => {
    const dir = tmpDir('restore');
    const dbPath = path.join(dir, 'live.db');
    let db = seedEncryptedDb(dbPath);
    const b = createBackup(db, path.join(dir, 'backups'), { key: KEY });
    // Mutate the live DB AFTER the backup.
    db.prepare(`INSERT INTO ncrp_reports (filename, original_filename, upload_date)
                VALUES (?, ?, ?)`).run('LATER.xlsx', 'LATER.xlsx', '2024-02-02');
    expect(db.prepare('SELECT COUNT(*) n FROM ncrp_reports').get().n).toBe(2);
    db.close();

    restoreBackup(b.path, dbPath, { key: KEY });

    db = initializeDatabase(dbPath, { key: KEY });
    // Restored to the 1-row snapshot.
    expect(db.prepare('SELECT COUNT(*) n FROM ncrp_reports').get().n).toBe(1);
    db.close();
  });

  test('restore refuses a wrong-key backup (never clobbers the live DB)', () => {
    const dir = tmpDir('restore-guard');
    const dbPath = path.join(dir, 'live.db');
    const db = seedEncryptedDb(dbPath); db.close();
    const foreign = path.join(dir, 'foreign.db');
    fs.writeFileSync(foreign, Buffer.alloc(2048, 0x42));
    expect(() => restoreBackup(foreign, dbPath, { key: KEY })).toThrow(/integrity check/i);
  });
});

describe('backup retention (grandfather-father-son)', () => {
  // Build synthetic backups across many days and assert the keep-set.
  test('keeps 7 daily + 4 weekly + 3 monthly, prunes the rest', () => {
    const dir = tmpDir('retention');
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });

    // One backup per day for the last 120 days (empty files with valid names).
    const base = new Date(2026, 5, 30, 3, 0, 0); // fixed reference date
    for (let i = 0; i < 120; i += 1) {
      const d = new Date(base); d.setDate(d.getDate() - i);
      fs.writeFileSync(path.join(backupDir, backupFilename(d)), 'x');
    }
    expect(listBackups(backupDir)).toHaveLength(120);

    const { kept } = applyRetention(backupDir);
    const remaining = listBackups(backupDir);
    // Distinct day/week/month buckets overlap, so the union is ≤ 7+4+3 = 14
    // and comfortably fewer than the original 120.
    expect(remaining.length).toBe(kept.length);
    expect(remaining.length).toBeLessThanOrEqual(14);
    expect(remaining.length).toBeGreaterThanOrEqual(7); // at least the 7 daily
    expect(remaining.length).toBeLessThan(120);
    // The 7 most recent days are always retained.
    for (let i = 0; i < 7; i += 1) {
      const d = new Date(base); d.setDate(d.getDate() - i);
      expect(fs.existsSync(path.join(backupDir, backupFilename(d)))).toBe(true);
    }
  });

  test('maybeDailyBackup creates one per day, no-op on the second call', () => {
    const dir = tmpDir('daily');
    const db = seedEncryptedDb(path.join(dir, 'live.db'));
    const backupDir = path.join(dir, 'backups');
    const now = new Date(2026, 0, 15, 9, 0, 0);
    const first = maybeDailyBackup(db, backupDir, { key: KEY, now });
    const second = maybeDailyBackup(db, backupDir, { key: KEY, now: new Date(2026, 0, 15, 17, 0, 0) });
    db.close();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(listBackups(backupDir)).toHaveLength(1);
  });
});

describe('backup routes — admin only, real auth path', () => {
  test('non-admin is 403; admin can create, list, and restore', async () => {
    const dbDir = tmpDir('routes');
    const dbPath = path.join(dbDir, 'fintrace.db');
    const ctx = createAuthContext({ dbPath });
    ctx.bootstrap({ adminPassword: DEFAULT_ADMIN_PASSWORD });
    const app = createServerApp(ctx);

    // admin login + forced change → provisioned session
    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD });
    const token = login.body.token;
    await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: DEFAULT_ADMIN_PASSWORD, newPassword: 'AdminNew!2026' });
    const adminAuth = { Authorization: `Bearer ${token}` };

    // create a non-admin and log in
    await request(app).post('/api/users').set(adminAuth)
      .send({ username: 'io1', role: ROLES.IO, password: 'IoPass!2026a' });
    // io1 must change password first
    const ioLogin = await request(app).post('/api/auth/login').send({ username: 'io1', password: 'IoPass!2026a' });
    await request(app).post('/api/auth/change-password').set('Authorization', `Bearer ${ioLogin.body.token}`)
      .send({ oldPassword: 'IoPass!2026a', newPassword: 'IoReal!2026a' });
    const ioAuth = { Authorization: `Bearer ${ioLogin.body.token}` };

    // Non-admin: 403 on every backup route.
    expect((await request(app).get('/api/backups').set(ioAuth)).status).toBe(403);
    expect((await request(app).post('/api/backups').set(ioAuth)).status).toBe(403);

    // Admin: create → 201, then it shows in the list.
    const created = await request(app).post('/api/backups').set(adminAuth);
    expect(created.status).toBe(201);
    expect(created.body.backup.file).toMatch(/^fintrace-\d{8}-\d{6}\.db$/);

    const list = await request(app).get('/api/backups').set(adminAuth);
    expect(list.status).toBe(200);
    expect(list.body.backups.length).toBeGreaterThanOrEqual(1);
    expect(list.body.retention).toEqual({ daily: 7, weekly: 4, monthly: 3 });

    // Restore rejects path traversal / bad names.
    const bad = await request(app).post('/api/backups/restore').set(adminAuth).send({ file: '../secret.db' });
    expect(bad.status).toBe(400);

    // Restore a real backup → ok + relocks (next request needs re-login).
    const good = await request(app).post('/api/backups/restore').set(adminAuth)
      .send({ file: created.body.backup.file });
    expect(good.status).toBe(200);
    expect(good.body.restored).toBe(created.body.backup.file);
    // Session destroyed → subsequent call is 401.
    expect((await request(app).get('/api/backups').set(adminAuth)).status).toBe(401);
  });
});
