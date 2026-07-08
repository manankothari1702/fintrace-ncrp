'use strict';

/**
 * FinTrace NCRP — prepared-statement helpers.
 *
 * All SQL is declared once as a module-level constant. Prepared statements
 * are cached per `db` instance in a WeakMap so each (db, SQL) pair is
 * compiled exactly once, even though the public API accepts `db` as a
 * parameter (rather than binding to a singleton).
 *
 * Conventions
 *   • Synchronous throughout (better-sqlite3 is sync; no async/await).
 *   • Multi-row inserts are wrapped in `db.transaction(...)`.
 *   • All `undefined` field values are coerced to `null` before binding,
 *     because better-sqlite3 named-parameter binding requires every named
 *     parameter to be present in the bound object.
 *
 * @module backend/src/db/queries
 */

// ─── SQL constants ───────────────────────────────────────────────────

const SQL_INSERT_REPORT = `
  INSERT INTO ncrp_reports (
    filename, original_filename, upload_date,
    total_transactions, total_disputed_amount, total_layers,
    fraud_start_date, analysis_status, analysis_json, source_sha256,
    old_transactions, parse_warnings
  ) VALUES (
    @filename, @original_filename, @upload_date,
    @total_transactions, @total_disputed_amount, @total_layers,
    @fraud_start_date, @analysis_status, @analysis_json, @source_sha256,
    @old_transactions, @parse_warnings
  )
`;

// Prior reports of the SAME case (matched by NCRP acknowledgement number) whose
// stored source hash differs from a candidate hash — drives the changed-source
// warning on re-ingest. Joined through transactions because the ack_no lives on
// the transaction rows, not the report.
const SQL_FIND_REPORTS_BY_ACK = `
  SELECT DISTINCT r.id, r.original_filename, r.upload_date, r.source_sha256
    FROM ncrp_reports r
    JOIN ncrp_transactions t ON t.report_id = r.id
   WHERE t.ack_no = ?
     AND r.source_sha256 IS NOT NULL
   ORDER BY r.id DESC
`;

const SQL_GET_REPORT_BY_ID = `SELECT * FROM ncrp_reports WHERE id = ?`;

const SQL_UPDATE_REPORT_ANALYSIS = `
  UPDATE ncrp_reports
     SET analysis_status     = @analysis_status,
         analysis_json       = @analysis_json,
         total_transactions  = COALESCE(@total_transactions,  total_transactions),
         total_disputed_amount = COALESCE(@total_disputed_amount, total_disputed_amount),
         total_layers        = COALESCE(@total_layers,        total_layers),
         fraud_start_date    = COALESCE(@fraud_start_date,    fraud_start_date)
   WHERE id = @id
`;

const SQL_INSERT_TRANSACTION = `
  INSERT INTO ncrp_transactions (
    report_id, ack_no, complaint_date,
    victim_account, victim_bank,
    beneficiary_account, beneficiary_bank, beneficiary_name, ifsc_code,
    transaction_date, transaction_amount, disputed_amount, utr_no,
    payment_mode, layer_no,
    atm_id, atm_location, city, state, remarks,
    raw_beneficiary_bank, bank_source, bank_flag,
    same_day_cashout, cashout_mode
  ) VALUES (
    @report_id, @ack_no, @complaint_date,
    @victim_account, @victim_bank,
    @beneficiary_account, @beneficiary_bank, @beneficiary_name, @ifsc_code,
    @transaction_date, @transaction_amount, @disputed_amount, @utr_no,
    @payment_mode, @layer_no,
    @atm_id, @atm_location, @city, @state, @remarks,
    @raw_beneficiary_bank, @bank_source, @bank_flag,
    @same_day_cashout, @cashout_mode
  )
`;

// Analyzer write-back: stamps the two analyzer-derived columns on a single
// transaction row once cashout classification (FR-11) and the same-day-cashout
// rule (FR-12) have been computed. Keyed by primary key so the analyzer can
// update exactly the rows it inspected.
const SQL_UPDATE_TRANSACTION_CASHOUT = `
  UPDATE ncrp_transactions
     SET same_day_cashout = @same_day_cashout,
         cashout_mode     = @cashout_mode,
         is_duplicate     = @is_duplicate
   WHERE id = @id
`;

