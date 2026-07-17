/**
 * Bank Statement module — API client.
 *
 * Real calls to the `/api/bank-statement/*` routes (backend
 * routes/bankStatements.js) via the SHARED axios instance from
 * src/utils/api.js — so every request automatically carries the session
 * bearer token, the `/api` prefix, and the normalised ApiError envelope.
 *
 * The mapping wizard is real: apply-mapping parses a pending upload with the
 * officer's column mapping and can save it as a reusable bank template.
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
 * Wizard confirmation: parse the PENDING upload (kept on disk by the
 * unrecognised-upload response) with the officer's confirmed column mapping.
 * Persists the canonical transactions and — when saveAsTemplate — stores the
 * mapping + detection signature so this bank auto-detects next time.
 *
 * @param {{ fileId: string, filename?: string,
 *   mapping: { version: number, columns: Record<string,string>, options?: object },
 *   bankName?: string, saveAsTemplate?: boolean }} payload
 * @returns {Promise<{ recognized: true, via: 'wizard', statementId: number,
 *   templateId: number|null, bank: string|null, txnCount: number,
 *   warnings: string[], continuity: { checked: boolean,
 *   direction: string|null, breakCount: number } }>}
 */
export const applyMapping = (payload) =>
  api.post('/bank-statement/apply-mapping', payload, { timeout: 120000 })
    .then((r) => r.data);

/** Saved bank templates (mapping + detection signature), newest first. */
export const listTemplates = () =>
  api.get('/bank-statement/templates').then((r) => r.data.data);

/**
 * Cached single-statement analysis (summary, counterparty distribution,
 * top-N, behavioral flags). Computed at ingest; pre-analysis statements get
 * theirs on first read.
 *
 * @param {number} statementId
 * @returns {Promise<{ statementId: number, analyzed_at: string|null, analysis: object }>}
 */
export const getStatementAnalysis = (statementId) =>
  api.get(`/bank-statement/statements/${statementId}/analysis`).then((r) => r.data);
