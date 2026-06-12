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
    fraud_start_date, analysis_status, analysis_json
  ) VALUES (
    @filename, @original_filename, @upload_date,
    @total_transactions, @total_disputed_amount, @total_layers,
    @fraud_start_date, @analysis_status, @analysis_json
  )
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
         cashout_mode     = @cashout_mode
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

const SQL_UPSERT_REPEAT_ACCOUNT = `
  INSERT INTO repeat_accounts (
    account_no, bank_name, first_seen_report_id,
    appearance_count, total_amount_passed, mule_score, last_updated
  ) VALUES (
    @account_no, @bank_name, @first_seen_report_id,
    1, @amount_passed, @mule_score, CURRENT_TIMESTAMP
  )
  ON CONFLICT(account_no) DO UPDATE SET
    appearance_count    = appearance_count + 1,
    total_amount_passed = total_amount_passed + excluded.total_amount_passed,
    mule_score          = MAX(mule_score, excluded.mule_score),
    bank_name           = COALESCE(repeat_accounts.bank_name, excluded.bank_name),
    last_updated        = CURRENT_TIMESTAMP
`;

// ─── Filter spec for getTransactionsByReport ─────────────────────────
//
// Each entry maps a filter key to a SQL fragment + the bound parameter
// name. Filters are applied only when the caller supplies a non-null/
// non-undefined value, so the cache key (built from sorted, present
// filter keys) reflects exactly which fragments compose the final SQL.

const TXN_FILTERS = Object.freeze({
  layer_no:            { sql: 'layer_no = @layer_no',                                  bind: 'layer_no' },
  beneficiary_account: { sql: 'beneficiary_account = @beneficiary_account',            bind: 'beneficiary_account' },
  beneficiary_bank:    { sql: 'beneficiary_bank = @beneficiary_bank',                  bind: 'beneficiary_bank' },
  payment_mode:        { sql: 'payment_mode = @payment_mode',                          bind: 'payment_mode' },
  state:               { sql: 'state = @state',                                        bind: 'state' },
  city:                { sql: 'city = @city',                                          bind: 'city' },
  date_from:           { sql: 'transaction_date >= @date_from',                        bind: 'date_from' },
  date_to:             { sql: 'transaction_date <= @date_to',                          bind: 'date_to' },
  amount_min:          { sql: 'transaction_amount >= @amount_min',                     bind: 'amount_min' },
  amount_max:          { sql: 'transaction_amount <= @amount_max',                     bind: 'amount_max' },
  cashout_only:        { sql: "payment_mode IN ('ATM','POS','AEPS')",                   bind: null },
});

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
 * `@name` (named) bind parameters — no string concatenation of user input. The
 * single dynamic place (`${whereSql}` in {@link getTransactionsByReport}) is
 * composed exclusively from fragments hard-coded in {@link TXN_FILTERS}; user
 * values still travel via named bind params. Auditing rule: any future
 * `db.prepare(...)` call MUST use placeholders, never template-interpolated
 * literals.
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
  };
  const info = getOrPrepare(db, SQL_INSERT_REPORT).run(params);
  return Number(info.lastInsertRowid);
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
 * Paginated, filterable transaction listing for the Transaction Browser
 * screen. Returns items + total count + page metadata.
 *
 * Recognised filter keys: layer_no, beneficiary_account, beneficiary_bank,
 * payment_mode, state, city, date_from, date_to, amount_min, amount_max,
 * cashout_only (boolean).
 *
 * @param {Database.Database} db
 * @param {number} reportId
 * @param {Record<string, unknown>} [filters={}]
 * @param {number} [page=1]   1-indexed page number.
 * @param {number} [limit=100] Max 500 rows per page (enforced).
 * @returns {{
 *   items: ReadonlyArray<Record<string, unknown>>,
 *   total: number,
 *   page: number,
 *   limit: number,
 *   pageCount: number
 * }}
 */