const SQL_INSERT_LAYER_ANALYSIS = `
  INSERT INTO layer_analysis (
    report_id, layer_no, account_count, total_amount,
    disputed_amount, cashout_count, avg_forward_time_hours
  ) VALUES (
    @report_id, @layer_no, @account_count, @total_amount,
    @disputed_amount, @cashout_count, @avg_forward_time_hours
  )
  ON CONFLICT(report_id, layer_no) DO UPDATE SET
    account_count          = excluded.account_count,
    total_amount           = excluded.total_amount,
    disputed_amount        = excluded.disputed_amount,
    cashout_count          = excluded.cashout_count,
    avg_forward_time_hours = excluded.avg_forward_time_hours
`;

const SQL_INSERT_LIEN_RECORD = `
  INSERT INTO lien_records (
    report_id, account_no, bank_name, ifsc_code,
    available_balance, lien_amount, lien_status, applied_date, remarks
  ) VALUES (
    @report_id, @account_no, @bank_name, @ifsc_code,
    @available_balance, @lien_amount, @lien_status, @applied_date, @remarks
  )
`;

// Auto-stamps applied_date the first time lien_status flips to 'applied'.
// Leaves it untouched on later transitions so the audit trail is preserved.
const SQL_UPDATE_LIEN_STATUS = `
  UPDATE lien_records
     SET lien_status  = @status,
         applied_date = CASE
           WHEN @status = 'applied' AND applied_date IS NULL THEN CURRENT_TIMESTAMP
           ELSE applied_date
         END
   WHERE id = @id
`;

const SQL_INSERT_DRAFT_EMAIL = `
  INSERT INTO draft_emails (
    report_id, bank_name, subject, body, account_list, status
  ) VALUES (
    @report_id, @bank_name, @subject, @body, @account_list, @status
  )
`;

const SQL_INSERT_AUDIT = `
  INSERT INTO audit_log (report_id, action, details)
  VALUES (@report_id, @action, @details)
`;

// ─── repeat_accounts: contribution ledger + derived aggregates ───────
//
// repeat_account_reports holds one row per (canonical account, report) — a
// report's contribution to that account. repeat_accounts is DERIVED from it:
// appearance_count = COUNT of contributing reports (never of upsert calls),
// total_amount_passed = SUM, mule_score = MAX, first_seen_report_id = MIN.
// Replacing a report's contributions is therefore idempotent (re-analysis
// never inflates), and withdrawing them on report delete leaves no orphans.

const SQL_SELECT_REPORT_CONTRIB_KEYS = `
  SELECT account_no FROM repeat_account_reports WHERE report_id = @report_id
`;

const SQL_DELETE_REPORT_CONTRIBS = `
  DELETE FROM repeat_account_reports WHERE report_id = @report_id
`;

const SQL_INSERT_CONTRIB = `
  INSERT INTO repeat_account_reports (
    account_no, report_id, bank_name, amount_passed, mule_score
  ) VALUES (
    @account_no, @report_id, @bank_name, @amount_passed, @mule_score
  )
`;

// Rebuild one account's aggregate row from its remaining contributions.
// bank_name follows the earliest contributing report's non-null value —
// the same "first sighting wins" semantics the legacy upsert had.
const SQL_RECOMPUTE_AGGREGATE = `
  INSERT INTO repeat_accounts (
    account_no, bank_name, first_seen_report_id,
    appearance_count, total_amount_passed, mule_score, last_updated
  )
  SELECT
    c.account_no,
    (SELECT c2.bank_name FROM repeat_account_reports c2
      WHERE c2.account_no = c.account_no AND c2.bank_name IS NOT NULL
      ORDER BY c2.report_id ASC LIMIT 1),
    MIN(c.report_id), COUNT(*), SUM(c.amount_passed), MAX(c.mule_score),
    CURRENT_TIMESTAMP
  FROM repeat_account_reports c
  WHERE c.account_no = @account_no
  GROUP BY c.account_no
  ON CONFLICT(account_no) DO UPDATE SET
    bank_name            = excluded.bank_name,
    first_seen_report_id = excluded.first_seen_report_id,
    appearance_count     = excluded.appearance_count,
    total_amount_passed  = excluded.total_amount_passed,
    mule_score           = excluded.mule_score,
    last_updated         = CURRENT_TIMESTAMP
`;

