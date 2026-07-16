'use strict';

/**
 * FinTrace Bank Statement module — API routes.
 *
 * Real ingestion endpoints replacing the frontend module's mock stubs.
 * Mounted at `/api/bank-statement` (scoped, and BEFORE the NCRP router —
 * routes/ncrp.js ends in a catch-all 404 fallback, so anything mounted
 * after it is unreachable):
 *
 *   POST /api/bank-statement/upload                      (upload_report)
 *   GET  /api/bank-statement/statements                  (view_cases)
 *   GET  /api/bank-statement/statements/:id              (view_cases)
 *   GET  /api/bank-statement/statements/:id/transactions (view_cases, paginated)
 *
 * Security posture mirrors routes/ncrp.js exactly: every route funnels
 * through the same requireAuth choke-point plus a per-route permission from
 * lib/roles.js (uploading a statement is permission-equivalent to uploading
 * an NCRP report → upload_report; reads → view_cases). Uploads get UUID
 * on-disk names (client filename never touches the filesystem), an
 * extension allow-list (.xls/.xlsx/.csv/.pdf), a magic-byte check per
 * container format (OLE2/ZIP for Excel, %PDF for PDF, NUL-free text for
 * CSV), size caps, and rate limiting.
 *
 * Bank detection is CONTENT-based (see parsers/bankStatement/detect):
 * recognised PNB files are parsed + persisted; unrecognised files get
 * `{ recognized: false }` plus best-effort sniffed headers so the manual
 * mapping wizard has real column names — the file itself is not retained.
 *
 * @module backend/src/routes/bankStatements
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const express = require('express');
const multer = require('multer');

// express-rate-limit with the same graceful fallback as routes/ncrp.js.
let rateLimit;
try {
  // eslint-disable-next-line global-require
  rateLimit = require('express-rate-limit');
} catch (_e) {
  rateLimit = null;
}

const { createRequireAuth, createRequirePermission } = require('../middleware/requireAuth');
const { PERMISSIONS } = require('../lib/roles');
const { sha256File } = require('../lib/provenance');
const { insertAuditLog } = require('../db/queries');
const {
  insertStatement, insertManyStatementTransactions,
  listStatements, getStatementById, getStatementTransactions,
  insertTemplate, listTemplates, getTemplateById, deleteTemplate,
} = require('../db/bankStatementQueries');
const { detectBank } = require('../parsers/bankStatement/detect');
const { parsePnbExcel } = require('../parsers/bankStatement/pnbExcel');
const { parsePnbPdf } = require('../parsers/bankStatement/pnbPdf');
const {
  readTabularRows, findHeaderRowGeneric, previewRows, suggestMapping, sniffPreambleFacts,
} = require('../parsers/bankStatement/tabular');
const { parseWithMapping, validateBalanceContinuity } = require('../parsers/bankStatement/genericMapped');
const { buildSignature, findMatchingTemplate } = require('../parsers/bankStatement/templateMatch');

// ─── On-disk location (same redirect contract as routes/ncrp.js) ─────

const UPLOADS_DIR = (process.env.FINTRACE_UPLOADS_DIR && process.env.FINTRACE_UPLOADS_DIR.trim() !== '')
  ? path.resolve(process.env.FINTRACE_UPLOADS_DIR)
  : path.resolve(__dirname, '..', '..', 'uploads');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch (_e) { /* surfaced on first write */ }

// ─── Upload constraints ──────────────────────────────────────────────

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(['.xls', '.xlsx', '.csv', '.pdf']);
const ALLOWED_MIMETYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // .xls
  'application/pdf',
  'text/csv',
  'application/csv',
  'application/octet-stream', // what Windows/browsers often send
]);

/** Pagination caps (mirrors routes/ncrp.js). */
const MAX_PAGE_LIMIT = 500;
const MAX_PAGE_INDEX = 1_000_000;

/**
 * Shape of the on-disk name multer gives every upload. apply-mapping only
 * ever touches files matching this (a bare UUID name inside UPLOADS_DIR —
 * no client-supplied paths), and only wizard-eligible extensions.
 */
const PENDING_FILE_RE = /^bankstmt-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(csv|xls|xlsx)$/;

