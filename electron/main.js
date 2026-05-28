'use strict';

/**
 * FinTrace NCRP — Electron main process.
 *
 * Boots the embedded Express backend **in this same process** (no child
 * process, no port-wait — single-.exe friendly), then opens the hardened
 * BrowserWindow. In development the renderer is served by Vite
 * (http://localhost:5173); in a packaged build it loads the static bundle
 * from dist/index.html via file://.
 *
 * Security hardening follows SDD §5:
 *   • contextIsolation + sandbox on, nodeIntegration off (§5.1)
 *   • CSP injected as an HTTP header (§5.3)
 *   • network egress restricted to loopback / file: / data: (§5.4)
 *   • single-instance lock, window-open deny, navigation guard (§5.1/§5.5)
 *
 * CommonJS by design (Phase 4D): the backend is plain .js and is required
 * directly, so the whole main process stays require()-able without a build.
 *
 * @module electron/main
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');

const { startServer } = require('../backend/src/server');
const { EXPORTS_DIR } = require('../backend/src/routes/ncrp');

// electron-log: hard dependency in packaged builds, but fall back to a console
// shim during incremental dev so `electron .` still launches before the package
// is installed.
let log;
try {
  log = require('electron-log');
  log.transports.file.level = 'info';
  log.transports.console.level = 'warn';
} catch (_e) {
  log = {
    info:  (...a) => console.log('[info]', ...a),
    warn:  (...a) => console.warn('[warn]', ...a),
    error: (...a) => console.error('[error]', ...a),
  };
}

// ─── Runtime mode ────────────────────────────────────────────────────
// `app.isPackaged` is the reliable prod signal; it is false under
// `electron .` during development.
const IS_DEV = !app.isPackaged;

const DEV_URL = 'http://localhost:5173';
const PROD_INDEX = path.join(__dirname, '..', 'dist', 'index.html');
const PRELOAD = path.join(__dirname, 'preload.js');

const BACKEND_ORIGIN = 'http://127.0.0.1:3847';

// Content-Security-Policy, applied as a response header (SDD §5.3).
const CSP = [
  "default-src 'self' http://127.0.0.1:3847",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http://127.0.0.1:3847",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

/** @type {BrowserWindow | null} */
let mainWindow = null;

/** @type {import('http').Server | null} */
let httpServer = null;

/**
 * Start the embedded backend. The SQLite file lives under the per-user
 * app-data directory so an unprivileged, per-user install can write to it.
 *
 * @returns {Promise<void>}
 */
async function startBackend() {
  const dbPath = path.join(app.getPath('userData'), 'fintrace.db');
  const { server } = await startServer({ dbPath });
  httpServer = server;
}

/**
 * Lock the session down before any window loads (SDD §5.3 / §5.4):
 *   • inject the CSP header on every response,
 *   • cancel any request that is not loopback / file: / data:.
 */
function installNetworkGuards() {
  const sess = session.defaultSession;

  sess.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });

  sess.webRequest.onBeforeRequest((details, cb) => {
    let allowed = false;
    try {
      const url = new URL(details.url);
      allowed =
        url.hostname === '127.0.0.1' ||
        url.hostname === 'localhost' ||
        url.protocol === 'file:' ||
        url.protocol === 'data:';
    } catch (_e) {
      allowed = false;
    }
    cb({ cancel: !allowed });
  });
}

/**
 * Create the single hardened application window and load the renderer.
 */
function createWindow() {
  /** @type {Electron.BrowserWindowConstructorOptions['webPreferences']} */
  const webPreferences = {
    contextIsolation: true,          // [NFR-12] hard isolation
    nodeIntegration: false,          // [NFR-12] no require() in renderer
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    sandbox: true,                   // V8 + OS sandbox
    webSecurity: true,
    allowRunningInsecureContent: false,
    spellcheck: false,
  };
  // The preload is delivered by a later phase; only wire it once present so
  // the app still launches during incremental development.
  if (fs.existsSync(PRELOAD)) {
    webPreferences.preload = PRELOAD;
  }

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    webPreferences,
  });

  // No popups, no off-app navigation (SDD §5.1).
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // file:// is the renderer's own origin in packaged builds (loaded via
    // loadFile). Without it, in-app router pushes get cancelled.
    const ok =
      url.startsWith(BACKEND_ORIGIN + '/') ||
      url.startsWith('file://') ||
      (IS_DEV && url.startsWith(DEV_URL));
    if (!ok) event.preventDefault();
  });

  mainWindow.once('ready-to-show', () => {
    if (mainWindow) mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  if (IS_DEV) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(PROD_INDEX);
  }
}

