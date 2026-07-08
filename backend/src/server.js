'use strict';

/**
 * FinTrace NCRP — HTTP server bootstrap.
 *
 * Wires the NCRP router (which closes over a better-sqlite3 connection) onto an
 * Express app and binds it to the loopback interface only. The app is built by
 * {@link createApp} (pure — no listening) so tests can drive it via supertest,
 * while {@link startServer} opens the DB, builds the app, and starts listening.
 *
 * Mount contract (see routes/ncrp.js):
 *   app.use('/api', createNcrpRouter(db));   // → /api/ncrp/... + /api/health
 *
 * Security posture:
 *   • Binds ONLY to 127.0.0.1 — never 0.0.0.0. This is a single-user desktop
 *     backend embedded in an Electron app; it must not be reachable off-host.
 *   • CORS allows the Vite dev origin (localhost:5173) and the Electron prod
 *     origin (file://, which browsers send as Origin: "null"). Nothing else.
 *     No credentials are used, so reflecting the origin is safe.
 *
 * @module backend/src/server
 */

const path = require('path');
const express = require('express');

const { initializeDatabase } = require('./db/schema');
const { resolveDbKey } = require('./lib/dbKey');
const { createNcrpRouter } = require('./routes/ncrp');
const { createAuthContext } = require('./auth/authContext');
const { createAuthRouter } = require('./routes/auth');
const { createUserRouter } = require('./routes/users');

// ─── Bind target ─────────────────────────────────────────────────────
// Loopback only. Overridable via env for tests, but the host stays pinned
// to 127.0.0.1 by default and should never be exposed publicly.
const HOST = process.env.FINTRACE_HOST || '127.0.0.1';
const PORT = Number(process.env.FINTRACE_PORT) || 3847;

// ─── CORS allow-list ─────────────────────────────────────────────────
// The Vite dev server (HTTP) plus its 127.0.0.1 alias. The Electron
// production renderer loads from file:// and sends `Origin: null`, handled
// separately below.
const ALLOWED_ORIGINS = new Set([
  'http://localhost:5173',
  'http://127.0.0.1:5173',
]);

/**
 * Minimal hand-rolled CORS for the two origins we actually serve. Avoids
 * adding the `cors` package for a two-entry allow-list. No credentials are
 * exchanged (the API is unauthenticated loopback), so echoing the matched
 * origin — or `*` for the file:// renderer — is safe.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;

  if (ALLOWED_ORIGINS.has(origin)) {
    // Dev: echo the exact dev-server origin.
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (origin === undefined || origin === 'null' || origin.startsWith('file://')) {
    // Electron prod (file://) sends Origin: "null" or omits it. Wildcard is
    // fine because no cookies/credentials are involved.
    res.setHeader('Access-Control-Allow-Origin', '*');
  }
  // Any other origin: no ACAO header → the browser blocks it.

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  // Content-Type for JSON bodies; Authorization / X-Session-Token carry the
  // session token (Sub-step B). Still no cookies/credentials.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Session-Token');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  return next();
}

/**
 * Resolve the SQLite file path. Precedence:
 *   1. explicit `dbPath` argument (Electron passes app.getPath('userData')),
 *   2. FINTRACE_DB_PATH env var,
 *   3. dev default: backend/data/fintrace.db.
 *
 * @param {string} [dbPath]
 * @returns {string}
 */
function resolveDbPath(dbPath) {
  if (dbPath && dbPath.trim() !== '') return dbPath;
  if (process.env.FINTRACE_DB_PATH && process.env.FINTRACE_DB_PATH.trim() !== '') {
    return process.env.FINTRACE_DB_PATH;
  }
  return path.resolve(__dirname, '..', 'data', 'fintrace.db');
}

/**
 * Build the Express app over an ALREADY-OPEN DB connection (the open-db path,
 * used by the test harness and any in-process caller). Pure: does not listen.
 *
 * Mounts the auth routes (Sub-step B) plus the NCRP routes. In Sub-step B the
 * NCRP routes are still unauthenticated here; Sub-step C funnels them through
 * the requireAuth choke-point and updates the test harness to authenticate.
 * An auth context is created around the given db unless one is supplied, and is
 * exposed via `app.locals.authContext` for tests/helpers.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db - Open connection.
 * @param {object} [opts]
 * @param {object} [opts.authContext] - Pre-built context (else one is created).
 * @returns {import('express').Express}
 */
