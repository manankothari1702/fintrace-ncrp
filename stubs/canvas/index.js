'use strict';

/**
 * Stub for the native `canvas` module (see package.json for why).
 *
 * Exports an empty object: pdfjs-dist probes `require('canvas')` inside a
 * try/catch purely to polyfill DOMMatrix/Path2D for RENDERING, and finding
 * no usable exports it degrades exactly as if the module were absent —
 * the path the backend test suite (and the 96/96 PNB PDF reconciliation)
 * already runs on. Any future code that genuinely tries to render via
 * canvas will fail loudly here instead of silently pulling a
 * native-compile requirement back into the build.
 */
module.exports = {};