// ─── IPC handlers (whitelisted channels only) ───────────────────────
//
// The preload exposes exactly the channels registered here. Any other channel
// name reaches no handler and rejects with "No handler registered" — which is
// the correct default. Each handler validates its own arguments; the renderer
// is never trusted.

/**
 * Resolve a renderer-supplied PDF file name against EXPORTS_DIR, rejecting any
 * path that escapes the folder (path traversal) or that doesn't exist.
 *
 * @param {unknown} fileName
 * @returns {string | null} Absolute, validated path, or null on rejection.
 */
function resolveExportedPdf(fileName) {
  if (typeof fileName !== 'string' || fileName.trim() === '') return null;
  // Reject anything that looks like a path component — only bare file names
  // inside exports/ are allowed.
  if (/[\\/]/.test(fileName) || fileName.includes('..')) return null;
  if (!/\.pdf$/i.test(fileName)) return null;

  const candidate = path.resolve(EXPORTS_DIR, fileName);
  const exportsRoot = path.resolve(EXPORTS_DIR);
  // Containment check survives symlinks and mixed separators.
  const rel = path.relative(exportsRoot, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!fs.existsSync(candidate)) return null;
  return candidate;
}

function registerIpcHandlers() {
  ipcMain.handle('app:get-version', () => app.getVersion());

  ipcMain.handle('shell:open-pdf', async (_event, fileName) => {
    const safePath = resolveExportedPdf(fileName);
    if (!safePath) {
      log.warn('shell:open-pdf rejected for', fileName);
      return { ok: false, error: 'Invalid or unknown PDF.' };
    }
    const err = await shell.openPath(safePath);
    if (err) {
      log.error('shell.openPath failed:', err);
      return { ok: false, error: 'Could not open the PDF in the system viewer.' };
    }
    return { ok: true };
  });

  ipcMain.handle('shell:open-exports', async () => {
    const target = path.resolve(EXPORTS_DIR);
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch (_e) { /* surface via openPath below */ }
    const err = await shell.openPath(target);
    if (err) {
      log.error('shell.openPath(exports) failed:', err);
      return { ok: false, error: 'Could not open the exports folder.' };
    }
    return { ok: true };
  });

  ipcMain.handle('dialog:save-pdf', async (_event, fileName) => {
    const safePath = resolveExportedPdf(fileName);
    if (!safePath) return { ok: false, error: 'Invalid or unknown PDF.' };
    const focused = BrowserWindow.getFocusedWindow() || mainWindow;
    const result = await dialog.showSaveDialog(focused, {
      title: 'Save PDF copy',
      defaultPath: path.basename(safePath),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (result.canceled || !result.filePath) {
      return { ok: false, error: 'Save cancelled.' };
    }
    try {
      fs.copyFileSync(safePath, result.filePath);
      return { ok: true, savedTo: result.filePath };
    } catch (err) {
      log.error('save-pdf copy failed:', err);
      return { ok: false, error: 'Could not write the file.' };
    }
  });
}

// ─── Single-instance lock (SDD §5.5) ─────────────────────────────────
// Two processes must never race on the same SQLite file.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    installNetworkGuards();
    registerIpcHandlers();
    try {
      await startBackend();
    } catch (err) {
      log.error('FinTrace: backend failed to start —', err && err.message ? err.message : err);
      app.quit();
      return;
    }
    createWindow();

    // macOS: re-create a window when the dock icon is clicked and none open.
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // Quit when all windows close (except on macOS, per platform convention).
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  // Stop the embedded HTTP server (and, via its 'close' handler, the DB)
  // before the process exits.
  app.on('will-quit', () => {
    if (httpServer) {
      try { httpServer.close(); } catch (_e) { /* best effort */ }
      httpServer = null;
    }
  });
}
