/**
 * FinTrace NCRP — Axios API client.
 *
 * One configured Axios instance plus a typed function per backend route. The
 * backend (backend/src/routes/ncrp.js) is mounted at `/api` on the loopback
 * server, and replies with a uniform error envelope:
 *
 *   { "error": { "code": "...", "message": "...", "details"?: {...} } }
 *
 * The response interceptor unwraps that envelope into a normalised `ApiError`
 * so every caller can rely on `err.code` / `err.message` regardless of whether
 * the failure was an HTTP error, a network drop, or a timeout.
 */

import axios from 'axios';

// Per spec: bare origin. The `/api` mount prefix lives on each path below so a
// future reverse-proxy/base change is a one-line edit here.
export const API_BASE_URL = 'http://127.0.0.1:3847';
const API_PREFIX = '/api';

/** Normalised error thrown by every client function. */
export class ApiError extends Error {
  constructor(message, { code = 'UNKNOWN', status = 0, details = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

const api = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30000,
  headers: { 'Content-Type': 'application/json' },
});

// ─── Session token (Phase 1 auth) ───────────────────────────────────
// The session token lives in memory only (set by AuthContext after login),
// mirroring the backend's in-memory session — app close / reload = logout.
let authToken = null;
/** @param {string|null} token */
export function setAuthToken(token) { authToken = token || null; }

// Registered by AuthContext so a 401 anywhere (expired/invalid session) drops
// the app back to the login screen instead of surfacing a raw error.
let onUnauthorized = null;
/** @param {null | (() => void)} cb */
export function setUnauthorizedHandler(cb) { onUnauthorized = cb || null; }

// ─── Request interceptor ────────────────────────────────────────────
// Stamp every request with a relative `/api` prefix unless it is already
// absolute, and attach the session token when we have one.
api.interceptors.request.use((config) => {
  const url = config.url || '';
  if (!/^https?:\/\//i.test(url) && !url.startsWith(API_PREFIX)) {
    config.url = `${API_PREFIX}${url.startsWith('/') ? '' : '/'}${url}`;
  }
  if (authToken) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${authToken}`;
  }
  return config;
});

// ─── Response interceptor ───────────────────────────────────────────
// Pass success through untouched; fold every failure into an ApiError.
api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      const { status, data } = error.response;
      const env = data && typeof data === 'object' ? data.error : null;
      const code = (env && env.code) || 'HTTP_ERROR';
      // A 401 means the session is gone/expired — hand control back to the auth
      // layer so the UI returns to login rather than showing a raw error. (Not
      // for the login endpoint itself, whose 401 is a bad-credentials result.)
      const isLoginCall = (error.config && error.config.url || '').includes('/auth/login');
      if (status === 401 && onUnauthorized && !isLoginCall) {
        try { onUnauthorized(code); } catch (_e) { /* never let the handler mask the error */ }
      }
      throw new ApiError(
        (env && env.message) || `Request failed with status ${status}.`,
        { code, status, details: env && env.details },
      );
    }
    if (error.request) {
      throw new ApiError(
        'Could not reach the FinTrace backend. Is it running on port 3847?',
        { code: 'NETWORK_ERROR' },
      );
    }
    throw new ApiError(error.message || 'Unexpected request error.', {
      code: 'REQUEST_SETUP_ERROR',
    });
  },
);

export default api;

// ════════════════════════════════════════════════════════════════════
//  Endpoint functions — one per backend route.
// ════════════════════════════════════════════════════════════════════

/** Liveness probe. GET /api/health → { status, timestamp, dbPath }. */
export const checkHealth = () => api.get('/health').then((r) => r.data);

/**
 * Upload an NCRP Excel export. Returns 202 immediately; analysis runs in the
 * background, so poll {@link getReport} until analysis_status === 'complete'.
 *
 * @param {File} file - The .xlsx / .xls file from a file input or drop.
 * @param {(percent: number) => void} [onProgress] - Upload progress (0–100).
 * @returns {Promise<{ reportId: number, filename: string, rowCount: number, warnings: string[] }>}
 */
export function uploadReport(file, onProgress) {
  const form = new FormData();
  form.append('ncrpFile', file);
  return api
    .post('/ncrp/upload', form, {
      headers: { 'Content-Type': 'multipart/form-data' },
      timeout: 120000, // large files take longer to stream + persist
      onUploadProgress: (e) => {
        if (onProgress && e.total) {
          onProgress(Math.round((e.loaded / e.total) * 100));
        }
      },
    })
    .then((r) => r.data);
}

/** List all reports, newest first. */
export const listReports = () => api.get('/ncrp/reports').then((r) => r.data);

/** Full report with `analysis_json` parsed into an object. */
export const getReport = (id) => api.get(`/ncrp/${id}`).then((r) => r.data);

/** Delete a report and all its owned rows (cascade). */
export const deleteReport = (id) => api.delete(`/ncrp/${id}`).then((r) => r.data);

/**
 * Paginated, filterable transaction listing.
 * @param {number} id
 * @param {object} [params] - page, limit, layer, bank, payment_mode,
 *   date_from, date_to, min_amount, max_amount, search.
 * @returns {Promise<{ data: object[], total: number, page: number, limit: number, total_pages: number }>}
 */
export const getTransactions = (id, params = {}) =>
  api.get(`/ncrp/${id}/transactions`, { params }).then((r) => r.data);

/**
 * Distinct filter values actually PRESENT in a report (unfiltered), so the
 * Transactions page builds its Bank / Layer filters from the real data instead
 * of a hardcoded list (which silently matched zero rows for banks stored under a
 * different canonical name).
 * @param {number} id
 * @returns {Promise<{ banks: Array<{ name: string, count: number }>,
 *   layers: Array<{ layer: number, count: number }> }>}
 */
export const getTransactionFacets = (id) =>
  api.get(`/ncrp/${id}/transaction-facets`).then((r) => r.data);

/**
 * Full payment-mode distribution for a report — `{ modes: [{ mode, count,
 * amount }], total }`, aggregated server-side over ALL transactions (not a
 * page). Drives the dashboard donut.
 */
export const getPaymentModes = (id) =>
  api.get(`/ncrp/${id}/payment-modes`).then((r) => r.data);

/** Persisted per-layer aggregates. */
export const getLayers = (id) => api.get(`/ncrp/${id}/layers`).then((r) => r.data);

/** Mule-detection rows from the analysis snapshot. */
export const getMules = (id) => api.get(`/ncrp/${id}/mules`).then((r) => r.data);

/**
 * Feature 3 — aggregator (collection-point) accounts + summary strip.
 * @param {number} id
 * @returns {Promise<{ accounts: Array<object>, summary: object }>}
 */
export const getAggregators = (id) => api.get(`/ncrp/${id}/aggregators`).then((r) => r.data);

/**
 * Features 4/5 — cash/exit channel analytics (ATM/POS/AEPS KPIs, behavioural
 * flags, top cities/points) from the analysis snapshot.
 * @param {number} id
 * @returns {Promise<{ summary: object, channels: Record<string, object> }>}
 */
export const getCashExit = (id) => api.get(`/ncrp/${id}/cash-exit`).then((r) => r.data);

/** Streaming-attachment URL for the Cash/Exit workbook (browser/dev). */
export function cashExitExcelUrl(id, params = {}) {
  const q = new URLSearchParams(params).toString();
  return `${API_BASE_URL}${API_PREFIX}/ncrp/${id}/cash-exit/excel${q ? `?${q}` : ''}`;
}

/**
 * Open the Cash/Exit Excel workbook. Same dual behaviour as {@link openReportExcel}:
 * Electron writes via ?mode=file + opens over IPC; browser opens the attachment URL.
 * @param {number} id
 * @param {{ scope?: 'full'|'view', channel?: string, flag?: string }} [params]
 */
export async function openCashExitExcel(id, params = {}) {
  if (isElectron()) {
    const { fileName } = await api
      .get(`/ncrp/${id}/cash-exit/excel`, { params: { ...params, mode: 'file' } })
      .then((r) => r.data);
    const res = await window.fintrace.openFile(fileName);
    if (!res || !res.ok) {
      throw new ApiError((res && res.error) || 'Could not open the workbook.', { code: 'OPEN_FAILED' });
    }
    return;
  }
  window.open(cashExitExcelUrl(id, params), '_blank', 'noopener');
}

/**
 * Lightweight actionable counts for the sidebar count badges.
 * @param {number} id
 * @returns {Promise<{ aggregators: number, cash_exit_flags: number }>}
 */
export const getReportBadges = (id) => api.get(`/ncrp/${id}/badges`).then((r) => r.data);

/** Lien worksheet rows. */
export const getLiens = (id) => api.get(`/ncrp/${id}/lien`).then((r) => r.data);

/**
 * Bank-attribution data-quality rows: accounts whose bank the IFSC could not
 * silently confirm (IFSC↔text mismatch, missing/invalid IFSC, unknown prefix).
 * @param {number} id
 * @returns {Promise<Array<{ account_no: string, ifsc_code: string|null, bank: string,
 *   raw_bank: string|null, bank_source: string|null, bank_flag: string, message: string }>>}
 */
export const getDataQuality = (id) =>
  api.get(`/ncrp/${id}/data-quality`).then((r) => r.data);

/**
 * Insert or update a lien record by account.
 * @param {number} id
 * @param {{ account_no: string, lien_status?: string, remarks?: string }} payload
 */
export const saveLien = (id, payload) =>
  api.post(`/ncrp/${id}/lien`, payload).then((r) => r.data);

/**
 * Draft lien-request artifacts for a report.
 * @param {number} id
 * @returns {Promise<{
 *   emails: Array<{ id: number, bank_name: string, subject: string, body: string,
 *     account_list: string[], flagged_accounts: string[], status: 'draft'|'sent' }>,
 *   wallet_instruments: Array<{ account_no: string, bank_name: string,
 *     source_ref: string|null, amount: number, note: string }>,
 *   masked_accounts: Array<{ account_no: string, bank_name: string,
 *     ifsc_code: string|null, amount: number, note: string }>,
 * }>} Per-bank §102 letters plus the two non-actionable sections.
 */
export const getEmails = (id) => api.get(`/ncrp/${id}/emails`).then((r) => r.data);

/**
 * Update a draft email's status (e.g. mark a letter as sent).
 * @param {number} id - Report id.
 * @param {number} emailId - draft_emails row id.
 * @param {'draft'|'sent'} status
 */
export const updateEmailStatus = (id, emailId, status) =>
  api.post(`/ncrp/${id}/emails/${emailId}`, { status }).then((r) => r.data);

/**
 * Row Drill-Down Modal — entity detail payload.
 * @param {number|string} id - Report id.
 * @param {string} type - 'account' | (later phases: 'atm', 'merchant', …).
 * @param {Record<string, string|number>} params - Identifier params (e.g. { id: accountNo }).
 * @returns {Promise<{ entity_type: string, entity_id: string, context: object,
 *   summary: object, notes: string[], rows: object[], searchable: string[] }>}
 */
export const getEntityDetail = (id, type, params = {}) =>
  api.get(`/ncrp/${id}/entity/${type}`, { params }).then((r) => r.data);

/** Streaming-attachment URL for a drill-down export (browser/dev). */
export function entityExcelUrl(id, type, params = {}) {
  const clean = Object.fromEntries(
    Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  const q = new URLSearchParams(clean).toString();
  return `${API_BASE_URL}${API_PREFIX}/ncrp/${id}/entity/${type}/excel${q ? `?${q}` : ''}`;
}

/**
 * Export the drill-down modal's CURRENT view as .xlsx via the native "Save As"
 * dialog — the same dialog-first dual-mode flow as {@link saveReportExcel}:
 *
 *   • Electron → show the OS save dialog FIRST ({@link suggestExportName}-style
 *     default). If the user cancels, return { canceled: true } and generate
 *     nothing. Otherwise generate via ?mode=file (backend writes to the
 *     per-user exports folder) and copy to the chosen path over IPC.
 *   • Browser (Vite dev) → open the streaming attachment URL; the browser's
 *     own download prompt handles the destination.
 *
 * Pass `search` in params so the workbook holds exactly the rows the modal is
 * showing (the backend re-applies the same filter rule).
 *
 * @param {number|string} id
 * @param {string} type
 * @param {Record<string, string|number>} [params] - Identifier params + { search }.
 * @param {string} [suggestedName] - Pre-filled file name for the dialog.
 * @returns {Promise<{ savedTo: string|null } | { canceled: true }>}
 */
export async function saveEntityExcel(id, type, params = {}, suggestedName) {
  if (!isElectron()) {
    window.open(entityExcelUrl(id, type, params), '_blank', 'noopener');
    return { savedTo: null };
  }
  const dlg = await window.fintrace.showSaveDialog({ type: 'excel', defaultName: suggestedName });
  if (!dlg || dlg.canceled || !dlg.filePath) return { canceled: true };

  const { fileName } = await api
    .get(`/ncrp/${id}/entity/${type}/excel`, { params: { ...params, mode: 'file' } })
    .then((r) => r.data);
  const res = await window.fintrace.saveExportAs(fileName, dlg.filePath);
  if (!res || !res.ok) {
    throw new ApiError((res && res.error) || 'Could not save the workbook.', { code: 'SAVE_FAILED' });
  }
  return { savedTo: res.savedTo };
}

/** Daily timeline from the analysis snapshot. */
export const getTimeline = (id) => api.get(`/ncrp/${id}/timeline`).then((r) => r.data);

/** Geography (by_state / by_city) from the analysis snapshot. */
export const getGeography = (id) => api.get(`/ncrp/${id}/geography`).then((r) => r.data);

/** Absolute URL to the dossier PDF download (browser/dev: open in a new tab). */
export const reportPdfUrl = (id) => `${API_BASE_URL}${API_PREFIX}/ncrp/${id}/pdf`;

/** Absolute URL to the multi-sheet Excel workbook download. */
export const reportExcelUrl = (id) => `${API_BASE_URL}${API_PREFIX}/ncrp/${id}/excel`;

/**
 * True when running inside the packaged Electron shell (preload bridge present).
 * In that environment new windows are denied, so a browser-style blob/attachment
 * download cannot work — exports must round-trip through the OS handler via IPC.
 */
export const isElectron = () =>
  typeof window !== 'undefined' &&
  window.fintrace &&
  typeof window.fintrace.openFile === 'function';

/**
 * Open the dossier PDF for a report.
 *
 *   • Electron → ask the backend to write the PDF to the per-user exports folder
 *     (`?mode=file` → `{ fileName }`) and open it through the OS handler over IPC.
 *   • Browser (Vite dev) → open the streaming attachment URL in a new tab.
 *
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function openReportPdf(id) {
  if (isElectron()) {
    const { fileName } = await api
      .get(`/ncrp/${id}/pdf`, { params: { mode: 'file' } })
      .then((r) => r.data);
    const res = await window.fintrace.openFile(fileName);
    if (!res || !res.ok) {
      throw new ApiError((res && res.error) || 'Could not open the PDF.', { code: 'OPEN_FAILED' });
    }
    return;
  }
  window.open(reportPdfUrl(id), '_blank', 'noopener');
}

/**
 * Open the multi-sheet Excel workbook for a report. Same dual behaviour as
 * {@link openReportPdf}.
 *
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function openReportExcel(id) {
  if (isElectron()) {
    const { fileName } = await api
      .get(`/ncrp/${id}/excel`, { params: { mode: 'file' } })
      .then((r) => r.data);
    const res = await window.fintrace.openFile(fileName);
    if (!res || !res.ok) {
      throw new ApiError((res && res.error) || 'Could not open the workbook.', { code: 'OPEN_FAILED' });
    }
    return;
  }
  window.open(reportExcelUrl(id), '_blank', 'noopener');
}

/**
 * Build a sensible, filesystem-safe default file name for a report export,
 * pre-filled into the native Save-As dialog (the user can still rename it).
 * Derived from the uploaded NCRP file name (which carries the case identity),
 * falling back to the report id.
 *
 * @param {{ id?: number, original_filename?: string }} report
 * @param {'pdf'|'excel'} type
 * @returns {string} e.g. "FinTrace_32709250080512_CompleteTrail_Report.pdf"
 */
export function suggestExportName(report, type) {
  const id = report && report.id != null ? report.id : '';
  const base = String((report && report.original_filename) || `case-${id}`)
    .replace(/\.[^.]+$/, '')        // drop extension
    .replace(/[^\w.-]+/g, '_')      // filesystem-safe
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  const safeBase = base || `case-${id}` || 'report';
  return type === 'excel'
    ? `FinTrace_${safeBase}_Export.xlsx`
    : `FinTrace_${safeBase}_Report.pdf`;
}

/**
 * Save the dossier PDF to a user-chosen location via a native "Save As" dialog.
 *
 *   • Electron → show the OS save dialog FIRST. If the user cancels, return
 *     { canceled: true } and write nothing. Otherwise generate the PDF into the
 *     per-user exports folder (`?mode=file`) and copy it to the chosen path over
 *     IPC, returning { savedTo }.
 *   • Browser (Vite dev) → fall back to the streaming attachment download, which
 *     the browser saves through its own download prompt.
 *
 * @param {number} id
 * @param {string} [suggestedName] - Pre-filled file name for the dialog.
 * @returns {Promise<{ savedTo: string|null } | { canceled: true }>}
 */
export async function saveReportPdf(id, suggestedName) {
  if (!isElectron()) {
    window.open(reportPdfUrl(id), '_blank', 'noopener');
    return { savedTo: null };
  }
  const dlg = await window.fintrace.showSaveDialog({ type: 'pdf', defaultName: suggestedName });
  if (!dlg || dlg.canceled || !dlg.filePath) return { canceled: true };

  const { fileName } = await api
    .get(`/ncrp/${id}/pdf`, { params: { mode: 'file' } })
    .then((r) => r.data);
  const res = await window.fintrace.saveExportAs(fileName, dlg.filePath);
  if (!res || !res.ok) {
    throw new ApiError((res && res.error) || 'Could not save the PDF.', { code: 'SAVE_FAILED' });
  }
  return { savedTo: res.savedTo };
}

/**
 * Save the multi-sheet Excel workbook to a user-chosen location. Same
 * dialog-first behaviour as {@link saveReportPdf}.
 *
 * @param {number} id
 * @param {string} [suggestedName] - Pre-filled file name for the dialog.
 * @returns {Promise<{ savedTo: string|null } | { canceled: true }>}
 */
export async function saveReportExcel(id, suggestedName) {
  if (!isElectron()) {
    window.open(reportExcelUrl(id), '_blank', 'noopener');
    return { savedTo: null };
  }
  const dlg = await window.fintrace.showSaveDialog({ type: 'excel', defaultName: suggestedName });
  if (!dlg || dlg.canceled || !dlg.filePath) return { canceled: true };

  const { fileName } = await api
    .get(`/ncrp/${id}/excel`, { params: { mode: 'file' } })
    .then((r) => r.data);
  const res = await window.fintrace.saveExportAs(fileName, dlg.filePath);
  if (!res || !res.ok) {
    throw new ApiError((res && res.error) || 'Could not save the workbook.', { code: 'SAVE_FAILED' });
  }
  return { savedTo: res.savedTo };
}

/**
 * Map an {@link ApiError} to an officer-facing message per the Phase 6 error
 * rules. Returns undefined for cases best served by the raw `error.message`
 * (so {@link ErrorAlert} falls back to it):
 *   • NETWORK_ERROR → backend is down.
 *   • 404           → report missing.
 *   • 5xx           → technical message + MINT support pointer.
 *
 * @param {ApiError|Error|null} error
 * @returns {string|undefined}
 */
export function friendlyErrorMessage(error) {
  if (!error) return undefined;
  if (error.code === 'NETWORK_ERROR') {
    return 'Backend not available. Please restart the application.';
  }
  if (error.status === 404) {
    return 'Report not found. It may have been deleted.';
  }
  if (typeof error.status === 'number' && error.status >= 500) {
    return `${error.message} — please contact MINT support.`;
  }
  return undefined;
}

/**
 * Poll {@link getReport} until analysis settles ('complete' | 'error') or the
 * attempt budget is exhausted. Used by the upload flow.
 *
 * @param {number} id
 * @param {{ intervalMs?: number, maxAttempts?: number }} [opts]
 * @returns {Promise<object>} The settled report.
 */
export function pollReportUntilDone(id, { intervalMs = 2000, maxAttempts = 30 } = {}) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return (async () => {
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // eslint-disable-next-line no-await-in-loop
      const report = await getReport(id);
      if (report.analysis_status === 'complete' || report.analysis_status === 'error') {
        return report;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(intervalMs);
    }
    throw new ApiError('Analysis timed out. Please check the report status and retry.', {
      code: 'ANALYSIS_TIMEOUT',
    });
  })();
}

// ════════════════════════════════════════════════════════════════════
//  Auth + user management (Phase 1)
// ════════════════════════════════════════════════════════════════════

/** POST /api/auth/login → { token, user }. */
export const authLogin = (username, password) =>
  api.post('/auth/login', { username, password }).then((r) => r.data);

/** POST /api/auth/logout. */
export const authLogout = () => api.post('/auth/logout').then((r) => r.data);

/** GET /api/auth/me → { user, must_change_password }. */
export const authMe = () => api.get('/auth/me').then((r) => r.data);

/** POST /api/auth/change-password → { user }. */
export const authChangePassword = (oldPassword, newPassword) =>
  api.post('/auth/change-password', { oldPassword, newPassword }).then((r) => r.data);

/** GET /api/auth/policy → { policy }. */
export const authPolicy = () => api.get('/auth/policy').then((r) => r.data);

/** GET /api/users → { users } (System Admin only). */
export const listUsers = () => api.get('/users').then((r) => r.data.users);

/** POST /api/users → { user } (System Admin only). */
export const createUser = (payload) => api.post('/users', payload).then((r) => r.data.user);

/** PUT /api/users/:id/role → { user }. */
export const setUserRole = (id, role) =>
  api.put(`/users/${id}/role`, { role }).then((r) => r.data.user);

/** PUT /api/users/:id/active → { user }. */
export const setUserActive = (id, active) =>
  api.put(`/users/${id}/active`, { active }).then((r) => r.data.user);

/** POST /api/users/:id/reset-password → { user }. */
export const resetUserPassword = (id, newPassword) =>
  api.post(`/users/${id}/reset-password`, { newPassword }).then((r) => r.data.user);
