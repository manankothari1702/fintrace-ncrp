'use strict';

/**
 * FinTrace NCRP — Electron main process.
 *
 * Boots the embedded Express backend **in this same process** (no child
 * process, no port-wait — single-.exe friendly), then opens the hardened
 * BrowserWindow. In development the renderer is served by Vite
 * (http://localhost:5173); in a packaged build it loads the static bundle
 * from frontend/dist/index.html via file://.
 *
 * Security hardening follows SDD §5:
 *   • contextIsolation + sandbox on, nodeIntegration off (§5.1)
 *   • CSP injected as an HTTP header (§5.3)
 *   • network egress restricted to loopback / file: / data: (§5.4)
 *   • single-instance lock, window-open deny, navigation guard (§5.1/§5.5)
 *
 * Packaging notes (Phase 9):
 *   • In production the backend is required from app.getAppPath()/backend/
 *     (resolved through ASAR — better-sqlite3 is unpacked via asarUnpack).
 *   • Per-user writable state (DB, uploads, exports) lives under
 *     app.getPath('userData'); the directories are created on first launch.
 *   • A splash window is shown while the backend boots and is destroyed once
 *     the main window is ready-to-show.
 *
 * CommonJS by design (Phase 4D): the backend is plain .js and is required
 * directly, so the whole main process stays require()-able without a build.
 *
 * @module electron/main
 */

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require('electron');

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
const PROD_INDEX = path.join(__dirname, '..', 'frontend', 'dist', 'index.html');
const PRELOAD = path.join(__dirname, 'preload.js');
const SPLASH_HTML = path.join(__dirname, 'splash.html');

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

/** @type {BrowserWindow | null} */
let splashWindow = null;

/** @type {import('http').Server | null} */
let httpServer = null;

// ─── Per-user writable paths (production) ────────────────────────────
// In a packaged build the app directory is inside Program Files and ASAR-
// archived — both read-only. The DB, uploaded XLSX files, and generated PDFs
// must therefore live under userData. In dev these stay under backend/ so the
// existing workflow (and tests) keep working unchanged.

/**
 * Resolve the runtime backend paths. Called once at startup before requiring
 * the backend, so the routes module reads them from env vars at load time.
 *
 * @returns {{ dbPath: string, uploadsDir: string, exportsDir: string }}
 */
function resolveRuntimePaths() {
  let dbPath, uploadsDir, exportsDir;

  if (IS_DEV) {
    // Dev defaults match the backend's own defaults; no env override needed.
    dbPath = path.resolve(__dirname, '..', 'backend', 'data', 'fintrace.db');
    uploadsDir = path.resolve(__dirname, '..', 'backend', 'uploads');
    exportsDir = path.resolve(__dirname, '..', 'backend', 'exports');
  } else {
    const userData = app.getPath('userData');
    dbPath = path.join(userData, 'fintrace.db');
    uploadsDir = path.join(userData, 'uploads');
    exportsDir = path.join(userData, 'exports');
  }

  // Ensure writable directories exist before the backend touches them.
  for (const dir of [path.dirname(dbPath), uploadsDir, exportsDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      log.error('Failed to create runtime dir', dir, err && err.message);
    }
  }

  return { dbPath, uploadsDir, exportsDir };
}

/**
 * Start the embedded backend. Sets env vars the backend's route module reads
 * at require-time, then requires + boots the server.
 *
 * @param {ReturnType<typeof resolveRuntimePaths>} paths
 * @returns {Promise<void>}
 */
