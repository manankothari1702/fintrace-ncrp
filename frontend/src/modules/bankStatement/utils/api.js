/**
 * Bank Statement module — API client (STUB).
 *
 * No backend exists for this module yet. This file marks exactly where the
 * real calls will go so wiring them up later is a mechanical change and the
 * call sites in the pages already read like the finished thing.
 *
 * The real routes will live under `/api/bank-statement/*` on the same loopback
 * Express server (port 3847) the NCRP module uses. Until then every function
 * here resolves mock data after a short delay to mimic a network round-trip.
 *
 *   TODO(bank-statement/backend): implement these routes and swap the mock
 *   bodies for real axios calls. Suggested surface:
 *     GET    /api/bank-statement/files              → list uploaded files + detection
 *     POST   /api/bank-statement/upload             → upload + auto-detect a statement
 *     POST   /api/bank-statement/files/:id/mapping  → save a column mapping (+ template)
 *     GET    /api/bank-statement/accounts           → parsed accounts
 *     GET    /api/bank-statement/transactions       → parsed transactions
 */

import { MOCK_FILES, mockDetect } from './mockData.js';

/** Small helper so the stubs feel asynchronous like the real client will. */
function delay(value, ms = 250) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * List uploaded statement files with their detection results.
 * TODO(bank-statement/backend): GET /api/bank-statement/files
 */
export async function listStatementFiles() {
  return delay(MOCK_FILES);
}

/**
 * Upload a statement file and run bank auto-detection.
 * TODO(bank-statement/backend): POST /api/bank-statement/upload (multipart)
 * For now we only echo the filename through the toy detector — the file bytes
 * are never read.
 * @param {File} file
 */
export async function uploadStatement(file) {
  const detection = mockDetect(file?.name);
  return delay({ id: `local-${file?.name}-${file?.size}`, name: file?.name, size: file?.size, ...detection });
}

/**
 * Persist a confirmed column mapping for a file, optionally saving it as a
 * reusable template for future files from the same bank.
 * TODO(bank-statement/backend): POST /api/bank-statement/files/:id/mapping
 * @param {string} fileId
 * @param {{ mapping: Record<string,string>, saveAsTemplate: boolean }} payload
 */
export async function saveColumnMapping(fileId, payload) {
  // No-op in this pass; resolves so the UI can show a success state.
  return delay({ ok: true, fileId, ...payload });
}