const SQL_DELETE_EMPTY_AGGREGATE = `
  DELETE FROM repeat_accounts
   WHERE account_no = @account_no
     AND NOT EXISTS (
       SELECT 1 FROM repeat_account_reports c WHERE c.account_no = @account_no
     )
`;

// ─── Prepared-statement cache ────────────────────────────────────────

/**
 * One Map<sql, Statement> per `db` instance. WeakMap so closing a db
 * lets its cached statements get GC'd.
 *
 * @type {WeakMap<Database.Database, Map<string, Database.Statement>>}
 */
const stmtCache = new WeakMap();

/**
 * Return a cached prepared statement for (db, sql); compile on first use.
 *
 * Security: every SQL constant in this module uses either `?` (positional) or
 * `@name` (named) bind parameters — no string concatenation of user input.
 * Auditing rule: any future `db.prepare(...)` call MUST use placeholders,
 * never template-interpolated literals. (The Transaction Browser's dynamic
 * WHERE composition lives in routes/ncrp.js, built from a fixed allow-list
 * of column fragments with named binds.)
 *
 * @param {Database.Database} db
 * @param {string} sql
 * @returns {Database.Statement}
 */
function getOrPrepare(db, sql) {
  let perDb = stmtCache.get(db);
  if (!perDb) {
    perDb = new Map();
    stmtCache.set(db, perDb);
  }
  let stmt = perDb.get(sql);
  if (!stmt) {
    // Parameterised: SQL constants in this module use ? or @name placeholders.
    stmt = db.prepare(sql);
    perDb.set(sql, stmt);
  }
  return stmt;
}

/** @param {unknown} v */
const nz = (v) => (v === undefined ? null : v);

/**
 * Coerce a transaction record into the exact named-parameter shape that
 * SQL_INSERT_TRANSACTION expects. Any caller-omitted field becomes null.
 *
 * @param {Record<string, unknown>} data
 */
