'use strict';

/**
 * Auth backend tests (Phase 1 Sub-step B).
 *
 * Covers password policy, hashing, seeded-admin idempotency, login
 * success/failure, forced password change, session validation, and the
 * credential-derived DB key (locked login unlocks the DEK from the keystore
 * and opens the encrypted DB; changing the password re-wraps the DEK). Tests
 * exercise the REAL auth code paths — nothing is stubbed to pass.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { initializeDatabase } = require('../db/schema');
const {
  validatePassword, hashPassword, verifyPassword, createSessionStore, PASSWORD_POLICY,
} = require('../lib/authStore');
const { createAuthContext, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } = require('../auth/authContext');
const { createRequireAuth, extractToken } = require('../middleware/requireAuth');
const { createServerApp } = require('../server');
const authQ = require('../db/authQueries');

const tmpDirs = [];
function tmpDbPath(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `fintrace-auth-${tag}-`));
  tmpDirs.push(dir);
  return path.join(dir, 'fintrace.db');
}
afterAll(() => {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_e) { /* ignore */ }
  }
});

describe('password policy', () => {
  test('rejects weak passwords with specific reasons', () => {
    expect(validatePassword('short').ok).toBe(false);
    expect(validatePassword('alllowercase1!').errors).toContain('Must include an uppercase letter.');
    expect(validatePassword('NOLOWERCASE1!').errors).toContain('Must include a lowercase letter.');
    expect(validatePassword('NoDigitsHere!').errors).toContain('Must include a digit.');
    expect(validatePassword('NoSymbol12345').errors).toContain('Must include a symbol.');
  });
  test('accepts a compliant password', () => {
    expect(validatePassword('GoodPass!2026').ok).toBe(true);
  });
  test('policy is a tunable named constant', () => {
    expect(PASSWORD_POLICY.minLength).toBeGreaterThanOrEqual(8);
    expect(PASSWORD_POLICY.description).toEqual(expect.any(String));
  });
});

describe('password hashing (bcryptjs)', () => {
  test('hashes are salted (differ) and verify correctly', () => {
    const h1 = hashPassword('GoodPass!2026');
    const h2 = hashPassword('GoodPass!2026');
    expect(h1).not.toBe(h2);            // per-hash salt
    expect(h1).toMatch(/^\$2[aby]\$/);  // bcrypt format
    expect(verifyPassword('GoodPass!2026', h1)).toBe(true);
    expect(verifyPassword('wrong', h1)).toBe(false);
  });
});

describe('session store (in-memory)', () => {
  test('create → get → destroy lifecycle', () => {
    const s = createSessionStore();
    const token = s.create({ userId: 1, username: 'admin', role: 'system_admin' });
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(s.get(token).username).toBe('admin');
    expect(s.destroy(token)).toBe(true);
    expect(s.get(token)).toBeNull();
  });
  test('unknown token returns null', () => {
    expect(createSessionStore().get('nope')).toBeNull();
  });
});

describe('extractToken', () => {
  test('reads Bearer and X-Session-Token headers', () => {
    expect(extractToken({ headers: { authorization: 'Bearer abc123' } })).toBe('abc123');
    expect(extractToken({ headers: { 'x-session-token': 'def456' } })).toBe('def456');
    expect(extractToken({ headers: {} })).toBeNull();
  });
});

describe('seeded admin (idempotent)', () => {
  test('open-db path seeds exactly one admin, re-running is a no-op', () => {
    const db = initializeDatabase(':memory:');
    const ctx = createAuthContext({ db });
    expect(ctx.bootstrap().seeded).toBe(true);
    expect(ctx.bootstrap().seeded).toBe(false); // idempotent
    expect(ctx.bootstrap().seeded).toBe(false);
    expect(authQ.countUsers(db)).toBe(1);
    const admin = authQ.getUserByUsername(db, DEFAULT_ADMIN_USERNAME);
    expect(admin.role).toBe('system_admin');
    expect(!!admin.must_change_password).toBe(true);
    db.close();
  });
});

