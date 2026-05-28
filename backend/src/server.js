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
const { createNcrpRouter } = require('./routes/ncrp');

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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
 * Build the Express app over an already-open DB connection. Pure: does not
 * listen, so it is reusable from tests.
 *
 * @param {import('better-sqlite3').Database} db - Open connection.
 * @returns {import('express').Express}
 */
function createApp(db) {
  const app = express();

  // Trust no proxy — we only ever see direct loopback connections.
  app.disable('x-powered-by');

  app.use(corsMiddleware);
  app.use('/api', createNcrpRouter(db));

  return app;
}

/**
 * Open the database, build the app, and start listening on 127.0.0.1.
 *
 * @param {object} [opts]
 * @param {string} [opts.dbPath] - SQLite file path (see {@link resolveDbPath}).
 * @param {number} [opts.port]   - Port to bind (default 3847).
 * @param {string} [opts.host]   - Host to bind (default 127.0.0.1).
 * @returns {Promise<{ app: import('express').Express,
 *                      server: import('http').Server,
 *                      db: import('better-sqlite3').Database }>}
 */
function startServer(opts = {}) {
  const dbPath = resolveDbPath(opts.dbPath);
  const port = opts.port || PORT;
  const host = opts.host || HOST;

  const db = initializeDatabase(dbPath);
  const app = createApp(db);

  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      // Required startup banner.
      console.log(`FinTrace backend ready on ${host}:${port}`);
      resolve({ app, server, db });
    });

    server.on('error', (err) => {
      try { db.close(); } catch (_e) { /* best effort */ }
      reject(err);
    });

    // Close the DB cleanly when the server stops.
    server.on('close', () => {
      try { db.close(); } catch (_e) { /* already closed */ }
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

module.exports = { app: createApp, createApp, startServer, resolveDbPath, HOST, PORT };