function normalizeTransaction(data) {
  if (!data || typeof data !== 'object') {
    throw new TypeError('insertTransaction: data must be an object');
  }
  if (data.report_id == null) {
    throw new Error('insertTransaction: report_id is required');
  }
  // same_day_cashout: coerce any truthy → 1, falsy/missing → 0. Booleans,
  // 0/1 ints, and undefined all round-trip safely. The column also has
  // DEFAULT 0 at the schema level — this normalisation just makes the
  // INSERT path explicit so we never bind NULL into the column.
  return {
    report_id:           data.report_id,
    ack_no:              nz(data.ack_no),
    complaint_date:      nz(data.complaint_date),
    victim_account:      nz(data.victim_account),
    victim_bank:         nz(data.victim_bank),
    beneficiary_account: nz(data.beneficiary_account),
    beneficiary_bank:    nz(data.beneficiary_bank),
    beneficiary_name:    nz(data.beneficiary_name),
    ifsc_code:           nz(data.ifsc_code),
    transaction_date:    nz(data.transaction_date),
    transaction_amount:  nz(data.transaction_amount),
    disputed_amount:     nz(data.disputed_amount),
    utr_no:              nz(data.utr_no),
    payment_mode:        nz(data.payment_mode),
    layer_no:            nz(data.layer_no),
    atm_id:              nz(data.atm_id),
    atm_location:        nz(data.atm_location),
    city:                nz(data.city),
    state:               nz(data.state),
    remarks:             nz(data.remarks),
    raw_beneficiary_bank: nz(data.raw_beneficiary_bank),
    bank_source:         nz(data.bank_source),
    bank_flag:           nz(data.bank_flag),
    same_day_cashout:    data.same_day_cashout ? 1 : 0,
    cashout_mode:        nz(data.cashout_mode),
  };
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Insert a new uploaded-report row. Returns the new row id.
 *
 * @param {Database.Database} db
 * @param {{
 *   filename: string,
 *   original_filename: string,
 *   upload_date: string,
 *   total_transactions?: number|null,
 *   total_disputed_amount?: number|null,
 *   total_layers?: number|null,
 *   fraud_start_date?: string|null,
 *   analysis_status?: 'pending'|'processing'|'complete'|'error',
 *   analysis_json?: string|null,
 *   source_sha256?: string|null,
 *   old_transactions?: string|null,
 *   parse_warnings?: string|null,
 * }} data
 * @returns {number} The auto-generated `id` of the new ncrp_reports row.
 */
function insertReport(db, data) {
  if (!data || !data.filename || !data.original_filename || !data.upload_date) {
    throw new Error(
      'insertReport: filename, original_filename, and upload_date are required'
    );
  }
  const params = {
    filename:              data.filename,
    original_filename:     data.original_filename,
    upload_date:           data.upload_date,
    total_transactions:    nz(data.total_transactions),
    total_disputed_amount: nz(data.total_disputed_amount),
    total_layers:          nz(data.total_layers),
    fraud_start_date:      nz(data.fraud_start_date),
    analysis_status:       data.analysis_status ?? 'pending',
    analysis_json:         nz(data.analysis_json),
    source_sha256:         nz(data.source_sha256),
    old_transactions:      nz(data.old_transactions),
    parse_warnings:        nz(data.parse_warnings),
  };
  const info = getOrPrepare(db, SQL_INSERT_REPORT).run(params);
  return Number(info.lastInsertRowid);
}

/**
 * All prior reports for a case (by NCRP acknowledgement number) that carry a
 * stored source hash. Used to detect a changed source file on re-ingest.
 *
 * @param {Database.Database} db
 * @param {string} ackNo - NCRP acknowledgement number.
 * @returns {Array<{ id: number, original_filename: string, upload_date: string,
 *   source_sha256: string }>} Newest report first.
 */
function findReportsByAckNo(db, ackNo) {
  if (ackNo === null || ackNo === undefined || String(ackNo).trim() === '') return [];
  return getOrPrepare(db, SQL_FIND_REPORTS_BY_ACK).all(String(ackNo));
}

/**
 * Update analysis status and (optionally) the cached analysis_json
 * + aggregates on an existing report.
 *
 * @param {Database.Database} db
 * @param {number} reportId
 * @param {{
 *   analysis_status: 'pending'|'processing'|'complete'|'error',
 *   analysis_json?: string|null,
 *   total_transactions?: number|null,
 *   total_disputed_amount?: number|null,
 *   total_layers?: number|null,
 *   fraud_start_date?: string|null,
 * }} patch
 * @returns {number} Rows affected (0 or 1).
 */
function updateReportAnalysis(db, reportId, patch) {
  if (!patch || !patch.analysis_status) {
    throw new Error('updateReportAnalysis: analysis_status is required');
  }
  const params = {
    id:                    reportId,
    analysis_status:       patch.analysis_status,
    analysis_json:         nz(patch.analysis_json),
    total_transactions:    nz(patch.total_transactions),
    total_disputed_amount: nz(patch.total_disputed_amount),
    total_layers:          nz(patch.total_layers),
    fraud_start_date:      nz(patch.fraud_start_date),
  };
  return getOrPrepare(db, SQL_UPDATE_REPORT_ANALYSIS).run(params).changes;
}

/**
 * Fetch a single report by primary key. Returns undefined if not found.
 *
 * @param {Database.Database} db
 * @param {number} id
 * @returns {Record<string, unknown>|undefined}
 */
function getReportById(db, id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('getReportById: id must be a positive integer');
  }
  return getOrPrepare(db, SQL_GET_REPORT_BY_ID).get(id);
}

/**
 * Insert a single transaction row. Returns the new row id.
 *
 * @param {Database.Database} db
 * @param {Record<string, unknown>} data
 * @returns {number}
 */
function insertTransaction(db, data) {
  const params = normalizeTransaction(data);
  const info = getOrPrepare(db, SQL_INSERT_TRANSACTION).run(params);
  return Number(info.lastInsertRowid);
}

