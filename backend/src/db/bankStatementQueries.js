'use strict';

/**
 * FinTrace Bank Statement module — data access for bank_statements +
 * bank_statement_transactions.
 *
 * Follows the queries.js conventions exactly: SQL declared once as
 * module-level constants, always parameterised (`@name` placeholders — user
 * input is never concatenated), statements cached per-connection in a
 * WeakMap, public functions take `db` as their first argument, and
 * `undefined` is coerced to `null` before binding (better-sqlite3 rejects
 * missing named params).
 *
 * Kept separate from db/queries.js so the NCRP query module stays untouched.
 *
 * @module backend/src/db/bankStatementQueries
 */

// ─── SQL ─────────────────────────────────────────────────────────────

const SQL_INSERT_STATEMENT = `
  INSERT INTO bank_statements (
    account_number, account_holder, ifsc, bank_name, branch,
    statement_period_from, statement_period_to,
    source_file, original_filename, source_format, source_sha256,
    txn_count, parse_warnings
  ) VALUES (
    @account_number, @account_holder, @ifsc, @bank_name, @branch,
    @statement_period_from, @statement_period_to,
    @source_file, @original_filename, @source_format, @source_sha256,
    @txn_count, @parse_warnings
  )
`;

const SQL_INSERT_TRANSACTION = `
  INSERT INTO bank_statement_transactions (
    statement_id, txn_date, value_date, narration,
    debit_amount, credit_amount, balance, balance_type,
    ref_no, source_row
  ) VALUES (
    @statement_id, @txn_date, @value_date, @narration,
    @debit_amount, @credit_amount, @balance, @balance_type,
    @ref_no, @source_row
  )
`;

const SQL_LIST_STATEMENTS = `
  SELECT id, account_number, account_holder, ifsc, bank_name, branch,
         statement_period_from, statement_period_to,
         original_filename, source_format, source_sha256, txn_count, uploaded_at
    FROM bank_statements
   ORDER BY datetime(uploaded_at) DESC, id DESC
`;

const SQL_GET_STATEMENT = `
  SELECT id, account_number, account_holder, ifsc, bank_name, branch,
         statement_period_from, statement_period_to,
         source_file, original_filename, source_format, source_sha256,
         txn_count, parse_warnings, uploaded_at
    FROM bank_statements
   WHERE id = ?
   LIMIT 1
`;

const SQL_COUNT_TRANSACTIONS = `
  SELECT COUNT(*) AS n
    FROM bank_statement_transactions
   WHERE statement_id = @statement_id
`;

/**
 * Page in the statement's native file order (source_row) — PNB exports are
 * reverse-chronological, so this is also newest-first. Covered by
 * idx_bank_txn_statement.
 */
const SQL_PAGE_TRANSACTIONS = `
  SELECT id, statement_id, txn_date, value_date, narration,
         debit_amount, credit_amount, balance, balance_type,
         ref_no, source_row
    FROM bank_statement_transactions
   WHERE statement_id = @statement_id
   ORDER BY source_row ASC, id ASC
   LIMIT @limit OFFSET @offset
`;

// ─── Statement cache (per-connection) ────────────────────────────────

/** @type {WeakMap<object, Map<string, object>>} */
const stmtCache = new WeakMap();

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {string} sql
 * @returns {import('better-sqlite3-multiple-ciphers').Statement}
 */
function getOrPrepare(db, sql) {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt;
}

/** Coerce undefined → null so named-param binding never throws. */
const nz = (v) => (v === undefined ? null : v);

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Insert a bank_statements row.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {object} data - account metadata + provenance (see SQL above).
 * @returns {number} new statement id
 */
function insertStatement(db, data) {
  const info = getOrPrepare(db, SQL_INSERT_STATEMENT).run({
    account_number: nz(data.account_number),
    account_holder: nz(data.account_holder),
    ifsc: nz(data.ifsc),
    bank_name: nz(data.bank_name),
    branch: nz(data.branch),
    statement_period_from: nz(data.statement_period_from),
    statement_period_to: nz(data.statement_period_to),
    source_file: nz(data.source_file),
    original_filename: nz(data.original_filename),
    source_format: nz(data.source_format),
    source_sha256: nz(data.source_sha256),
    txn_count: data.txn_count === undefined || data.txn_count === null ? 0 : data.txn_count,
    parse_warnings: data.parse_warnings === undefined || data.parse_warnings === null
      ? null
      : (typeof data.parse_warnings === 'string' ? data.parse_warnings : JSON.stringify(data.parse_warnings)),
  });
  return Number(info.lastInsertRowid);
}