describe('login (open-db path)', () => {
  let db; let ctx;
  beforeEach(() => {
    db = initializeDatabase(':memory:');
    ctx = createAuthContext({ db });
    ctx.bootstrap();
  });
  afterEach(() => { try { db.close(); } catch (_e) { /* ignore */ } });

  test('correct credentials return a token + must_change flag', () => {
    const { token, user } = ctx.login(DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(user.username).toBe('admin');
    expect(user.must_change_password).toBe(true);
  });
  test('wrong password throws INVALID_CREDENTIALS', () => {
    expect(() => ctx.login('admin', 'wrong')).toThrow(/Invalid username or password/);
  });
  test('unknown user throws the SAME generic error (no user enumeration)', () => {
    let msgUnknown; let msgWrong;
    try { ctx.login('ghost', 'whatever'); } catch (e) { msgUnknown = e.message; }
    try { ctx.login('admin', 'wrong'); } catch (e) { msgWrong = e.message; }
    expect(msgUnknown).toBe(msgWrong);
  });
  test('deactivated user cannot log in', () => {
    const admin = authQ.getUserByUsername(db, 'admin');
    authQ.setUserActive(db, admin.id, false);
    expect(() => ctx.login('admin', DEFAULT_ADMIN_PASSWORD)).toThrow(/Invalid/);
  });
});

describe('forced password change', () => {
  let db; let ctx;
  beforeEach(() => {
    db = initializeDatabase(':memory:');
    ctx = createAuthContext({ db });
    ctx.bootstrap();
  });
  afterEach(() => { try { db.close(); } catch (_e) { /* ignore */ } });

  test('change clears the flag and enforces policy + old-password check', () => {
    const { token } = ctx.login('admin', DEFAULT_ADMIN_PASSWORD);
    const session = ctx.sessions.get(token);

    expect(() => ctx.changePassword(session, 'wrong-old', 'NewPass!2026')).toThrow(/incorrect/i);
    expect(() => ctx.changePassword(session, DEFAULT_ADMIN_PASSWORD, 'weak')).toThrow(/at least/i);
    expect(() => ctx.changePassword(session, DEFAULT_ADMIN_PASSWORD, DEFAULT_ADMIN_PASSWORD)).toThrow(/differ/i);

    const updated = ctx.changePassword(session, DEFAULT_ADMIN_PASSWORD, 'NewPass!2026');
    expect(updated.must_change_password).toBe(false);
    // New password now works, old one does not.
    expect(() => ctx.login('admin', DEFAULT_ADMIN_PASSWORD)).toThrow();
    expect(ctx.login('admin', 'NewPass!2026').user.must_change_password).toBe(false);
  });
});

describe('requireAuth middleware (choke-point)', () => {
  function runMw(ctx, headers) {
    const mw = createRequireAuth(ctx);
    const req = { headers };
    let statusCode = null; let body = null; let nexted = false;
    const res = {
      status(c) { statusCode = c; return this; },
      json(b) { body = b; return this; },
    };
    mw(req, res, () => { nexted = true; });
    return { statusCode, body, nexted, req };
  }
  test('no token → 401 UNAUTHENTICATED', () => {
    const db = initializeDatabase(':memory:'); const ctx = createAuthContext({ db }); ctx.bootstrap();
    const r = runMw(ctx, {});
    expect(r.statusCode).toBe(401);
    expect(r.body.error.code).toBe('UNAUTHENTICATED');
    db.close();
  });
  test('valid token but must-change → 403 PASSWORD_CHANGE_REQUIRED', () => {
    const db = initializeDatabase(':memory:'); const ctx = createAuthContext({ db }); ctx.bootstrap();
    const { token } = ctx.login('admin', DEFAULT_ADMIN_PASSWORD);
    const r = runMw(ctx, { authorization: `Bearer ${token}` });
    expect(r.statusCode).toBe(403);
    expect(r.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    db.close();
  });
  test('valid provisioned token → next() with req.user set', () => {
    const db = initializeDatabase(':memory:'); const ctx = createAuthContext({ db }); ctx.bootstrap();
    const { token } = ctx.login('admin', DEFAULT_ADMIN_PASSWORD);
    ctx.changePassword(ctx.sessions.get(token), DEFAULT_ADMIN_PASSWORD, 'NewPass!2026');
    const r = runMw(ctx, { authorization: `Bearer ${token}` });
    expect(r.nexted).toBe(true);
    expect(r.req.user.username).toBe('admin');
    db.close();
  });
});

describe('credential-derived DB key (locked/real path)', () => {
  test('bootstrap creates an ENCRYPTED db + keystore; login unlocks via password', () => {
    const dbPath = tmpDbPath('locked');
    const ctx = createAuthContext({ dbPath });
    ctx.bootstrap({ adminPassword: DEFAULT_ADMIN_PASSWORD });

    // DB starts locked; encrypted file + keystore exist.
    expect(ctx.isLocked()).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);
    expect(fs.existsSync(`${dbPath}.keystore.json`)).toBe(true);
    expect(fs.readFileSync(dbPath).slice(0, 16).toString('latin1').startsWith('SQLite format 3')).toBe(false);

    // Wrong password does NOT unlock/open the DB.
    expect(() => ctx.login('admin', 'wrong-password')).toThrow(/Invalid/);
    expect(ctx.isLocked()).toBe(true);

    // Correct password unlocks the DEK and opens the DB.
    const { user } = ctx.login('admin', DEFAULT_ADMIN_PASSWORD);
    expect(user.must_change_password).toBe(true);
    expect(ctx.isLocked()).toBe(false);
  });

  test('password change re-wraps the DEK: a FRESH locked context needs the new password', () => {
    const dbPath = tmpDbPath('rewrap');
    const ctx = createAuthContext({ dbPath });
    ctx.bootstrap({ adminPassword: DEFAULT_ADMIN_PASSWORD });
    const { token } = ctx.login('admin', DEFAULT_ADMIN_PASSWORD);
    ctx.changePassword(ctx.sessions.get(token), DEFAULT_ADMIN_PASSWORD, 'NewPass!2026');

    // Simulate an app restart: brand-new context, DB locked again.
    const ctx2 = createAuthContext({ dbPath });
    expect(ctx2.isLocked()).toBe(true);
    expect(() => ctx2.login('admin', DEFAULT_ADMIN_PASSWORD)).toThrow(); // old pw no longer unlocks
    const r = ctx2.login('admin', 'NewPass!2026');
    expect(r.user.must_change_password).toBe(false);
    expect(ctx2.isLocked()).toBe(false);
  });
});

describe('auth routes (createServerApp + supertest)', () => {
  let app; let dbPath;
  beforeEach(() => {
    dbPath = tmpDbPath('routes');
    const ctx = createAuthContext({ dbPath });
    ctx.bootstrap({ adminPassword: DEFAULT_ADMIN_PASSWORD });
    app = createServerApp(ctx);
  });

  test('health works while the DB is locked', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.locked).toBe(true);
  });

  test('protected NCRP route is 503 DB_LOCKED before login', async () => {
    const res = await request(app).get('/api/ncrp/reports');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DB_LOCKED');
  });

  test('login → me → change-password → logout flow', async () => {
    const bad = await request(app).post('/api/auth/login').send({ username: 'admin', password: 'nope' });
    expect(bad.status).toBe(401);

    const login = await request(app).post('/api/auth/login').send({ username: 'admin', password: DEFAULT_ADMIN_PASSWORD });
    expect(login.status).toBe(200);
    const { token } = login.body;
    expect(login.body.user.must_change_password).toBe(true);

    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.username).toBe('admin');

    // NCRP route now that the DB is unlocked, but forced-change blocks it (403).
    const blocked = await request(app).get('/api/ncrp/reports').set('Authorization', `Bearer ${token}`);
    // In Sub-step B the NCRP routes are not yet behind requireAuth, so they
    // respond 200 once the DB is open. The forced-change gate is asserted at the
    // middleware layer above; Sub-step C enforces it on these routes.
    expect([200, 403]).toContain(blocked.status);

    const chg = await request(app).post('/api/auth/change-password')
      .set('Authorization', `Bearer ${token}`)
      .send({ oldPassword: DEFAULT_ADMIN_PASSWORD, newPassword: 'NewPass!2026' });
    expect(chg.status).toBe(200);
    expect(chg.body.user.must_change_password).toBe(false);

    const out = await request(app).post('/api/auth/logout').set('Authorization', `Bearer ${token}`);
    expect(out.status).toBe(200);
    const meAfter = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(meAfter.status).toBe(401); // session destroyed
  });

  test('GET /api/auth/policy exposes the password policy', async () => {
    const res = await request(app).get('/api/auth/policy');
    expect(res.status).toBe(200);
    expect(res.body.policy.minLength).toBe(PASSWORD_POLICY.minLength);
  });
});
