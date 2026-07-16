/**
 * Bank Statement module — API client.
 *
 * Real calls to the `/api/bank-statement/*` routes (backend
 * routes/bankStatements.js) via the SHARED axios instance from
 * src/utils/api.js — so every request automatically carries the session
 * bearer token, the `/api` prefix, and the normalised ApiError envelope.
 *
 * Only the column-mapping save is still a stub: the manual mapping wizard is
 * UI-only this milestone (unrecognised banks have no ingestion path yet).
 */

import api from '../../../utils/api.js';

/**
 * List ingested statements, newest first.
 * @returns {Promise<Array<{ id: number, account_number: string,
 *   account_holder: string|null, ifsc: string|null, bank_name: string|null,
 *   branch: string|null, statement_period_from: string|null,
 *   statement_period_to: string|null, original_filename: string|null,
 *   source_format: string, source_sha256: string|null, txn_count: number,
 *   uploaded_at: string }>>}
 */
export const listStatements = () =>
  api.get('/bank-statement/statements').then((r) => r.data.data);

/** One statement's metadata (parse_warnings decoded to an array). */
export const getStatement = (id) =>
  api.get(`/bank-statement/statements/${id}`).then((r) => r.data);

/**
 * Upload a statement file (multipart). The backend sniffs the container
 * (magic bytes), detects the bank from CONTENT, and — for recognised banks —
 * parses + persists the canonical transactions in the same request.
 *
 * @param {File} file
 * @param {(percent: number) => void} [onProgress]
 * @returns {Promise<(
 *   { recognized: true, statementId: number, bank: string, bankName: string,
 *     confidence: number, format: string, account: object, txnCount: number,
 *     sourceSha256: string|null, warnings: string[] } |
 *   { recognized: false, filename: string, format: string, detectedHeaders: string[] }
 * )>}
 */
export function uploadStatement(file, onProgress) {
  const form = new FormData();
  form.append('statementFile', file);
  return api
    .post('/bank-statement/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000, // parse happens inside the request for statements
      onUploadProgress: (e) => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      },
    })
    .then((r) => r.data);
}

/**
 * Paginated transactions for one statement, in native statement order.
 * @param {number} statementId
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{ data: object[], total: number, page: number,
 *   limit: number, total_pages: number }>}
 */
export const getStatementTransactions = (statementId, params = {}) =>
  api.get(`/bank-statement/statements/${statementId}/transactions`, { params })
    .then((r) => r.data);

/**
 * Persist a confirmed column mapping — STILL A STUB. The wizard stays
 * UI-only until a generic (mapped-column) ingestion path exists; parsing is
 * PNB-only this milestone.
 * TODO(bank-statement/backend): POST /api/bank-statement/files/:id/mapping
 * @param {string} fileId
 * @param {{ mapping: Record<string,string>, saveAsTemplate: boolean }} payload
 */
export async function saveColumnMapping(fileId, payload) {
  return { ok: true, fileId, ...payload };
}

/**
 * Suggest a canonical field for a sniffed header label, so the mapping
 * wizard's dropdowns are pre-seeded from the REAL headers the backend found
 * in an unrecognised spreadsheet.
 *
 * @param {string} header
 * @returns {string} one of mockData.CANONICAL_FIELDS values
 */
export function suggestFieldForHeader(header) {
  const h = String(header || '').toLowerCase();
  if (/date/.test(h)) return 'date';
  if (/narration|particular|description|detail|remark/.test(h)) return 'narration';
  if (/withdraw|debit|\bdr\b/.test(h)) return 'debit';
  if (/deposit|credit|\bcr\b/.test(h)) return 'credit';
  if (/balance/.test(h)) return 'balance';
  return 'ignore';
}
