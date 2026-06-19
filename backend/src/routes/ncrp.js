'use strict';

/**
 * FinTrace NCRP — REST API routes.
 *
 * Exposes the full backend surface as an Express router. The router is built by
 * a factory that closes over an open better-sqlite3 connection, so it is mounted
 * with the DB injected (no global singleton):
 *
 *   const { createNcrpRouter } = require('./routes/ncrp');
 *   app.use('/api', createNcrpRouter(db));   // → /api/ncrp/... + /api/health
 *
 * Design notes:
 *   • CommonJS, synchronous DB access (better-sqlite3). The only async path is
 *     PDF generation and the post-upload analysis, which runs in the background
 *     via setImmediate so the upload response returns immediately.
 *   • Uploads land in backend/uploads and are kept for re-parse / audit; PDFs
 *     are written to backend/exports.
 *   • Errors use the project's uniform envelope: { error: { code, message } }.
 *
 * @module backend/src/routes/ncrp
 */

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');

// Optional dep — added in Phase 7. If the package isn't installed yet, fall
// back to a no-op middleware so the routes still load during incremental dev.
let rateLimit;
try {
  rateLimit = require('express-rate-limit');
} catch (_e) {
  rateLimit = () => (_req, _res, next) => next();
}

const { parseNcrpFile } = require('../parsers/ncrpParser');
const { analyzeReport, dedupeRows } = require('../analyzers/analyzer');
const {
  insertReport,
  updateReportAnalysis,
  getReportById,
  insertManyTransactions,
  insertLayerAnalysis,
  insertLienRecord,
  updateLienStatus,
  insertDraftEmail,
  upsertRepeatAccount,
  insertAuditLog,
  findReportsByAckNo,
} = require('../db/queries');
const { sha256File, appVersion } = require('../lib/provenance');
const { generateReportPdf } = require('../utils/pdfGenerator');
const { generateReportExcel } = require('../utils/excelGenerator');
const { generateDraftEmails } = require('../utils/emailGenerator');

// ─── On-disk locations (backend/uploads, backend/exports) ────────────
//
// In packaged Electron builds the backend lives inside an ASAR archive (read-
// only), so these MUST be redirected to a writable per-user location.  Electron
// sets FINTRACE_UPLOADS_DIR / FINTRACE_EXPORTS_DIR to userData/uploads and
// userData/exports before requiring this module.  Dev / standalone fallback is
// the original backend/uploads and backend/exports.

const UPLOADS_DIR = (process.env.FINTRACE_UPLOADS_DIR && process.env.FINTRACE_UPLOADS_DIR.trim() !== '')
  ? path.resolve(process.env.FINTRACE_UPLOADS_DIR)
  : path.resolve(__dirname, '..', '..', 'uploads');
const EXPORTS_DIR = (process.env.FINTRACE_EXPORTS_DIR && process.env.FINTRACE_EXPORTS_DIR.trim() !== '')
  ? path.resolve(process.env.FINTRACE_EXPORTS_DIR)
  : path.resolve(__dirname, '..', '..', 'exports');
for (const dir of [UPLOADS_DIR, EXPORTS_DIR]) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_e) { /* surfaced on first write */ }
}

// ─── Upload constraints (FR-01 / SDD override: 50 MB) ────────────────

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.xlsx', '.xls']);
/**
 * Allowed MIME types. The two canonical Office types plus the generic
 * octet-stream that Windows / many browsers send for .xlsx. Extension AND
 * MIME are both checked (defense-in-depth); the parser is the final gate.
 */
const ALLOWED_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls
  'application/octet-stream',
]);

/** Number of transaction rows per SQLite write transaction during ingest. */
const INSERT_BATCH_SIZE = 500;

// ─── Small response / parsing helpers ────────────────────────────────

/**
 * Send a uniform error envelope. In production, `details` is dropped unless
 * the caller marks it `publicDetails: true` — so internal hints (db paths,
 * stack frames, etc.) never reach the renderer.
 *
 * @param {import('express').Response} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, unknown>} [details]
 */
function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details && (process.env.NODE_ENV !== 'production' || details.publicDetails)) {
    error.details = details;
  }
  return res.status(status).json({ error });
}

/**
 * Validate `req.params.id` as a positive integer. Rejects SQL injection
 * attempts, negative numbers, hex/scientific notation, anything non-decimal.
 *
 * @param {import('express').Request} req
 * @returns {number|null}
 */
function parseReportId(req) {
  const raw = req.params.id;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  // Cap at JS safe-int upper bound just to be defensive.
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

// ─── Input validation primitives ─────────────────────────────────────

/** Lien status enum — also enforced by a CHECK constraint at the SQL layer. */
const ALLOWED_LIEN_STATUSES = Object.freeze(['pending', 'applied', 'success', 'rejected']);
/** Draft-email status enum. */
const ALLOWED_EMAIL_STATUSES = Object.freeze(['draft', 'sent']);
/** Pagination caps. */
const MAX_PAGE_LIMIT = 500;
const MAX_PAGE_INDEX = 1_000_000;
/** Free-text query parameter length cap — defends both SQL parsers and the UI. */
const MAX_STRING_PARAM_LEN = 200;

/**
 * Sanitise a string query parameter:
 *   • strip HTML brackets and SQL-comment markers,
 *   • trim and truncate to MAX_STRING_PARAM_LEN.
 * Returns null when the value is empty or not a string.
 *
 * Note: every SQL touch downstream uses bound parameters; this is a
 * defence-in-depth scrub to keep stray tags out of stored fields too.
 *
 * @param {unknown} v
 * @param {number} [maxLen]
 * @returns {string|null}
 */
function sanitizeStringParam(v, maxLen = MAX_STRING_PARAM_LEN) {
  if (v === undefined || v === null) return null;
  const raw = String(v);
  // Drop control characters, angle brackets (XSS), and SQL line-comment "--".
  const cleaned = raw
    // eslint-disable-next-line no-control-regex -- intentional: strip C0 control chars + DEL
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>]/g, '')
    .replace(/--/g, '')
    .trim();
  if (cleaned === '') return null;
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

/**
 * Parse a 1-indexed page number. Returns null on invalid input so callers
 * can return a 400 instead of silently defaulting.
 *
 * @param {unknown} v
 * @param {number} [defaultValue]
 * @returns {number|null}
 */