// ─── Helpers ─────────────────────────────────────────────────────────

/** Uniform error envelope — same shape as routes/ncrp.js sendError. */
function sendError(res, status, code, message, details) {
  const error = { code, message };
  if (details && (process.env.NODE_ENV !== 'production' || details.publicDetails)) {
    error.details = details;
  }
  return res.status(status).json({ error });
}

/** Validate `req.params.id` as a positive integer (no hex/sci notation). */
function parseStatementId(req) {
  const raw = req.params.id;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

/** Parse a 1-indexed page query param. */
function parsePage(v) {
  if (v === undefined) return 1;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_INDEX) return null;
  return n;
}

/** Parse a page-size query param (capped at MAX_PAGE_LIMIT). */
function parseLimit(v) {
  if (v === undefined) return 100;
  if (typeof v !== 'string' || !/^\d+$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > MAX_PAGE_LIMIT) return null;
  return n;
}

/** Strip path separators/control chars from the client filename for display. */
function sanitizeOriginalName(name) {
  const base = path.basename(String(name || ''));
  // eslint-disable-next-line no-control-regex -- intentional: strip C0 control chars + DEL
  const cleaned = base.replace(/[\x00-\x1f\x7f<>]/g, '').trim();
  return cleaned === '' ? 'statement' : cleaned.slice(0, 200);
}

/**
 * Sniff the container format from magic bytes and cross-check it against the
 * file extension (defence-in-depth: malware.exe renamed to statement.pdf
 * fails here before any parser opens it).
 *
 *   .xls        → OLE2 compound document
 *   .xlsx       → ZIP (PK\x03\x04 family)
 *   .pdf        → %PDF-
 *   .csv        → plain text (no NUL bytes in the first 4 KB)
 *
 * @param {string} filePath
 * @param {string} ext - lowercased extension including the dot.
 * @returns {'excel'|'pdf'|'csv'|null} canonical format, or null on mismatch.
 */
function sniffContainerFormat(filePath, ext) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, buf, 0, 4096, 0);
    if (bytesRead < 4) return null;

    const isZip = buf[0] === 0x50 && buf[1] === 0x4B &&
      (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07);
    const OLE2 = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    const isOle2 = bytesRead >= 8 && OLE2.every((b, i) => buf[i] === b);
    const isPdf = buf.slice(0, 5).toString('latin1') === '%PDF-';

    if (ext === '.xls' || ext === '.xlsx') return (isZip || isOle2) ? 'excel' : null;
    if (ext === '.pdf') return isPdf ? 'pdf' : null;
    if (ext === '.csv') {
      if (isZip || isOle2 || isPdf) return null; // binary masquerading as CSV
      for (let i = 0; i < bytesRead; i++) {
        if (buf[i] === 0x00) return null;
      }
      return 'csv';
    }
    return null;
  } catch (_e) {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_e) { /* ignore */ }
    }
  }
}

/** Best-effort unlink of a rejected/consumed upload. */
function tryUnlink(filePath) {
  if (!filePath) return;
  try { fs.unlinkSync(filePath); } catch (_e) { /* already gone */ }
}

// ─── Router factory ──────────────────────────────────────────────────

/**
 * Build the bank-statement API router bound to an open DB connection.
 * Mount at `/api/bank-statement`, BEFORE the NCRP router (whose catch-all 404 would otherwise swallow these paths).
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {object} [authCtx] - auth context; when present every route goes
 *   through requireAuth + a per-route permission (the app always passes it).
 * @returns {import('express').Router}
 */