function createApp(db, opts = {}) {
  const app = express();

  // Trust no proxy — we only ever see direct loopback connections.
  app.disable('x-powered-by');

  const authContext = opts.authContext || createAuthContext({ db });
  app.locals.authContext = authContext;

  app.use(corsMiddleware);
  app.use('/api', createAuthRouter(authContext));
  app.use('/api', createUserRouter(authContext));
  app.use('/api', createNcrpRouter(db, authContext));

  return app;
}

/**
 * Build the REAL, login-gated app used by the packaged/dev Electron backend.
 * The DB starts LOCKED (not opened at boot); the NCRP routes are mounted
 * lazily the first time a login unlocks and opens the DB. Auth routes and a
 * always-available /api/health work while locked.
 *
 * @param {object} authContext - from createAuthContext({ dbPath }).
 * @returns {import('express').Express}
 */
function createServerApp(authContext) {
  const app = express();
  app.disable('x-powered-by');
  app.locals.authContext = authContext;

  app.use(corsMiddleware);
  app.use('/api', createAuthRouter(authContext));
  app.use('/api', createUserRouter(authContext));

  // Health works even while the DB is locked (no auth required).
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', locked: authContext.isLocked(), timestamp: new Date().toISOString() });
  });

  // Lazily build + delegate to the NCRP router once a login has opened the DB.
  // (createNcrpRouter prepares statements against the open connection, so it
  // cannot be built until the DEK is unlocked at login.)
  let ncrpRouter = null;
  app.use('/api', (req, res, next) => {
    const db = authContext.getDb();
    if (!db) {
      return res.status(503).json({
        error: { code: 'DB_LOCKED', message: 'Sign in to load case data.' },
      });
    }
    if (!ncrpRouter) ncrpRouter = createNcrpRouter(db, authContext);
    return ncrpRouter(req, res, next);
  });

  return app;
}

/**
 * Start the REAL login-gated backend and listen on 127.0.0.1.
 *
 * The DB is NOT opened at boot. `bootstrap()` guarantees a seeded admin +
 * keystore exist (creating the encrypted DB on first run, or migrating a
 * legacy plaintext one — see auth/authContext + Sub-step A). The encrypted DB
 * is then opened by the first successful login, whose password unlocks the DEK
 * from the keystore — i.e. the DB key is derived from the admin credential
 * (the Sub-step A seam, now fulfilled). App close = logout = DB handle gone.
 *
 * @param {object} [opts]
 * @param {string} [opts.dbPath] - SQLite file path (see {@link resolveDbPath}).
 * @param {number} [opts.port]   - Port to bind (default 3847).
 * @param {string} [opts.host]   - Host to bind (default 127.0.0.1).
 * @returns {Promise<{ app: import('express').Express,
 *                      server: import('http').Server,
 *                      authContext: object }>}
 */
function startServer(opts = {}) {
  const dbPath = resolveDbPath(opts.dbPath);
  const port = opts.port || PORT;
  const host = opts.host || HOST;

  const authContext = createAuthContext({ dbPath });
  authContext.bootstrap(); // idempotent: seed admin + create/migrate encrypted DB
  const app = createServerApp(authContext);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      // Required startup banner.
      console.log(`FinTrace backend ready on ${host}:${port}`);
      resolve({ app, server, authContext });
    });

    server.on('error', (err) => {
      const db = authContext.getDb();
      if (db) { try { db.close(); } catch (_e) { /* best effort */ } }
      reject(err);
    });

    // Close the DB cleanly when the server stops.
    server.on('close', () => {
      const db = authContext.getDb();
      if (db) { try { db.close(); } catch (_e) { /* already closed */ } }
    });
  });
}

// Allow `node src/server.js` to run standalone (dev / non-Electron).
if (require.main === module) {
  startServer().catch((err) => {
    console.error('FinTrace backend failed to start:', err && err.message ? err.message : err);
    process.exit(1);
  });
}

module.exports = {
  app: createApp, createApp, createServerApp, startServer, resolveDbPath, HOST, PORT,
};