function parsePage(v, defaultValue = 1) {
  if (v === undefined || v === null || v === '') return defaultValue;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_INDEX) return null;
  return n;
}

/**
 * Parse a page-size value, capped at MAX_PAGE_LIMIT.
 * @param {unknown} v
 * @param {number} [defaultValue]
 * @returns {number|null}
 */
function parseLimit(v, defaultValue = 100) {
  if (v === undefined || v === null || v === '') return defaultValue;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_LIMIT) return null;
  return n;
}

/**
 * Sanitise an original filename for safe display/storage in metadata fields.
 * Strips any path component, then keeps only safe ASCII (alnum, dot, dash,
 * underscore, space). Empty result is replaced with "upload".
 *
 * @param {string} name
 * @returns {string}
 */
function sanitizeOriginalFilename(name) {
  if (typeof name !== 'string') return 'upload';
  const base = path.basename(name);
  const cleaned = base.replace(/[^\w.\- ]+/g, '_').trim();
  const truncated = cleaned.slice(0, 100);
  return truncated || 'upload';
}

/**
 * Verify that the first 8 bytes of `filePath` match an Excel magic number.
 *   • XLSX → ZIP container: starts with "PK" (0x50 0x4B).
 *   • XLS  → OLE2 compound document: D0 CF 11 E0 A1 B1 1A E1.
 *
 * Defends against extension/MIME spoofing — an attacker who uploads
 * malware.exe renamed to malware.xlsx fails the magic-byte check before the
 * parser ever opens the file.
 *
 * @param {string} filePath
 * @returns {boolean}
 */
function isExcelMagicBytes(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(8);
    const bytesRead = fs.readSync(fd, buf, 0, 8, 0);
    if (bytesRead < 4) return false;
    // XLSX: PK\x03\x04 (or empty/spanned variants \x05\x06, \x07\x08).
    if (buf[0] === 0x50 && buf[1] === 0x4B &&
        (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) {
      return true;
    }
    // XLS (OLE2 compound document).
    const OLE2 = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    if (bytesRead >= 8 && OLE2.every((b, i) => buf[i] === b)) return true;
    return false;
  } catch (_e) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  }
}

/**
 * Second-line content gate (after the magic-byte check): confirm the workbook
 * actually looks like an NCRP CompleteTrail export, not just any valid Excel
 * file (or a text file SheetJS happily parses as a one-column CSV).
 *
 * A genuine NCRP sheet always carries at least one of the canonical header
 * tokens. We read only the first few rows of each sheet (`sheetRows: 5`) so the
 * scan is cheap even on a 50 MB workbook, and stop at the first match.
 *
 * @param {string} filePath
 * @returns {boolean} true if any sheet's first rows contain an NCRP header token.
 */
const NCRP_HEADER_TOKEN = /layer|acknowledg|account\s*no|beneficiary|disputed|utr/i;
function looksLikeNcrpFile(filePath) {
  let wb;
  try {
    wb = XLSX.readFile(filePath, { sheetRows: 5, raw: true });
  } catch (_e) {
    return false; // unreadable as a workbook → certainly not an NCRP export
  }
  if (!Array.isArray(wb.SheetNames) || wb.SheetNames.length === 0) return false;
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1, raw: true, defval: null, blankrows: false,
    });
    for (const row of aoa) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        if (cell !== null && cell !== undefined && NCRP_HEADER_TOKEN.test(String(cell))) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Mask an account identifier for officer-facing display: keep the last 4
 * characters, replace the rest with bullets. Short ids (≤4) are returned as-is.
 *
 * @param {unknown} acct
 * @returns {string|null}
 */
function maskAccount(acct) {
  const s = acct === null || acct === undefined ? '' : String(acct).trim();
  if (s === '') return null;
  if (s.length <= 4) return s;
  return `${'•'.repeat(Math.min(s.length - 4, 8))}${s.slice(-4)}`;
}

/** Parse a stored account_list JSON column back to an array. @param {unknown} v */
function parseAccountList(v) {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string' || v.trim() === '') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_e) {
    return [];
  }
}

/** Parse a report's analysis_json column to an object, or null. @param {object} report */
function parseAnalysis(report) {
  if (!report || !report.analysis_json) return null;
  try {
    return JSON.parse(report.analysis_json);
  } catch (_e) {
    return null;
  }
}

// ─── Router factory ──────────────────────────────────────────────────

/**
 * Build the NCRP API router bound to a specific database connection.
 *
 * @param {import('better-sqlite3').Database} db - Open, initialised connection.
 * @returns {import('express').Router} Mount at `/api`.
 */