/**
 * Bulk-insert transactions inside one transaction. Use for any batch
 * larger than ~50 rows; one fsync amortized across all rows.
 *
 * @param {Database.Database} db
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @returns {number} Number of rows inserted.
 */
function insertManyTransactions(db, rows) {
  if (!Array.isArray(rows)) {
    throw new TypeError('insertManyTransactions: rows must be an array');
  }
  if (rows.length === 0) return 0;

  const stmt = getOrPrepare(db, SQL_INSERT_TRANSACTION);
  const runBatch = db.transaction((batch) => {
    for (const row of batch) {
      stmt.run(normalizeTransaction(row));
    }
    return batch.length;
  });
  return runBatch(rows);
}

/**
 * Insert a layer_analysis row (or replace if one already exists for that
 * (report_id, layer_no) — the unique index drives the UPSERT).
 *
 * @param {Database.Database} db
 * @param {{
 *   report_id: number,
 *   layer_no: number,
 *   account_count?: number|null,
 *   total_amount?: number|null,
 *   disputed_amount?: number|null,
 *   cashout_count?: number|null,
 *   avg_forward_time_hours?: number|null,
 * }} data
 * @returns {number} Rows affected.
 */
function insertLayerAnalysis(db, data) {
  if (data == null || data.report_id == null || data.layer_no == null) {
    throw new Error('insertLayerAnalysis: report_id and layer_no are required');
  }
  const params = {
    report_id:              data.report_id,
    layer_no:               data.layer_no,
    account_count:          nz(data.account_count),
    total_amount:           nz(data.total_amount),
    disputed_amount:        nz(data.disputed_amount),
    cashout_count:          nz(data.cashout_count),
    avg_forward_time_hours: nz(data.avg_forward_time_hours),
  };
  return getOrPrepare(db, SQL_INSERT_LAYER_ANALYSIS).run(params).changes;
}

/**
 * Insert a new lien_records row. Returns the new row id.
 *
 * @param {Database.Database} db
 * @param {{
 *   report_id: number,
 *   account_no: string,
 *   bank_name?: string|null,
 *   ifsc_code?: string|null,
 *   available_balance?: number|null,
 *   lien_amount?: number|null,
 *   lien_status?: 'pending'|'applied'|'success'|'rejected',
 *   applied_date?: string|null,
 *   remarks?: string|null,
 * }} data
 * @returns {number}
 */
function insertLienRecord(db, data) {
  if (data == null || data.report_id == null || !data.account_no) {
    throw new Error('insertLienRecord: report_id and account_no are required');
  }
  const params = {
    report_id:         data.report_id,
    account_no:        data.account_no,
    bank_name:         nz(data.bank_name),
    ifsc_code:         nz(data.ifsc_code),
    available_balance: nz(data.available_balance),
    lien_amount:       nz(data.lien_amount),
    lien_status:       data.lien_status ?? 'pending',
    applied_date:      nz(data.applied_date),
    remarks:           nz(data.remarks),
  };
  const info = getOrPrepare(db, SQL_INSERT_LIEN_RECORD).run(params);
  return Number(info.lastInsertRowid);
}

/**
 * Update the lifecycle status of a lien record. When the status flips to
 * 'applied' for the first time, applied_date is auto-stamped.
 *
 * @param {Database.Database} db
 * @param {number} lienId
 * @param {'pending'|'applied'|'success'|'rejected'} status
 * @returns {number} Rows affected (0 if id not found).
 */
function updateLienStatus(db, lienId, status) {
  const ALLOWED = ['pending', 'applied', 'success', 'rejected'];
  if (!Number.isInteger(lienId) || lienId <= 0) {
    throw new TypeError('updateLienStatus: lienId must be a positive integer');
  }
  if (!ALLOWED.includes(status)) {
    throw new RangeError(
      `updateLienStatus: status must be one of ${ALLOWED.join(', ')} (got "${status}")`
    );
  }
  return getOrPrepare(db, SQL_UPDATE_LIEN_STATUS).run({ id: lienId, status }).changes;
}