async function startBackend(paths) {
  process.env.FINTRACE_DB_PATH = paths.dbPath;
  process.env.FINTRACE_UPLOADS_DIR = paths.uploadsDir;
  process.env.FINTRACE_EXPORTS_DIR = paths.exportsDir;

  log.info('FinTrace backend paths', paths);

  if (app.isPackaged) {
    // In packaged builds the backend runs from the resources folder, but its
    // node_modules now live at the app root (merged into root deps + packed
    // into app.asar). Chdir so any cwd-relative paths inside the backend
    // (e.g. fs reads against './config/...') resolve next to backend/.
    try {
      process.chdir(path.join(process.resourcesPath, 'backend'));
    } catch (err) {
      log.warn('chdir to resources/backend failed', err && err.message);
    }
  }

  // require() the backend AFTER env is set so routes/ncrp.js picks up the
  // overridden uploads/exports paths at module load.
  const { startServer } = require('../backend/src/server');
  const { server } = await startServer({ dbPath: paths.dbPath });
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
 * Show a frameless splash window while the backend boots. The splash is
 * destroyed in createWindow's ready-to-show handler.
 */
function createSplashWindow() {
  splashWindow = new BrowserWindow({
    width: 800,
    height: 500,
    frame: false,
    transparent: false,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: false,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (fs.existsSync(SPLASH_HTML)) {
    splashWindow.loadFile(SPLASH_HTML);
  } else {
    // Inline fallback so a missing splash.html never blocks startup.
    const html = `<!doctype html><meta charset="utf-8"><title>FinTrace NCRP</title>
      <style>
        html,body{margin:0;height:100%;background:#0b1c34;color:#e8f0ff;
          font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;
          display:flex;align-items:center;justify-content:center;flex-direction:column;}
        h1{margin:0 0 8px;font-size:22px;letter-spacing:.5px;}
        p{margin:0;opacity:.7;}
        .bar{margin-top:24px;width:240px;height:3px;background:rgba(255,255,255,.12);
          border-radius:2px;overflow:hidden;position:relative;}
        .bar::after{content:'';position:absolute;inset:0;width:40%;
          background:linear-gradient(90deg,transparent,#4ea1ff,transparent);
          animation:slide 1.1s linear infinite;}
        @keyframes slide{from{left:-40%}to{left:100%}}
      </style>
      <h1>FinTrace NCRP</h1><p>Starting the analysis engine…</p><div class="bar"></div>`;
    splashWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  }

  splashWindow.once('ready-to-show', () => {
    if (splashWindow) splashWindow.show();
  });

  splashWindow.on('closed', () => { splashWindow = null; });
}

function destroySplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    try { splashWindow.close(); } catch (_e) { /* best effort */ }
  }
  splashWindow = null;
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
    destroySplash();
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

/**
 * Auto-updater stub. In packaged builds we attempt to wire electron-updater so
 * the app can pick up future releases. The publish target is left unset for
 * now — a real update feed will be configured in a later phase. Failures are
 * swallowed so a missing dependency or missing feed never blocks startup.
 */
function initAutoUpdater() {
  if (IS_DEV) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (_e) {
    log.warn('electron-updater not installed — auto-update disabled');
    return;
  }
  try {
    autoUpdater.logger = log;
    autoUpdater.autoDownload = true;
    autoUpdater.on('error', (err) => log.warn('autoUpdater error', err && err.message));
    autoUpdater.on('update-available', (info) => log.info('Update available', info && info.version));
    autoUpdater.on('update-downloaded', (info) => log.info('Update downloaded', info && info.version));
    // Stub call — no-ops cleanly when no publish feed is configured.
    autoUpdater.checkForUpdatesAndNotify().catch((err) => {
      log.warn('checkForUpdatesAndNotify failed', err && err.message);
    });
  } catch (err) {
    log.warn('autoUpdater initialisation failed', err && err.message);
  }
}

// ─── IPC handlers (whitelisted channels only) ───────────────────────
//
// The preload exposes exactly the channels registered here. Any other channel
// name reaches no handler and rejects with "No handler registered" — which is
// the correct default. Each handler validates its own arguments; the renderer
// is never trusted.

/** Resolved at startup so IPC handlers don't depend on requiring the backend twice. */
let EXPORTS_DIR_RUNTIME = '';

/**
 * Resolve a renderer-supplied PDF file name against EXPORTS_DIR, rejecting any
 * path that escapes the folder (path traversal) or that doesn't exist.
 *
 * @param {unknown} fileName
 * @returns {string | null} Absolute, validated path, or null on rejection.
 */
function resolveExportedPdf(fileName) {
  if (typeof fileName !== 'string' || fileName.trim() === '') return null;
  if (/[\\/]/.test(fileName) || fileName.includes('..')) return null;
  if (!/\.pdf$/i.test(fileName)) return null;

  const candidate = path.resolve(EXPORTS_DIR_RUNTIME, fileName);
  const exportsRoot = path.resolve(EXPORTS_DIR_RUNTIME);
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
    const target = path.resolve(EXPORTS_DIR_RUNTIME);
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
    // Focus existing window instead of opening a new one.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else if (splashWindow) {
      splashWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    installNetworkGuards();
    createSplashWindow();

    const paths = resolveRuntimePaths();
    EXPORTS_DIR_RUNTIME = paths.exportsDir;

    registerIpcHandlers();

    try {
      await startBackend(paths);
    } catch (err) {
      log.error('FinTrace: backend failed to start —', err && err.message ? err.message : err);
      destroySplash();
      dialog.showErrorBox(
        'FinTrace NCRP — startup failed',
        'The analysis engine could not start.\n\n' +
          (err && err.message ? err.message : String(err))
      );
      app.quit();
      return;
    }

    createWindow();
    initAutoUpdater();

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
