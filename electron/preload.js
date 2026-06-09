'use strict';

/**
 * FinTrace NCRP — preload bridge.
 *
 * Runs in an isolated world (contextIsolation: true, sandbox: true) and exposes
 * a narrow, whitelisted IPC surface on `window.fintrace`. The renderer never
 * sees `ipcRenderer` or `require` — only the four functions below, all of which
 * round-trip through `ipcRenderer.invoke` so every call is awaitable and every
 * channel is validated by name on the main side.
 *
 * Whitelisted channels (must match `main.js` ipcMain.handle registrations):
 *   • app:get-version    → returns the packaged app version string
 *   • shell:open-pdf     → opens a generated PDF in the OS PDF handler
 *   • shell:open-exports → opens the exports/ folder in the OS file manager
 *   • dialog:save-pdf    → prompts the user to save a copy of a generated PDF
 *
 * Any channel not in ALLOWED_CHANNELS is rejected at the preload boundary
 * before it ever reaches the main process. The main process performs a second,
 * authoritative whitelist check.
 *
 * @module electron/preload
 */

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Hard-coded allow-list. Any channel string not in this Set is rejected.
 * @type {ReadonlyArray<string>}
 */
const ALLOWED_CHANNELS = Object.freeze([
  'app:get-version',
  'shell:open-pdf',
  'shell:open-file',
  'shell:open-exports',
  'dialog:save-pdf',
]);

/**
 * Wrapper for `ipcRenderer.invoke` that throws synchronously if the channel
 * is not whitelisted. Defence-in-depth: even though we only call this with
 * literal channel strings below, the runtime check prevents any future caller
 * (or an attacker who finds a way to import this file) from invoking arbitrary
 * channels.
 *
 * @param {string} channel
 * @param {...unknown} args
 * @returns {Promise<unknown>}
 */
function invoke(channel, ...args) {
  if (!ALLOWED_CHANNELS.includes(channel)) {
    return Promise.reject(new Error(`IPC channel not allowed: ${channel}`));
  }
  return ipcRenderer.invoke(channel, ...args);
}

// ─── Exposed renderer API ────────────────────────────────────────────
// Keep this surface small. Every function here is reachable from the renderer
// at runtime as `window.fintrace.<name>`.

contextBridge.exposeInMainWorld('fintrace', {
  /** Get the packaged app version (read from package.json by main). */
  getVersion: () => invoke('app:get-version'),

  /**
   * Open a generated PDF in the OS default PDF handler.
   * The main process validates that the path is inside EXPORTS_DIR.
   * @param {string} fileName - Bare file name (no slashes / backslashes).
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  openPdf: (fileName) => invoke('shell:open-pdf', fileName),

  /**
   * Open a generated export file (PDF or XLSX) in its OS-default handler.
   * The main process validates that the path is inside EXPORTS_DIR.
   * @param {string} fileName - Bare file name (no slashes / backslashes).
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  openFile: (fileName) => invoke('shell:open-file', fileName),

  /**
   * Open the exports/ folder in the OS file manager.
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  openExportsFolder: () => invoke('shell:open-exports'),

  /**
   * Prompt the user to save a copy of a generated PDF. The main process
   * validates that the source path is inside EXPORTS_DIR before copying.
   * @param {string} fileName - Source file name within exports/.
   * @returns {Promise<{ ok: true, savedTo: string } | { ok: false, error: string }>}
   */
  savePdfCopy: (fileName) => invoke('dialog:save-pdf', fileName),
});