/**
 * Bulk-insert canonical transactions for a statement in one write
 * transaction.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} statementId
 * @param {Array<object>} rows - canonical parser output transactions.
 * @returns {number} inserted count
 */
function insertManyStatementTransactions(db, statementId, rows) {
  const insert = getOrPrepare(db, SQL_INSERT_TRANSACTION);
  const runAll = db.transaction((txns) => {
    for (const t of txns) {
      insert.run({
        statement_id: statementId,
        txn_date: nz(t.txn_date),
        value_date: nz(t.value_date),
        narration: nz(t.narration),
        debit_amount: nz(t.debit_amount),
        credit_amount: nz(t.credit_amount),
        balance: nz(t.balance),
        balance_type: nz(t.balance_type),
        ref_no: nz(t.ref_no),
        source_row: nz(t.source_row),
      });
    }
    return txns.length;
  });
  return runAll(rows);
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @returns {Array<object>} all statements, newest upload first.
 */
function listStatements(db) {
  return getOrPrepare(db, SQL_LIST_STATEMENTS).all();
}

/**
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} id
 * @returns {object|undefined}
 */
function getStatementById(db, id) {
  return getOrPrepare(db, SQL_GET_STATEMENT).get(id);
}

/**
 * Page a statement's transactions in native file order.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {number} statementId
 * @param {{ page?: number, limit?: number }} [opts] - 1-indexed page.
 * @returns {{ data: Array<object>, total: number, page: number, limit: number, total_pages: number }}
 */
function getStatementTransactions(db, statementId, opts = {}) {
  const page = Number.isInteger(opts.page) && opts.page > 0 ? opts.page : 1;
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : 100;
  const total = getOrPrepare(db, SQL_COUNT_TRANSACTIONS).get({ statement_id: statementId }).n;
  const data = getOrPrepare(db, SQL_PAGE_TRANSACTIONS).all({
    statement_id: statementId,
    limit,
    offset: (page - 1) * limit,
  });
  return {
    data,
    total,
    page,
    limit,
    total_pages: total === 0 ? 0 : Math.ceil(total / limit),
  };
}

// ─── Bank templates (wizard-confirmed reusable mappings) ─────────────

const SQL_INSERT_TEMPLATE = `
  INSERT INTO bank_templates (bank_name, source_format, signature, mapping, created_by)
  VALUES (@bank_name, @source_format, @signature, @mapping, @created_by)
`;

/** Newest first — findMatchingTemplate uses this order as its tiebreaker. */
const SQL_LIST_TEMPLATES = `
  SELECT id, bank_name, source_format, signature, mapping, created_by, created_at
    FROM bank_templates
   ORDER BY datetime(created_at) DESC, id DESC
`;

const SQL_GET_TEMPLATE = `
  SELECT id, bank_name, source_format, signature, mapping, created_by, created_at
    FROM bank_templates
   WHERE id = ?
   LIMIT 1
`;

const SQL_DELETE_TEMPLATE = 'DELETE FROM bank_templates WHERE id = ?';

/**
 * Insert a bank template. signature/mapping objects are stringified here.
 *
 * @param {import('better-sqlite3-multiple-ciphers').Database} db
 * @param {{ bank_name: string, source_format: string, signature: object|string,
 *           mapping: object|string, created_by?: string }} data
 * @returns {number} new template id
 */
function insertTemplate(db, data) {
  const asJson = (v) => (typeof v === 'string' ? v : JSON.stringify(v));
  const info = getOrPrepare(db, SQL_INSERT_TEMPLATE).run({
    bank_name: nz(data.bank_name),
    source_format: nz(data.source_format),
    signature: asJson(data.signature),
    mapping: asJson(data.mapping),
    created_by: nz(data.created_by),
  });
  return Number(info.lastInsertRowid);
}

/** All templates, newest first. */
function listTemplates(db) {
  return getOrPrepare(db, SQL_LIST_TEMPLATES).all();
}

/** One template by id, or undefined. */
function getTemplateById(db, id) {
  return getOrPrepare(db, SQL_GET_TEMPLATE).get(id);
}

/** Delete a template. @returns {boolean} true if a row was removed. */
function deleteTemplate(db, id) {
  return getOrPrepare(db, SQL_DELETE_TEMPLATE).run(id).changes > 0;
}

module.exports = {
  insertStatement,
  insertManyStatementTransactions,
  listStatements,
  getStatementById,
  getStatementTransactions,
  insertTemplate,
  listTemplates,
  getTemplateById,
  deleteTemplate,
};