function createNcrpRouter(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createNcrpRouter: db must be an open better-sqlite3 connection');
  }

  const router = express.Router();
  // JSON bodies only (skips multipart, so the upload route is unaffected).
  router.use(express.json({ limit: '2mb' }));

  // ── Rate limiting (loopback-only, so limits are lenient) ──────────
  //
  // The API is reachable only from the local Electron renderer or a local Vite
  // dev server, so any flood is either a bug or a runaway script. 100 req/min
  // is generous for the dashboards (which fan out 5–10 calls per page), while
  // /upload gets its own 5/min limit because each upload kicks off parsing +
  // analysis. `express-rate-limit` falls back to a no-op if the package isn't
  // installed (see require() at the top of the file).
  //
  // When NODE_ENV === 'test', limiters become no-ops so integration tests can
  // hammer the upload endpoint without tripping the 5-per-minute cap.
  const isTestEnv = process.env.NODE_ENV === 'test';
  const noopLimiter = (_req, _res, next) => next();
  const generalLimiter = isTestEnv ? noopLimiter : rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, 'RATE_LIMITED',
      'Too many requests; please slow down.'),
  });
  const uploadLimiter = isTestEnv ? noopLimiter : rateLimit({
    windowMs: 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, 'RATE_LIMITED',
      'Too many uploads in a short period; please wait a moment.'),
  });
  router.use(generalLimiter);

  // ── Prepared statements (compiled once, reused per request) ────────
  // Parameterised: every statement below uses `?` or `@name` placeholders.
  // No user input is ever concatenated into the SQL string.
  const stmt = {
    listReports: db.prepare(`
      SELECT id, filename, original_filename, upload_date, total_transactions,
             total_disputed_amount, total_layers, analysis_status, created_at
        FROM ncrp_reports
       ORDER BY datetime(created_at) DESC, id DESC
    `),
    allTxns: db.prepare('SELECT * FROM ncrp_transactions WHERE report_id = ?'),
    allRepeats: db.prepare('SELECT * FROM repeat_accounts'),
    layers: db.prepare(
      'SELECT * FROM layer_analysis WHERE report_id = ? ORDER BY layer_no ASC'),
    liens: db.prepare(
      'SELECT * FROM lien_records WHERE report_id = ? ORDER BY lien_amount DESC, id ASC'),
    emails: db.prepare(
      'SELECT * FROM draft_emails WHERE report_id = ? ORDER BY bank_name ASC, id ASC'),
    emailById: db.prepare(
      'SELECT * FROM draft_emails WHERE report_id = ? AND id = ? LIMIT 1'),
    updateEmailStatus: db.prepare(
      'UPDATE draft_emails SET status = @status WHERE id = @id AND report_id = @report_id'),
    lienByAccount: db.prepare(
      'SELECT * FROM lien_records WHERE report_id = ? AND account_no = ? LIMIT 1'),
    accountBankInfo: db.prepare(`
      SELECT beneficiary_bank, ifsc_code
        FROM ncrp_transactions
       WHERE report_id = ? AND beneficiary_account = ? AND beneficiary_bank IS NOT NULL
       LIMIT 1
    `),
    caseInfo: db.prepare(`
      SELECT ack_no, complaint_date
        FROM ncrp_transactions
       WHERE report_id = ? AND ack_no IS NOT NULL
       LIMIT 1
    `),
    updateLienRemarks: db.prepare(
      'UPDATE lien_records SET remarks = @remarks WHERE id = @id'),
    delEmails: db.prepare('DELETE FROM draft_emails WHERE report_id = ?'),
    delLiens: db.prepare('DELETE FROM lien_records WHERE report_id = ?'),
    delLayers: db.prepare('DELETE FROM layer_analysis WHERE report_id = ?'),
    delTxns: db.prepare('DELETE FROM ncrp_transactions WHERE report_id = ?'),
    delReport: db.prepare('DELETE FROM ncrp_reports WHERE id = ?'),
  };

  /** Atomic cascade delete of a report and all owned rows. */
  const deleteReportCascade = db.transaction((reportId) => {
    const emails = stmt.delEmails.run(reportId).changes;
    const liens = stmt.delLiens.run(reportId).changes;
    const layers = stmt.delLayers.run(reportId).changes;
    const transactions = stmt.delTxns.run(reportId).changes;
    stmt.delReport.run(reportId);
    return { emails, liens, layers, transactions };
  });

  // ── Multer (disk storage, UUID names, size + type guards) ─────────
  //
  // Never trust the renderer-supplied filename for on-disk storage. We
  // generate a UUID-based name and keep only the lowercased extension. The
  // sanitised original is preserved in the DB row (ncrp_reports.original_filename)
  // for officer-facing display, but the file on disk never reflects user input.
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '.xlsx';
      cb(null, `ncrp-${crypto.randomUUID()}${safeExt}`);
    },
  });
  const uploadSingle = multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const okExt = ALLOWED_EXTENSIONS.has(ext);
      const okMime = ALLOWED_MIMETYPES.has(file.mimetype);
      if (okExt && okMime) return cb(null, true);
      const err = new Error('Only .xlsx or .xls Excel files are accepted.');
      err.code = 'INVALID_FILE_TYPE';
      return cb(err);
    },
  }).single('ncrpFile');

  /**
   * Look up a report by `:id`, sending the right error and returning null when
   * the id is malformed (400) or the report is absent (404).
   */
  function loadReport(req, res) {
    const id = parseReportId(req);
    if (id === null) {
      sendError(res, 400, 'VALIDATION_FAILED', 'Report id must be a positive integer.');
      return null;
    }
    const report = getReportById(db, id);
    if (!report) {
      sendError(res, 404, 'COMPLAINT_NOT_FOUND', `No report found with id ${id}.`);
      return null;
    }
    return report;
  }

  // ── Background analysis pipeline (post-upload) ─────────────────────

  /**
   * Run the full analysis for a freshly-ingested report and persist all derived
   * tables. Fault-isolated: any failure flips the report to 'error' and is
   * logged, never crashing the process.
   *
   * @param {number} reportId
   */
  async function runAnalysisInBackground(reportId) {
    try {
      updateReportAnalysis(db, reportId, { analysis_status: 'processing' });

      // Re-read rows from the DB so each carries its primary key — the analyzer
      // writes the derived cashout columns back by id.
      const txnRows = stmt.allTxns.all(reportId);
      const existingRepeats = stmt.allRepeats.all();
      const result = await analyzeReport(reportId, txnRows, existingRepeats, { db });

      // Carry the parsed old transactions (stored on the report at upload) into
      // the analysis snapshot so the dossier's data-quality annexure can list
      // them. They never touched any analyzer module — purely informational.
      const reportRow = getReportById(db, reportId);
      if (reportRow && reportRow.old_transactions) {
        try {
          const parsedOld = JSON.parse(reportRow.old_transactions);
          if (Array.isArray(parsedOld) && parsedOld.length > 0) {
            result.old_transactions = parsedOld;
          }
        } catch (_e) { /* malformed JSON → omit, never block analysis */ }
      }

      // Carry the parser's self-healing audit (stored at upload) into the
      // analysis snapshot so the Data Quality page + PDF/Excel parse-audit
      // trail can render it. Purely informational — touched no analyzer module.
      if (reportRow && reportRow.parse_warnings) {
        try {
          const parsedPw = JSON.parse(reportRow.parse_warnings);
          if (Array.isArray(parsedPw) && parsedPw.length > 0) {
            result.parse_warnings = parsedPw;
          }
        } catch (_e) { /* malformed JSON → omit, never block analysis */ }
      }

      // Case context for the per-bank letters.
      let ackNo = null;
      let complaintDate = null;
      for (const t of txnRows) {
        if (!ackNo && t.ack_no) ackNo = t.ack_no;
        if (!complaintDate && t.complaint_date) complaintDate = t.complaint_date;
        if (ackNo && complaintDate) break;
      }
      const emails = generateDraftEmails(reportId, result.lien_calculation, {
        ack_no: ackNo,
        complaint_date: complaintDate,
        total_disputed_amount: result.summary.total_disputed_amount,
      });

      // Persist everything derived in one atomic transaction.
      const persist = db.transaction(() => {
        for (const layer of result.layer_analysis) {
          insertLayerAnalysis(db, { report_id: reportId, ...layer });
        }
        for (const lien of result.lien_calculation) {
          insertLienRecord(db, {
            report_id: reportId,
            account_no: lien.account_no,
            bank_name: lien.bank_name,
            ifsc_code: lien.ifsc_code,
            available_balance: null, // confirmed by the bank, unknown at analysis
            lien_amount: lien.lien_eligible_amount,
            lien_status: 'pending',
            remarks: lien.note,
          });
        }
        for (const email of emails) insertDraftEmail(db, email);
        for (const mule of result.mule_detection) {
          upsertRepeatAccount(db, {
            account_no: mule.account_no,
            bank_name: mule.bank_name,
            first_seen_report_id: reportId,
            amount_passed: mule.total_received,
            mule_score: mule.mule_score,
          });
        }
        updateReportAnalysis(db, reportId, {
          analysis_status: 'complete',
          analysis_json: JSON.stringify(result),
          total_transactions: result.summary.total_transactions,
          total_disputed_amount: result.summary.total_disputed_amount,
          total_layers: result.summary.total_layers,
          fraud_start_date: result.summary.fraud_start_date,
        });
        insertAuditLog(db, {
          report_id: reportId,
          action: 'analysis.complete',
          details: {
            transactions: result.summary.total_transactions,
            layers: result.summary.total_layers,
            module_errors: result.errors,
          },
        });
      });

      // If the officer deleted this report while analysis was still running, the
      // cascade has already removed its rows. Abort quietly instead of running
      // persist() — re-inserting derived rows would otherwise trip the report_id
      // foreign-key guard and surface a misleading 'analysis.error'. There is no
      // await between this check and persist(), and better-sqlite3 is synchronous,
      // so no DELETE can interleave in the gap.
      if (!getReportById(db, reportId)) return;
      persist();
    } catch (err) {
      try {
        updateReportAnalysis(db, reportId, { analysis_status: 'error' });
        insertAuditLog(db, {
          report_id: reportId,
          action: 'analysis.error',
          details: { message: err && err.message ? err.message : String(err) },
        });
      } catch (_e) { /* nothing more we can do */ }
    }
  }

  // ════════════════════════════════════════════════════════════════
  //  Routes
  // ════════════════════════════════════════════════════════════════

  // POST /api/ncrp/upload — ingest an NCRP Excel export, analyse in background.
  router.post('/ncrp/upload', uploadLimiter, (req, res) => {
    uploadSingle(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return sendError(res, 413, 'FILE_TOO_LARGE', 'File exceeds the 50 MB limit.');
        }
        if (err.code === 'INVALID_FILE_TYPE') {
          return sendError(res, 400, 'INVALID_FILE_TYPE', err.message);
        }
        return sendError(res, 500, 'STORAGE_FAILED', 'Could not store the upload.');
      }
      if (!req.file) {
        return sendError(res, 400, 'VALIDATION_FAILED',
          'No file was provided under the "ncrpFile" field.');
      }

      // Magic-byte check: extension/MIME can be spoofed; the file's actual
      // header bytes cannot. Reject and unlink before doing any DB work.
      if (!isExcelMagicBytes(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_e) { /* best effort */ }
        return sendError(res, 400, 'INVALID_FILE_CONTENT',
          'File does not appear to be a valid Excel workbook.');
      }

      // Content gate: a file can pass the magic-byte check (a real .xlsx of
      // unrelated data) or be a text file SheetJS parses as CSV, yet carry none
      // of the NCRP header tokens. Reject those before any DB work so we never
      // ingest a 0-row "report" from a non-NCRP upload.
      if (!looksLikeNcrpFile(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_e) { /* best effort */ }
        return sendError(res, 400, 'INVALID_FILE_CONTENT',
          'File does not appear to be an NCRP CompleteTrail export.');
      }

      const safeOriginalName = sanitizeOriginalFilename(req.file.originalname);

      let parsed;
      try {
        parsed = parseNcrpFile(req.file.path);
      } catch (parseErr) {
        try { fs.unlinkSync(req.file.path); } catch (_e) { /* best effort */ }
        return sendError(res, 400, 'PARSE_FAILED', 'Could not parse the Excel file.');
      }

      // FAIL LOUD: a sheet with data whose required columns could not be
      // confidently mapped produces structured parse errors. Refuse the whole
      // upload — ingesting the remaining sheets would silently drop a channel
      // and put wrong figures in front of the officer. The structured details
      // are publicDetails so the renderer can show sheet / expected / found.
      const parseErrors = parsed.errors || [];
      if (parseErrors.length > 0) {
        try { fs.unlinkSync(req.file.path); } catch (_e) { /* best effort */ }
        const summary = parseErrors
          .map((e) => (e.code === 'UNKNOWN_CHANNEL_WITH_TRANSACTIONS'
            ? `[${e.sheet}] unrecognised sheet with ${e.dataRows} transaction row(s) — channel could not be determined`
            : `[${e.sheet}] missing '${e.expectedColumn}'`))
          .join('; ');
        return sendError(res, 422, 'PARSE_BLOCKED',
          `Upload blocked — the file could not be read safely: ${summary}. ` +
          'No figures were computed. Correct the file or re-export it from NCRP, then retry.',
          { publicDetails: true, parseErrors });
      }

      const rows = parsed.rows || [];
      const warnings = parsed.warnings || [];
      // Structured self-healing audit (fuzzy sheet/column resolutions + degraded
      // informational columns). Persisted on the report and folded into the
      // analysis snapshot so the Data Quality page / PDF / Excel can surface
      // them. Also appended to the upload-response warnings below so the officer
      // sees them immediately — a fuzzy match is never silently accepted.
      const parseWarnings = Array.isArray(parsed.parseWarnings) ? parsed.parseWarnings : [];
      const oldTransactions = Array.isArray(parsed.oldTransactions) ? parsed.oldTransactions : [];

      // Old transactions (>6 months) are informational and excluded from every
      // figure. Surface a non-blocking banner naming the affected (masked)
      // accounts so the officer knows they were set aside, not lost.
      if (oldTransactions.length > 0) {
        const maskedAccounts = [...new Set(
          oldTransactions
            .map((t) => maskAccount(t.account_no))
            .filter(Boolean)
        )];
        warnings.push({
          code: 'OLD_TRANSACTIONS_FOUND',
          message: `${oldTransactions.length} old transaction(s) (>6 months) found in the ` +
            `'Old Transaction' sheet. These are excluded from all financial calculations. ` +
            `Account(s): ${maskedAccounts.join(', ') || '(unspecified)'}.`,
          count: oldTransactions.length,
          accounts: maskedAccounts,
        });
      }

      // ── Evidentiary provenance ────────────────────────────────────────
      // Hash the raw uploaded bytes BEFORE parsing/ingest so the digest is over
      // the exact file the officer submitted. Failure to hash must not block an
      // upload — provenance degrades to "not recorded" rather than losing the
      // case. Node crypto only; no new handler.
      const uploadedAt = new Date().toISOString();
      const version = appVersion();
      let sourceSha256 = null;
      try {
        sourceSha256 = sha256File(req.file.path);
      } catch (_hashErr) {
        warnings.push({
          code: 'PROVENANCE_HASH_FAILED',
          message: 'Could not compute the source-file hash; provenance will be incomplete.',
        });
      }

      // Changed-source detection: if this case (same NCRP acknowledgement
      // number) was previously ingested from a file with a DIFFERENT hash, warn
      // the officer that the source has changed.
      const ackNo = (() => {
        const r = rows.find((row) => row && row.ack_no != null && String(row.ack_no).trim() !== '');
        return r ? String(r.ack_no).trim() : null;
      })();
      if (sourceSha256 && ackNo) {
        try {
          const prior = findReportsByAckNo(db, ackNo)
            .filter((p) => p.source_sha256 && p.source_sha256 !== sourceSha256);
          if (prior.length > 0) {
            const p = prior[0];
            warnings.push({
              code: 'SOURCE_FILE_CHANGED',
              message: `Source changed: case ${ackNo} was previously analysed from a file with a ` +
                `different SHA-256 (report #${p.id}, "${p.original_filename}", ` +
                `uploaded ${p.upload_date}). The figures may differ from the earlier dossier.`,
              ackNo,
              previousReportId: p.id,
              previousSha256: p.source_sha256,
              currentSha256: sourceSha256,
            });
          }
        } catch (_e) { /* detection is best-effort; never blocks ingest */ }
      }

      let reportId;
      try {
        reportId = insertReport(db, {
          filename: req.file.filename,        // UUID-based storage name
          original_filename: safeOriginalName, // sanitised display name
          upload_date: uploadedAt,
          analysis_status: 'pending',
          source_sha256: sourceSha256,
          old_transactions: oldTransactions.length > 0 ? JSON.stringify(oldTransactions) : null,
          parse_warnings: parseWarnings.length > 0 ? JSON.stringify(parseWarnings) : null,
        });

        // Batch the inserts: INSERT_BATCH_SIZE rows per SQLite transaction.
        const withReportId = rows.map((r) => ({ ...r, report_id: reportId }));
        for (let i = 0; i < withReportId.length; i += INSERT_BATCH_SIZE) {
          insertManyTransactions(db, withReportId.slice(i, i + INSERT_BATCH_SIZE));
        }
        // Audit row carries the full provenance tuple: case id (report_id), the
        // original filename, the source SHA-256, the upload timestamp, and the
        // FinTrace version — a tamper-evident record of what was ingested.
        insertAuditLog(db, {
          report_id: reportId,
          action: 'upload.ingested',
          details: {
            filename: safeOriginalName,
            rowCount: rows.length,
            source_sha256: sourceSha256,
            uploaded_at: uploadedAt,
            app_version: version,
            ack_no: ackNo,
            source_changed: warnings.some((w) => w && w.code === 'SOURCE_FILE_CHANGED'),
            old_transaction_count: oldTransactions.length,
          },
        });
      } catch (_dbErr) {
        return sendError(res, 500, 'DB_ERROR', 'Failed to store report.');
      }

      // Surface the structured parse warnings on the upload banner too (they
      // carry a `message`, which the renderer's ParserWarnings panel renders).
      for (const pw of parseWarnings) warnings.push(pw);

      // Respond immediately; analysis continues in the background.
      res.status(202).json({
        reportId,
        filename: safeOriginalName,
        rowCount: rows.length,
        sourceSha256,
        warnings,
      });

      setImmediate(() => { runAnalysisInBackground(reportId); });
    });
  });

  // GET /api/ncrp/reports — all reports, newest first.
  router.get('/ncrp/reports', (_req, res) => {
    const reports = stmt.listReports.all();
    res.json(reports);
  });

  // GET /api/ncrp/:id/transactions — paginated, filterable listing.
  router.get('/ncrp/:id/transactions', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;

    const q = req.query;
    const page = parsePage(q.page);
    if (page === null) {
      return sendError(res, 400, 'VALIDATION_FAILED',
        `page must be a positive integer ≤ ${MAX_PAGE_INDEX}.`);
    }
    const limit = parseLimit(q.limit);
    if (limit === null) {
      return sendError(res, 400, 'VALIDATION_FAILED',
        `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
    }
    const offset = (page - 1) * limit;

    // Prepared statements: every filter value is passed via a named bind
    // parameter; SQL fragments are composed from a fixed allow-list of column
    // names, never from user input.
    const where = ['report_id = @report_id'];
    const params = { report_id: report.id };

    // layer / bank accept comma-separated values (multi-select on the client),
    // expanded into IN(...) clauses with one bound param per value.
    if (q.layer !== undefined && q.layer !== '') {
      const layers = String(q.layer)
        .split(',')
        .map((s) => parseInt(s, 10))
        .filter((n) => Number.isInteger(n) && n >= 0 && n <= 50);
      if (layers.length) {
        const ph = layers.map((_, i) => `@layer${i}`);
        where.push(`layer_no IN (${ph.join(', ')})`);
        layers.forEach((v, i) => { params[`layer${i}`] = v; });
      }
    }
    if (q.bank) {
      const banks = String(q.bank)
        .split(',')
        .map((s) => sanitizeStringParam(s, 100))
        .filter(Boolean);
      if (banks.length) {
        const ph = banks.map((_, i) => `@bank${i}`);
        where.push(`beneficiary_bank IN (${ph.join(', ')})`);
        banks.forEach((v, i) => { params[`bank${i}`] = v; });
      }
    }
    const paymentMode = sanitizeStringParam(q.payment_mode, 32);
    if (paymentMode) {
      where.push('UPPER(payment_mode) = UPPER(@payment_mode)');
      params.payment_mode = paymentMode;
    }
    const dateFrom = sanitizeStringParam(q.date_from, 32);
    if (dateFrom) { where.push('transaction_date >= @date_from'); params.date_from = dateFrom; }
    const dateTo = sanitizeStringParam(q.date_to, 32);
    if (dateTo) { where.push('transaction_date <= @date_to'); params.date_to = dateTo; }
    if (q.min_amount !== undefined && q.min_amount !== '') {
      const v = Number(q.min_amount);
      if (Number.isFinite(v)) { where.push('transaction_amount >= @min_amount'); params.min_amount = v; }
    }
    if (q.max_amount !== undefined && q.max_amount !== '') {
      const v = Number(q.max_amount);
      if (Number.isFinite(v)) { where.push('transaction_amount <= @max_amount'); params.max_amount = v; }
    }
    const search = sanitizeStringParam(q.search, 100);
    if (search) {
      // LIKE wildcard escape: % and _ in user input must not become wildcards.
      const escaped = search.replace(/[\\%_]/g, '\\$&');
      where.push(`(
        beneficiary_account LIKE @search ESCAPE '\\' OR beneficiary_name LIKE @search ESCAPE '\\' OR
        utr_no LIKE @search ESCAPE '\\' OR ifsc_code LIKE @search ESCAPE '\\' OR victim_account LIKE @search ESCAPE '\\'
      )`);
      params.search = `%${escaped}%`;
    }

    const whereSql = where.join(' AND ');
    // Prepared (parameterised) — no concatenation of user input into SQL.
    const total = db.prepare(
      `SELECT COUNT(*) AS n FROM ncrp_transactions WHERE ${whereSql}`).get(params).n;
    // Prepared (parameterised).
    const data = db.prepare(`
      SELECT * FROM ncrp_transactions
       WHERE ${whereSql}
       ORDER BY transaction_date DESC, id DESC
       LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset });

    res.json({
      data,
      total,
      page,
      limit,
      total_pages: total === 0 ? 0 : Math.ceil(total / limit),
    });
  });

  // GET /api/ncrp/:id/layers — per-layer aggregates. Served from the analysis
  // snapshot (which carries the rich Module-5 fields: txn_count, bank_count,
  // fan_out_ratio, top_banks), falling back to the persisted table for reports
  // analysed before those fields existed.
  router.get('/ncrp/:id/layers', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;
    const analysis = parseAnalysis(report);
    if (analysis && Array.isArray(analysis.layer_analysis) && analysis.layer_analysis.length) {
      return res.json(analysis.layer_analysis);
    }
    return res.json(stmt.layers.all(report.id));
  });

  // GET /api/ncrp/:id/mules — mule detection from the analysis snapshot.
  router.get('/ncrp/:id/mules', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;
    const analysis = parseAnalysis(report);
    res.json(analysis && analysis.mule_detection ? analysis.mule_detection : []);
  });

  // GET /api/ncrp/:id/data-quality — accounts whose bank attribution needs IO
  // review (IFSC↔text mismatch, missing/invalid IFSC, unknown prefix). Served
  // from the analysis snapshot.
  router.get('/ncrp/:id/data-quality', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;
    const analysis = parseAnalysis(report);
    res.json(analysis && Array.isArray(analysis.data_quality) ? analysis.data_quality : []);
  });

  // GET /api/ncrp/:id/lien — lien worksheet rows.
  router.get('/ncrp/:id/lien', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;
    res.json(stmt.liens.all(report.id));
  });

  // POST /api/ncrp/:id/lien — insert or update one lien record by account.
  router.post('/ncrp/:id/lien', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;

    const body = req.body || {};
    const accountNo = sanitizeStringParam(body.account_no, 64);
    const lienStatus = body.lien_status;
    const remarks = body.remarks === undefined
      ? undefined
      : sanitizeStringParam(body.remarks, 500);

    if (!accountNo) {
      return sendError(res, 400, 'VALIDATION_FAILED', 'account_no is required.');
    }
    if (lienStatus !== undefined && lienStatus !== null && !ALLOWED_LIEN_STATUSES.includes(lienStatus)) {
      return sendError(res, 400, 'INVALID_STATUS',
        `lien_status must be one of: ${ALLOWED_LIEN_STATUSES.join(', ')}.`);
    }

    try {
      const existing = stmt.lienByAccount.get(report.id, accountNo);
      if (existing) {
        if (lienStatus) updateLienStatus(db, existing.id, lienStatus); // stamps applied_date
        if (remarks !== undefined) {
          stmt.updateLienRemarks.run({ id: existing.id, remarks });
        }
        insertAuditLog(db, {
          report_id: report.id,
          action: 'lien.updated',
          details: { account_no: accountNo, lien_status: lienStatus ?? existing.lien_status },
        });
        return res.json(stmt.lienByAccount.get(report.id, accountNo));
      }

      // New record — enrich bank/IFSC from a transaction for this account.
      const info = stmt.accountBankInfo.get(report.id, accountNo) || {};
      insertLienRecord(db, {
        report_id: report.id,
        account_no: accountNo,
        bank_name: info.beneficiary_bank ?? null,
        ifsc_code: info.ifsc_code ?? null,
        available_balance: null,
        lien_amount: null,
        lien_status: lienStatus || 'pending',
        remarks: remarks ?? null,
      });
      insertAuditLog(db, {
        report_id: report.id,
        action: 'lien.created',
        details: { account_no: accountNo, lien_status: lienStatus || 'pending' },
      });
      return res.status(201).json(stmt.lienByAccount.get(report.id, accountNo));
    } catch (_err) {
      return sendError(res, 500, 'DB_ERROR', 'Failed to save lien record.');
    }
  });

  // GET /api/ncrp/:id/emails — draft letters (generated on first access).
  router.get('/ncrp/:id/emails', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;

    let emails = stmt.emails.all(report.id);
    if (emails.length === 0) {
      const liens = stmt.liens.all(report.id);
      if (liens.length > 0) {
        const ci = stmt.caseInfo.get(report.id) || {};
        const generated = generateDraftEmails(report.id, liens, {
          ack_no: ci.ack_no ?? null,
          complaint_date: ci.complaint_date ?? null,
          total_disputed_amount: report.total_disputed_amount ?? 0,
        });
        const insertAll = db.transaction(() => {
          for (const e of generated) insertDraftEmail(db, e);
        });
        insertAll();
        emails = stmt.emails.all(report.id);
      }
    }

    res.json(emails.map((e) => ({ ...e, account_list: parseAccountList(e.account_list) })));
  });

  // POST /api/ncrp/:id/emails/:emailId — update a draft email's status.
  router.post('/ncrp/:id/emails/:emailId', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;

    const raw = req.params.emailId;
    const emailId = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : null;
    if (emailId === null) {
      return sendError(res, 400, 'VALIDATION_FAILED', 'emailId must be a positive integer.');
    }

    const status = req.body && req.body.status;
    if (!ALLOWED_EMAIL_STATUSES.includes(status)) {
      return sendError(res, 400, 'INVALID_STATUS',
        `status must be one of: ${ALLOWED_EMAIL_STATUSES.join(', ')}.`);
    }

    const existing = stmt.emailById.get(report.id, emailId);
    if (!existing) {
      return sendError(res, 404, 'NOT_FOUND', `No draft email ${emailId} for report ${report.id}.`);
    }

    stmt.updateEmailStatus.run({ id: emailId, report_id: report.id, status });
    insertAuditLog(db, {
      report_id: report.id,
      action: 'email.status_updated',
      details: { email_id: emailId, status },
    });
    const updated = stmt.emailById.get(report.id, emailId);
    return res.json({ ...updated, account_list: parseAccountList(updated.account_list) });
  });

  // GET /api/ncrp/:id/timeline — timeline from the analysis snapshot.
  router.get('/ncrp/:id/timeline', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;
    const analysis = parseAnalysis(report);
    res.json(analysis && analysis.timeline ? analysis.timeline : []);
  });

  // GET /api/ncrp/:id/geography — geography from the analysis snapshot.
  router.get('/ncrp/:id/geography', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;
    const analysis = parseAnalysis(report);
    res.json(analysis && analysis.geography ? analysis.geography : { by_state: [], by_city: [] });
  });

  // GET /api/ncrp/:id/payment-modes — full payment-mode distribution.
  //
  // Distribution over the report's de-duplicated LEDGER ROWS — not a sampled
  // page — so the dashboard donut summarises the whole case. Returns one row per
  // mode (count + summed amount); the payload stays tiny regardless of dataset
  // size (~10 rows). Mode is normalised the same way the UI groups it: trimmed,
  // blank/NULL → "OTHERS", upper-cased — so colours and labels line up.
  //
  // EXACT-DUPLICATE EXCLUSION: the same money is routinely re-listed across NCRP
  // channel sheets; the analyzer collapses those before computing every figure.
  // The donut must agree, or its total is inflated by dedup artifacts. Rather
  // than re-deriving the dedup key here (a second definition that could silently
  // drift), we REUSE the analyzer's `dedupeRows` — the single dedup source of
  // truth — so the donut counts exactly the same de-duplicated ledger as the rest
  // of the case (e.g. report …170: 2411 raw → 2162; the 249 collapsed legs are
  // surfaced on the dashboard as `summary.duplicate_count`). This counts ALL row
  // kinds (transfers + HOLD/OTHER dispositions), which is why the donut is
  // labelled "LEDGER ROWS" — a deliberately different figure from the headline
  // transaction (hop) count.
  router.get('/ncrp/:id/payment-modes', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;
    // Reuse the analyzer's exact-duplicate collapse on the raw ledger rows (it
    // keys only on the base fields present here, so no enrichment is needed).
    const { rows: deduped } = dedupeRows(stmt.allTxns.all(report.id));
    /** @type {Map<string, { mode: string, count: number, amount: number }>} */
    const byMode = new Map();
    for (const t of deduped) {
      const trimmed = String(t.payment_mode == null ? '' : t.payment_mode).trim();
      const mode = (trimmed === '' ? 'OTHERS' : trimmed.toUpperCase());
      if (!byMode.has(mode)) byMode.set(mode, { mode, count: 0, amount: 0 });
      const m = byMode.get(mode);
      m.count += 1;
      m.amount += Number(t.transaction_amount) || 0;
    }
    const modes = [...byMode.values()]
      .map((m) => ({ mode: m.mode, count: m.count, amount: Math.round(m.amount * 100) / 100 }))
      // Same ordering as before: largest mode first, ties broken by name.
      .sort((a, b) => (b.count - a.count) || (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0));
    const total = modes.reduce((s, m) => s + m.count, 0);
    res.json({ modes, total });
  });

  // GET /api/ncrp/:id/pdf — generate the dossier and return it.
  //
  // Two delivery modes:
  //   • default            → stream the file as an attachment (browser / Vite dev).
  //   • ?mode=file         → write to EXPORTS_DIR and return { fileName } JSON.
  //     The packaged Electron renderer uses this because new windows are denied
  //     (main.js setWindowOpenHandler), so it cannot rely on a browser download;
  //     instead it opens the returned file via the OS handler over IPC.
  router.get('/ncrp/:id/pdf', async (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;

    const fileMode = req.query.mode === 'file';
    console.log(`[ncrp] GET /ncrp/${report.id}/pdf (mode=${fileMode ? 'file' : 'download'})`);

    try {
      const analysis = parseAnalysis(report) || {};
      const liens = stmt.liens.all(report.id);
      const emails = stmt.emails.all(report.id)
        .map((e) => ({ ...e, account_list: parseAccountList(e.account_list) }));
      const layers = stmt.layers.all(report.id);
      // Raw ledger: drives the writer-side ATM/POS exit split and the POS
      // merchant table (same bundle field the Excel export already passes).
      const transactions = db.prepare(
        'SELECT * FROM ncrp_transactions WHERE report_id = ? ORDER BY transaction_date ASC, id ASC'
      ).all(report.id);
      const ci = stmt.caseInfo.get(report.id) || {};

      const safeAck = String(ci.ack_no || `report-${report.id}`).replace(/[^\w.-]+/g, '_');
      const fileName = `FinTrace-${safeAck}-${Date.now()}.pdf`;
      const outPath = path.join(EXPORTS_DIR, fileName);

      await generateReportPdf({
        report, analysis, liens, emails, layers, transactions,
        ack_no: ci.ack_no ?? null,
        complaint_date: ci.complaint_date ?? null,
      }, outPath);

      insertAuditLog(db, {
        report_id: report.id, action: 'pdf.generated', details: { file: fileName },
      });

      // Electron path: the file is already on disk in EXPORTS_DIR; hand the
      // renderer just the bare name so it can open it via shell.openPath IPC.
      if (fileMode) {
        return res.json({ fileName });
      }

      return res.download(outPath, fileName, (err) => {
        if (err) console.error('[ncrp] res.download failed:', err);
        if (err && !res.headersSent) {
          sendError(res, 500, 'PDF_GENERATION_FAILED', 'Could not send the PDF.');
        }
      });
    } catch (err) {
      console.error('[ncrp] PDF generation failed:', err);
      if (!res.headersSent) {
        return sendError(res, 500, 'PDF_GENERATION_FAILED',
          'Could not generate the PDF.');
      }
    }
  });

  // GET /api/ncrp/:id/excel — build the multi-sheet workbook and return it.
  //
  // Same dual delivery as /pdf: stream the buffer as an attachment by default,
  // or (?mode=file) write it to EXPORTS_DIR and return { fileName } for the
  // Electron renderer to open over IPC.
  router.get('/ncrp/:id/excel', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;

    const fileMode = req.query.mode === 'file';
    console.log(`[ncrp] GET /ncrp/${report.id}/excel (mode=${fileMode ? 'file' : 'download'})`);

    try {
      const analysis = parseAnalysis(report) || {};
      const liens = stmt.liens.all(report.id);
      // Full ledger, ordered for readability (chronological).
      const transactions = db.prepare(
        'SELECT * FROM ncrp_transactions WHERE report_id = ? ORDER BY transaction_date ASC, id ASC'
      ).all(report.id);
      const ci = stmt.caseInfo.get(report.id) || {};

      const buffer = generateReportExcel({
        report, analysis, liens, transactions,
        ack_no: ci.ack_no ?? null,
        complaint_date: ci.complaint_date ?? null,
      });

      const safeAck = String(ci.ack_no || `report-${report.id}`).replace(/[^\w.-]+/g, '_');
      const fileName = `FinTrace-${safeAck}-${Date.now()}.xlsx`;

      insertAuditLog(db, {
        report_id: report.id, action: 'excel.generated', details: { file: fileName },
      });

      // Electron path: persist the workbook to EXPORTS_DIR and return its name
      // so the renderer can open it via shell.openPath IPC (new windows are
      // denied in the packaged app, so an attachment stream can't be saved).
      if (fileMode) {
        const outPath = path.join(EXPORTS_DIR, fileName);
        fs.writeFileSync(outPath, buffer);
        return res.json({ fileName });
      }

      res.setHeader('Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
      res.setHeader('Content-Length', String(buffer.length));
      return res.end(buffer);
    } catch (err) {
      console.error('[ncrp] Excel generation failed:', err);
      if (!res.headersSent) {
        return sendError(res, 500, 'EXCEL_GENERATION_FAILED', 'Could not generate the Excel workbook.');
      }
      return undefined;
    }
  });

  // DELETE /api/ncrp/:id — delete report + cascade owned rows.
  router.delete('/ncrp/:id', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;
    try {
      const counts = deleteReportCascade(report.id);
      insertAuditLog(db, {
        report_id: report.id, action: 'report.deleted', details: counts,
      });
      res.json({ deleted: true, id: report.id, removed: counts });
    } catch (err) {
      console.error('[ncrp] delete failed:', err);
      sendError(res, 500, 'DB_ERROR', 'Failed to delete report.');
    }
  });

  // GET /api/ncrp/:id/audit — recent audit-log entries for a report.
  router.get('/ncrp/:id/audit', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;

    const limit = parseLimit(req.query.limit, 200);
    if (limit === null) {
      return sendError(res, 400, 'VALIDATION_FAILED',
        `limit must be an integer between 1 and ${MAX_PAGE_LIMIT}.`);
    }

    // Parameterised — report_id and limit are bound, never concatenated.
    const rows = db.prepare(`
      SELECT id, report_id, action, details, timestamp
        FROM audit_log
       WHERE report_id = @report_id
       ORDER BY datetime(timestamp) DESC, id DESC
       LIMIT @limit
    `).all({ report_id: report.id, limit });

    // Parse JSON `details` for the client where possible; leave other strings alone.
    const data = rows.map((row) => {
      let details = row.details;
      if (typeof details === 'string') {
        try { details = JSON.parse(details); } catch (_e) { /* leave as string */ }
      }
      return { ...row, details };
    });
    res.json(data);
  });

  // GET /api/ncrp/:id — full report with analysis_json parsed.
  router.get('/ncrp/:id', (req, res) => {
    const report = loadReport(req, res);
    if (!report) return;
    res.json({ ...report, analysis_json: parseAnalysis(report) });
  });

  // GET /api/health — liveness probe. Does NOT leak the SQLite file path —
  // that's sensitive on a single-tenant desktop install where the path can
  // reveal the user's username under %AppData%.
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // ── Fallbacks ──────────────────────────────────────────────────────

  // Unmatched API route.
  router.use((req, res) => {
    sendError(res, 404, 'NOT_FOUND', `No route for ${req.method} ${req.originalUrl}.`);
  });

  // Error handler (malformed JSON bodies, anything thrown synchronously).
  //
  // Logs the full error server-side (electron-log captures stack frames in
  // packaged builds) but never returns the message/stack to the renderer in
  // production — a generic envelope only. Dev mode keeps the message inline
  // so the developer console still gets a hint.
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, _next) => {
    if (res.headersSent) return;
    if (err && err.type === 'entity.parse.failed') {
      return sendError(res, 400, 'VALIDATION_FAILED', 'Request body is not valid JSON.');
    }
    console.error('[ncrp] unhandled error:', err);
    const isProd = process.env.NODE_ENV === 'production';
    const msg = isProd
      ? 'Something went wrong.'
      : (err && err.message ? err.message : 'Unexpected error.');
    sendError(res, 500, 'ERR_500', msg);
  });

  return router;
}

module.exports = {
  createNcrpRouter,
  UPLOADS_DIR,
  EXPORTS_DIR,
  // Upload content gates — exported for direct testing (accuracy_test.js).
  isExcelMagicBytes,
  looksLikeNcrpFile,
};