function getTransactionsByReport(db, reportId, filters = {}, page = 1, limit = 100) {
  if (!Number.isInteger(reportId) || reportId <= 0) {
    throw new TypeError('getTransactionsByReport: reportId must be a positive integer');
  }
  const safePage  = Math.max(1, Math.trunc(page) || 1);
  const safeLimit = Math.min(500, Math.max(1, Math.trunc(limit) || 100));
  const offset    = (safePage - 1) * safeLimit;

  // Build WHERE clauses + bound params from the supplied filters.
  /** @type {string[]} */
  const whereParts = ['report_id = @report_id'];
  /** @type {Record<string, unknown>} */
  const params = { report_id: reportId };

  // Stable, sorted iteration so the resulting SQL string (and therefore
  // the prepared-statement cache key) is deterministic for a given filter
  // shape — re-running the same filter shape reuses the prepared stmt.
  const activeKeys = Object.keys(filters)
    .filter((k) => {
      if (!Object.prototype.hasOwnProperty.call(TXN_FILTERS, k)) return false;
      const v = filters[k];
      if (k === 'cashout_only') return v === true;
      return v !== undefined && v !== null && v !== '';
    })
    .sort();

  for (const key of activeKeys) {
    const spec = TXN_FILTERS[key];
    whereParts.push(spec.sql);
    if (spec.bind) params[spec.bind] = filters[key];
  }

  const whereSql = whereParts.join(' AND ');

  const listSql = `
    SELECT *
      FROM ncrp_transactions
     WHERE ${whereSql}
  ORDER BY transaction_date DESC, id DESC
     LIMIT @limit OFFSET @offset
  `;
  const countSql = `
    SELECT COUNT(*) AS total
      FROM ncrp_transactions
     WHERE ${whereSql}
  `;

  const items = getOrPrepare(db, listSql).all({
    ...params,
    limit: safeLimit,
    offset,
  });
  const total = getOrPrepare(db, countSql).get(params).total;

  return {
    items,
    total,
    page: safePage,
    limit: safeLimit,
    pageCount: total === 0 ? 0 : Math.ceil(total / safeLimit),
  };
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

/**
 * Upsert a row in the repeat_accounts registry. On first sighting the
 * row is inserted with appearance_count=1; subsequent calls increment
 * the count, add to total_amount_passed, and lift mule_score to the
 * higher of the existing/new value.
 *
 * @param {Database.Database} db
 * @param {{
 *   account_no: string,
 *   bank_name?: string|null,
 *   first_seen_report_id?: number|null,
 *   amount_passed?: number,
 *   mule_score?: number,
 * }} accountData
 * @returns {number} Rows affected (1 on insert, 1 on update).
 */
function upsertRepeatAccount(db, accountData) {
  if (!accountData || !accountData.account_no) {
    throw new Error('upsertRepeatAccount: account_no is required');
  }
  const params = {
    account_no:           accountData.account_no,
    bank_name:            nz(accountData.bank_name),
    first_seen_report_id: nz(accountData.first_seen_report_id),
    amount_passed:        accountData.amount_passed ?? 0,
    mule_score:           accountData.mule_score ?? 0,
  };
  return getOrPrepare(db, SQL_UPSERT_REPEAT_ACCOUNT).run(params).changes;
}

/**
 * Write back the two analyzer-derived columns (`same_day_cashout`,
 * `cashout_mode`) onto a single transaction row, addressed by primary key.
 *
 * `same_day_cashout` is coerced to 0/1 (truthy → 1) and `cashout_mode` is
 * coerced to null when omitted, mirroring the INSERT path's normalisation so
 * an analyzer pass never binds NULL into the boolean column or undefined into
 * the text column.
 *
 * @param {Database.Database} db
 * @param {number} id - Primary key of the ncrp_transactions row.
 * @param {{ same_day_cashout?: boolean|number, cashout_mode?: string|null }} patch
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
  };
  return getOrPrepare(db, SQL_UPDATE_TRANSACTION_CASHOUT).run(params).changes;
}

module.exports = {
  // Required public surface
  insertTransaction,
  updateTransactionCashout,
  getReportById,
  getTransactionsByReport,
  updateLienStatus,
  upsertRepeatAccount,

  // Additional helpers used by ingest + seed pipelines
  insertReport,
  updateReportAnalysis,
  insertManyTransactions,
  insertLayerAnalysis,
  insertLienRecord,
  insertDraftEmail,
  insertAuditLog,
};