/**
 * Insert a draft email row. `account_list` is stored as a JSON string;
 * if an array is passed, it is stringified for you.
 *
 * @param {Database.Database} db
 * @param {{
 *   report_id: number,
 *   bank_name: string,
 *   subject?: string|null,
 *   body?: string|null,
 *   account_list?: string|string[]|null,
 *   status?: 'draft'|'sent',
 * }} data
 * @returns {number}
 */
function insertDraftEmail(db, data) {
  if (data == null || data.report_id == null || !data.bank_name) {
    throw new Error('insertDraftEmail: report_id and bank_name are required');
  }
  const accountList = Array.isArray(data.account_list)
    ? JSON.stringify(data.account_list)
    : nz(data.account_list);
  const params = {
    report_id:    data.report_id,
    bank_name:    data.bank_name,
    subject:      nz(data.subject),
    body:         nz(data.body),
    account_list: accountList,
    status:       data.status ?? 'draft',
  };
  const info = getOrPrepare(db, SQL_INSERT_DRAFT_EMAIL).run(params);
  return Number(info.lastInsertRowid);
}

/**
 * Append an audit_log entry. `details` may be a string or an object
 * (objects are stringified to JSON).
 *
 * @param {Database.Database} db
 * @param {{
 *   report_id?: number|null,
 *   action: string,
 *   details?: string|Record<string, unknown>|null,
 * }} entry
 * @returns {number}
 */
function insertAuditLog(db, entry) {
  if (!entry || !entry.action) {
    throw new Error('insertAuditLog: action is required');
  }
  const details =
    entry.details && typeof entry.details === 'object'
      ? JSON.stringify(entry.details)
      : nz(entry.details);
  const params = {
    report_id: nz(entry.report_id),
    action:    entry.action,
    details,
  };
  const info = getOrPrepare(db, SQL_INSERT_AUDIT).run(params);
  return Number(info.lastInsertRowid);
}

// Canonical account identity for registry keys — the analyzer's single
// canonicalization scheme (leading-zero stripping for all-digit numbers,
// verbatim otherwise). Lazily required because analyzer.js itself requires
// this module at load time; by the time any registry write runs, the
// analyzer module is fully initialized.
let _canonicalAccountKey = null;
function canonicalKey(acc) {
  if (!_canonicalAccountKey) {
    ({ canonicalAccountKey: _canonicalAccountKey } = require('../analyzers/analyzer'));
  }
  return _canonicalAccountKey(acc);
}

/**
 * Recompute one account's derived repeat_accounts row from its remaining
 * contributions; drops the row entirely when no contribution backs it.
 *
 * @param {Database.Database} db
 * @param {string} accountKey - CANONICAL account key.
 */
function recomputeRepeatAggregate(db, accountKey) {
  getOrPrepare(db, SQL_RECOMPUTE_AGGREGATE).run({ account_no: accountKey });
  getOrPrepare(db, SQL_DELETE_EMPTY_AGGREGATE).run({ account_no: accountKey });
}

/**
 * Replace a report's contributions to the repeat-account registry and
 * recompute the derived aggregates for every touched account, atomically.
 *
 * Idempotent by construction: re-running analysis for a report REPLACES its
 * ledger rows instead of incrementing anything, so appearance_count only
 * ever counts distinct contributing reports. Incoming entries are folded by
 * canonical account key first, so two display variants of one account
 * (zero-padded vs bare) contribute once — amounts sum, mule_score takes the
 * max, the first non-null bank name wins.
 *
 * @param {Database.Database} db
 * @param {number} reportId
 * @param {ReadonlyArray<{
 *   account_no: string,
 *   bank_name?: string|null,
 *   amount_passed?: number,
 *   mule_score?: number,
 * }>} [contributions=[]]
 * @returns {{accounts: number, touched: number}} Ledger rows written for
 *   this report, and distinct aggregate rows recomputed (including ones
 *   withdrawn because the new list no longer mentions them).
 */