function createBankStatementRouter(db, authCtx) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('createBankStatementRouter: db must be an open better-sqlite3 connection');
  }

  const router = express.Router();
  router.use(express.json({ limit: '1mb' }));

  const requireAuth = authCtx
    ? createRequireAuth(authCtx)
    : (_req, _res, next) => next();
  const P = authCtx
    ? (permission) => createRequirePermission(permission)
    : () => (_req, _res, next) => next();

  router.use(requireAuth);

  /** Audit helper stamped with the acting user (same shape as ncrp.js). */
  const audit = (req, entry) => {
    const u = (req && req.user) || {};
    insertAuditLog(db, {
      ...entry,
      user_id: u.userId != null ? u.userId : null,
      username: u.username != null ? u.username : null,
    });
  };

  // Rate limiting: same posture as routes/ncrp.js (loopback-only backend,
  // no-op under NODE_ENV=test, graceful no-op when the package is missing).
  const isTestEnv = process.env.NODE_ENV === 'test';
  const noopLimiter = (_req, _res, next) => next();
  const makeLimiter = (max, message) => (isTestEnv || !rateLimit) ? noopLimiter : rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    validate: { creationStack: false },
    handler: (_req, res) => sendError(res, 429, 'RATE_LIMITED', message),
  });
  router.use(makeLimiter(100, 'Too many requests; please slow down.'));
  const uploadLimiter = makeLimiter(5, 'Too many uploads in a short period; please wait a moment.');

  /**
   * Persist a parsed statement (+ its transactions, atomically) and audit
   * it. Shared by the template auto-apply and wizard apply paths (the PNB
   * dedicated path keeps its original inline block, unchanged).
   */
  const persistStatement = (req, {
    parsed, format, originalName, storedFile, sourceSha256, warnings, via, bankLabel, templateId,
  }) => {
    const insertBoth = db.transaction(() => {
      const statementId = insertStatement(db, {
        ...parsed.account,
        source_file: storedFile,
        original_filename: originalName,
        source_format: format,
        source_sha256: sourceSha256,
        txn_count: parsed.transactions.length,
        parse_warnings: warnings.length > 0 ? warnings : null,
      });
      insertManyStatementTransactions(db, statementId, parsed.transactions);
      return statementId;
    });
    const statementId = insertBoth();
    audit(req, {
      action: 'bank_statement.uploaded',
      details: {
        statement_id: statementId,
        bank: bankLabel,
        via,
        template_id: templateId != null ? templateId : null,
        account_number: parsed.account.account_number,
        source_format: format,
        source_sha256: sourceSha256,
        txn_count: parsed.transactions.length,
        original_filename: originalName,
      },
    });
    return statementId;
  };

  // ── Multer (disk storage, UUID names, size + type guards) ──────────
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const safeExt = ALLOWED_EXTENSIONS.has(ext) ? ext : '.bin';
      cb(null, `bankstmt-${crypto.randomUUID()}${safeExt}`);
    },
  });
  const uploadSingle = multer({
    storage,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      if (!ALLOWED_EXTENSIONS.has(ext) || !ALLOWED_MIMETYPES.has(file.mimetype)) {
        const err = new Error('Only .xls, .xlsx, .csv and .pdf statements are accepted');
        err.code = 'INVALID_FILE_TYPE';
        return cb(err);
      }
      return cb(null, true);
    },
  }).single('statementFile');

  // ── POST /bank-statement/upload ────────────────────────────────────
  router.post('/upload', uploadLimiter, P(PERMISSIONS.UPLOAD_REPORT), (req, res) => {
    uploadSingle(req, res, async (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return sendError(res, 413, 'FILE_TOO_LARGE',
            `Statement exceeds the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB limit.`);
        }
        if (err.code === 'INVALID_FILE_TYPE') {
          return sendError(res, 400, 'INVALID_FILE_TYPE', err.message);
        }
        return sendError(res, 400, 'UPLOAD_FAILED', 'Upload failed.', { reason: err.message });
      }
      if (!req.file) {
        return sendError(res, 400, 'NO_FILE', 'Attach the statement as "statementFile".');
      }

      const filePath = req.file.path;
      const originalName = sanitizeOriginalName(req.file.originalname);
      const ext = path.extname(req.file.filename).toLowerCase();

      try {
        // Magic-byte gate: the content must match what the extension claims.
        const format = sniffContainerFormat(filePath, ext);
        if (!format) {
          tryUnlink(filePath);
          return sendError(res, 400, 'INVALID_FILE_CONTENT',
            'File content does not match its extension (failed magic-byte check).');
        }

        // Content-based bank detection (never filename-based). Dedicated
        // parsers (PNB) always take priority; templates and the wizard are
        // the fallback for everything else.
        const detected = await detectBank(filePath, format);
        if (!detected) {
          if (format === 'pdf') {
            // The wizard cannot help a PDF: its column boundaries come from
            // text x-positions, not from a header row a user could map. A
            // dedicated per-bank parser is required.
            tryUnlink(filePath);
            return res.status(200).json({
              recognized: false,
              wizardEligible: false,
              reason: 'PDF_NEEDS_DEDICATED_PARSER',
              message: 'This PDF layout is not recognised. PDF statements need a '
                + 'dedicated per-bank parser — upload the bank\'s Excel/CSV export '
                + 'instead to map its columns with the wizard.',
              filename: originalName,
              format,
            });
          }

          let rows;
          try {
            rows = readTabularRows(filePath);
          } catch (readErr) {
            tryUnlink(filePath);
            return sendError(res, 422, 'PARSE_BLOCKED', 'The file could not be read as a table.',
              { reason: readErr.message, publicDetails: true });
          }

          // Saved template match? Auto-apply — the "detects next time" payoff.
          const template = findMatchingTemplate(listTemplates(db), rows);
          if (template) {
            try {
              const mapping = JSON.parse(template.mapping);
              const parsed = parseWithMapping(rows, mapping, { bankName: template.bank_name });
              const continuity = validateBalanceContinuity(parsed.transactions);
              const warnings = [...parsed.warnings, ...continuity.warnings];
              let sourceSha256 = null;
              try {
                sourceSha256 = sha256File(filePath);
              } catch (hashErr) {
                warnings.push(`PROVENANCE_HASH_FAILED: ${hashErr.message}`);
              }
              const statementId = persistStatement(req, {
                parsed, format, originalName, storedFile: req.file.filename,
                sourceSha256, warnings, via: 'template',
                bankLabel: template.bank_name, templateId: template.id,
              });
              return res.status(201).json({
                recognized: true,
                via: 'template',
                templateId: template.id,
                statementId,
                bank: template.bank_name,
                bankName: template.bank_name,
                format,
                account: parsed.account,
                txnCount: parsed.transactions.length,
                sourceSha256,
                warnings,
                continuity: {
                  checked: continuity.checked,
                  direction: continuity.direction,
                  breakCount: continuity.breakCount,
                },
              });
            } catch (_tmplErr) {
              // A stale or mismatched template must never block ingestion —
              // fall through to the wizard so the officer can re-map.
            }
          }

          // Wizard path: KEEP the stored file so apply-mapping can parse it.
          const header = findHeaderRowGeneric(rows);
          if (!header) {
            tryUnlink(filePath);
            return res.status(200).json({
              recognized: false,
              wizardEligible: false,
              reason: 'NO_TABLE_HEADER',
              message: 'No table header row could be found in this file, so its '
                + 'columns cannot be mapped.',
              filename: originalName,
              format,
            });
          }
          return res.status(200).json({
            recognized: false,
            wizardEligible: true,
            fileId: req.file.filename,
            filename: originalName,
            format,
            detectedHeaders: header.headers,
            suggested: suggestMapping(header.headers),
            preview: previewRows(rows, header.headerRow, header.headers.length),
            inferred: sniffPreambleFacts(rows, header.headerRow),
          });
        }

        // Provenance hash over the raw bytes, before parsing (NCRP contract).
        let sourceSha256 = null;
        const uploadWarnings = [];
        try {
          sourceSha256 = sha256File(filePath);
        } catch (hashErr) {
          uploadWarnings.push(`PROVENANCE_HASH_FAILED: ${hashErr.message}`);
        }

        let parsed;
        try {
          parsed = format === 'pdf' ? await parsePnbPdf(filePath) : parsePnbExcel(filePath);
        } catch (parseErr) {
          tryUnlink(filePath);
          return sendError(res, 422, 'PARSE_BLOCKED',
            'The statement was recognised as PNB but could not be parsed.',
            { reason: parseErr.message, code: parseErr.code, publicDetails: true });
        }

        const warnings = [...uploadWarnings, ...parsed.warnings];
        const insertBoth = db.transaction(() => {
          const statementId = insertStatement(db, {
            ...parsed.account,
            source_file: req.file.filename,
            original_filename: originalName,
            source_format: format,
            source_sha256: sourceSha256,
            txn_count: parsed.transactions.length,
            parse_warnings: warnings.length > 0 ? warnings : null,
          });
          insertManyStatementTransactions(db, statementId, parsed.transactions);
          return statementId;
        });
        const statementId = insertBoth();

        audit(req, {
          action: 'bank_statement.uploaded',
          details: {
            statement_id: statementId,
            bank: detected.bank,
            account_number: parsed.account.account_number,
            source_format: format,
            source_sha256: sourceSha256,
            txn_count: parsed.transactions.length,
            original_filename: originalName,
          },
        });

        return res.status(201).json({
          recognized: true,
          statementId,
          bank: detected.bank,
          bankName: detected.bankName,
          confidence: detected.confidence,
          format,
          account: parsed.account,
          txnCount: parsed.transactions.length,
          sourceSha256,
          warnings,
        });
      } catch (unexpected) {
        tryUnlink(filePath);
        return sendError(res, 500, 'UPLOAD_FAILED', 'Statement ingestion failed.',
          { reason: unexpected.message });
      }
    });
  });

  // ── POST /bank-statement/apply-mapping ─────────────────────────────
  // Wizard confirmation: parse a PENDING upload (kept on disk by the
  // unrecognized-upload response) with the officer's column mapping,
  // persist the canonical transactions, and optionally save the mapping as
  // a reusable bank template so this layout auto-detects next time.
  router.post('/apply-mapping', P(PERMISSIONS.UPLOAD_REPORT), (req, res) => {
    const body = req.body || {};
    const { fileId, mapping } = body;
    const saveAsTemplate = body.saveAsTemplate === true;
    const originalName = sanitizeOriginalName(body.filename);
    const bankName = typeof body.bankName === 'string'
      ? body.bankName.replace(/[<>]/g, '').trim().slice(0, 80)
      : '';

    if (typeof fileId !== 'string' || !PENDING_FILE_RE.test(fileId)) {
      return sendError(res, 400, 'VALIDATION_FAILED',
        'fileId must reference a pending statement upload.');
    }
    const filePath = path.join(UPLOADS_DIR, fileId);
    if (!fs.existsSync(filePath)) {
      return sendError(res, 404, 'PENDING_FILE_NOT_FOUND',
        'The uploaded file is no longer available — upload it again.');
    }
    if (saveAsTemplate && bankName === '') {
      return sendError(res, 400, 'VALIDATION_FAILED',
        'A bank name is required to save the mapping as a template.');
    }
    const format = fileId.toLowerCase().endsWith('.csv') ? 'csv' : 'excel';

    try {
      let rows;
      let parsed;
      try {
        rows = readTabularRows(filePath);
        parsed = parseWithMapping(rows, mapping, bankName ? { bankName } : {});
      } catch (parseErr) {
        return sendError(res, 422, 'MAPPING_FAILED',
          'The file could not be parsed with this mapping.',
          { reason: parseErr.message, code: parseErr.code, publicDetails: true });
      }

      const continuity = validateBalanceContinuity(parsed.transactions);
      const warnings = [...parsed.warnings, ...continuity.warnings];
      let sourceSha256 = null;
      try {
        sourceSha256 = sha256File(filePath);
      } catch (hashErr) {
        warnings.push(`PROVENANCE_HASH_FAILED: ${hashErr.message}`);
      }

      const bankLabel = parsed.account.bank_name || bankName || null;
      const statementId = persistStatement(req, {
        parsed, format, originalName, storedFile: fileId,
        sourceSha256, warnings, via: 'wizard', bankLabel, templateId: null,
      });

      let templateId = null;
      if (saveAsTemplate) {
        try {
          const signature = buildSignature(rows, mapping);
          templateId = insertTemplate(db, {
            bank_name: bankName,
            source_format: format,
            signature,
            mapping,
            created_by: req.user && req.user.username ? req.user.username : null,
          });
          audit(req, {
            action: 'bank_statement.template_saved',
            details: {
              template_id: templateId, bank_name: bankName,
              source_format: format, signature,
            },
          });
        } catch (sigErr) {
          // Saving the template is best-effort; the statement itself is in.
          warnings.push(`TEMPLATE_NOT_SAVED: ${sigErr.message}`);
        }
      }

      return res.status(201).json({
        recognized: true,
        via: 'wizard',
        statementId,
        templateId,
        bank: bankLabel,
        bankName: bankLabel,
        format,
        account: parsed.account,
        txnCount: parsed.transactions.length,
        sourceSha256,
        warnings,
        continuity: {
          checked: continuity.checked,
          direction: continuity.direction,
          breakCount: continuity.breakCount,
        },
      });
    } catch (unexpected) {
      return sendError(res, 500, 'MAPPING_FAILED', 'Applying the mapping failed.',
        { reason: unexpected.message });
    }
  });

  // ── GET /bank-statement/templates ───────────────────────────────────
  router.get('/templates', P(PERMISSIONS.VIEW_CASES), (_req, res) => {
    const data = listTemplates(db).map((t) => {
      let signature = null;
      let mapping = null;
      try { signature = JSON.parse(t.signature); } catch (_e) { /* keep null */ }
      try { mapping = JSON.parse(t.mapping); } catch (_e) { /* keep null */ }
      return { ...t, signature, mapping };
    });
    return res.json({ data });
  });

  // ── DELETE /bank-statement/templates/:id ───────────────────────────
  // Same permission as creating one: a wrong template would silently
  // hijack every future upload of that layout, so uploaders can remove it.
  router.delete('/templates/:id', P(PERMISSIONS.UPLOAD_REPORT), (req, res) => {
    const id = parseStatementId(req);
    if (id === null) {
      return sendError(res, 400, 'VALIDATION_FAILED', 'Template id must be a positive integer.');
    }
    const template = getTemplateById(db, id);
    if (!template) {
      return sendError(res, 404, 'TEMPLATE_NOT_FOUND', `No bank template with id ${id}.`);
    }
    deleteTemplate(db, id);
    audit(req, {
      action: 'bank_statement.template_deleted',
      details: { template_id: id, bank_name: template.bank_name },
    });
    return res.json({ deleted: true, id });
  });

  // ── GET /bank-statement/statements ─────────────────────────────────
  router.get('/statements', P(PERMISSIONS.VIEW_CASES), (_req, res) => {
    return res.json({ data: listStatements(db) });
  });

  // ── GET /bank-statement/statements/:id ─────────────────────────────
  router.get('/statements/:id', P(PERMISSIONS.VIEW_CASES), (req, res) => {
    const id = parseStatementId(req);
    if (id === null) {
      return sendError(res, 400, 'VALIDATION_FAILED', 'Statement id must be a positive integer.');
    }
    const statement = getStatementById(db, id);
    if (!statement) {
      return sendError(res, 404, 'STATEMENT_NOT_FOUND', `No bank statement with id ${id}.`);
    }
    let parseWarnings = [];
    if (statement.parse_warnings) {
      try { parseWarnings = JSON.parse(statement.parse_warnings); } catch (_e) { /* legacy text */ }
    }
    return res.json({ ...statement, parse_warnings: parseWarnings });
  });

  // ── GET /bank-statement/statements/:id/transactions ────────────────
  router.get('/statements/:id/transactions', P(PERMISSIONS.VIEW_CASES), (req, res) => {
    const id = parseStatementId(req);
    if (id === null) {
      return sendError(res, 400, 'VALIDATION_FAILED', 'Statement id must be a positive integer.');
    }
    const statement = getStatementById(db, id);
    if (!statement) {
      return sendError(res, 404, 'STATEMENT_NOT_FOUND', `No bank statement with id ${id}.`);
    }
    const page = parsePage(req.query.page);
    const limit = parseLimit(req.query.limit);
    if (page === null || limit === null) {
      return sendError(res, 400, 'VALIDATION_FAILED',
        `page must be ≥ 1 and limit between 1 and ${MAX_PAGE_LIMIT}.`);
    }
    return res.json(getStatementTransactions(db, id, { page, limit }));
  });

  return router;
}

module.exports = {
  createBankStatementRouter,
  // Exposed for direct testing (mirrors routes/ncrp.js exports).
  sniffContainerFormat,
  UPLOADS_DIR,
  MAX_UPLOAD_BYTES,
};