function replaceReportRepeatContributions(db, reportId, contributions = []) {
  if (!Number.isInteger(reportId) || reportId <= 0) {
    throw new TypeError(
      'replaceReportRepeatContributions: reportId must be a positive integer'
    );
  }
  const run = db.transaction(() => {
    const before = getOrPrepare(db, SQL_SELECT_REPORT_CONTRIB_KEYS)
      .all({ report_id: reportId })
      .map((r) => r.account_no);
    getOrPrepare(db, SQL_DELETE_REPORT_CONTRIBS).run({ report_id: reportId });

    /** @type {Map<string, {bank_name: string|null, amount_passed: number, mule_score: number}>} */
    const byKey = new Map();
    for (const c of contributions || []) {
      const key = canonicalKey(c && c.account_no);
      if (!key) continue;
      const agg = byKey.get(key) ||
        { bank_name: null, amount_passed: 0, mule_score: 0 };
      agg.amount_passed += Number(c.amount_passed) || 0;
      agg.mule_score = Math.max(agg.mule_score, Number(c.mule_score) || 0);
      if (!agg.bank_name && c.bank_name) agg.bank_name = String(c.bank_name);
      byKey.set(key, agg);
    }

    const ins = getOrPrepare(db, SQL_INSERT_CONTRIB);
    for (const [key, agg] of byKey) {
      ins.run({
        account_no:    key,
        report_id:     reportId,
        bank_name:     nz(agg.bank_name),
        amount_passed: agg.amount_passed,
        mule_score:    agg.mule_score,
      });
    }

    const touched = new Set([...before, ...byKey.keys()]);
    for (const key of touched) recomputeRepeatAggregate(db, key);
    return { accounts: byKey.size, touched: touched.size };
  });
  return run();
}

/**
 * Withdraw a report's contributions from the repeat-account registry (on
 * report delete) and recompute the affected aggregates — accounts left with
 * no contributing report drop out of repeat_accounts entirely.
 *
 * @param {Database.Database} db
 * @param {number} reportId
 * @returns {number} Ledger rows removed.
 */
function removeReportRepeatContributions(db, reportId) {
  if (!Number.isInteger(reportId) || reportId <= 0) {
    throw new TypeError(
      'removeReportRepeatContributions: reportId must be a positive integer'
    );
  }
  const run = db.transaction(() => {
    const keys = getOrPrepare(db, SQL_SELECT_REPORT_CONTRIB_KEYS)
      .all({ report_id: reportId })
      .map((r) => r.account_no);
    const removed = getOrPrepare(db, SQL_DELETE_REPORT_CONTRIBS)
      .run({ report_id: reportId }).changes;
    for (const key of keys) recomputeRepeatAggregate(db, key);
    return removed;
  });
  return run();
}

/**
 * Write back the analyzer-derived columns (`same_day_cashout`, `cashout_mode`,
 * `is_duplicate`) onto a single transaction row, addressed by primary key.
 *
 * `same_day_cashout` and `is_duplicate` are coerced to 0/1 (truthy → 1) and
 * `cashout_mode` is coerced to null when omitted, mirroring the INSERT path's
 * normalisation so an analyzer pass never binds NULL into a boolean column or
 * undefined into the text column.
 *
 * @param {Database.Database} db
 * @param {number} id - Primary key of the ncrp_transactions row.
 * @param {{ same_day_cashout?: boolean|number, cashout_mode?: string|null,
 *   is_duplicate?: boolean|number }} patch
 * @returns {number} Rows affected (0 if id not found).
 */
function updateTransactionCashout(db, id, patch) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('updateTransactionCashout: id must be a positive integer');
  }
  const params = {
    id,
    same_day_cashout: patch && patch.same_day_cashout ? 1 : 0,
    cashout_mode:     nz(patch && patch.cashout_mode),
    is_duplicate:     patch && patch.is_duplicate ? 1 : 0,
  };
  return getOrPrepare(db, SQL_UPDATE_TRANSACTION_CASHOUT).run(params).changes;
}

module.exports = {
  // Required public surface
  insertTransaction,
  updateTransactionCashout,
  getReportById,
  updateLienStatus,
  replaceReportRepeatContributions,
  removeReportRepeatContributions,

  // Additional helpers used by ingest + seed pipelines
  insertReport,
  findReportsByAckNo,
  updateReportAnalysis,
  insertManyTransactions,
  insertLayerAnalysis,
  insertLienRecord,
  insertDraftEmail,
  insertAuditLog,
};
