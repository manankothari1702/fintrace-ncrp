'use strict';

/**
 * FinTrace NCRP — SQLite schema bootstrapper.
 *
 * Opens (creates if missing) a SQLite database at `dbPath`, applies the
 * production pragmas, and runs all CREATE TABLE / CREATE INDEX statements
 * idempotently. Uses the better-sqlite3 synchronous API throughout.
 *
 * @module backend/src/db/schema
 */

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

/**
 * Connection-level pragmas. Order matters:
 *   1. journal_mode=WAL is persistent and best set before any writes.
 *   2. foreign_keys is per-connection (must be set on every open).
 *   3. cache_size and synchronous tune durability/throughput.
 *
 * cache_size = -10000 means 10,000 KiB (~10 MB), not 10,000 pages.
 * The negative sign tells SQLite "kibibytes", which is more portable
 * than counting pages whose size depends on page_size.
 *
 * @type {ReadonlyArray<string>}
 */
const PRAGMAS = Object.freeze([
  'journal_mode = WAL',
  'foreign_keys = ON',
  'cache_size = -10000',
  'synchronous = NORMAL',
]);

/**
 * DDL for all seven tables. Each statement is idempotent
 * (`CREATE TABLE IF NOT EXISTS`) so initialization is safe to re-run on
 * every app launch.
 *
 * @type {ReadonlyArray<string>}
 */
const CREATE_TABLES = Object.freeze([
  // ─── ncrp_reports ────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ncrp_reports (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    filename               TEXT    NOT NULL,
    original_filename      TEXT    NOT NULL,
    upload_date            TEXT    NOT NULL,
    total_transactions     INTEGER,
    total_disputed_amount  REAL,
    total_layers           INTEGER,
    fraud_start_date       TEXT,
    analysis_status        TEXT    DEFAULT 'pending'
      CHECK (analysis_status IN ('pending','processing','complete','error')),
    analysis_json          TEXT,
    source_sha256          TEXT,
    old_transactions       TEXT,
    parse_warnings         TEXT,
    created_at             TEXT    DEFAULT CURRENT_TIMESTAMP
  )`,

  // ─── ncrp_transactions ───────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS ncrp_transactions (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id            INTEGER NOT NULL,
    ack_no               TEXT,
    complaint_date       TEXT,
    victim_account       TEXT,
    victim_bank          TEXT,
    beneficiary_account  TEXT,
    beneficiary_bank     TEXT,
    beneficiary_name     TEXT,
    ifsc_code            TEXT,
    transaction_date     TEXT,
    transaction_amount   REAL,
    disputed_amount      REAL,
    utr_no               TEXT,
    payment_mode         TEXT,
    layer_no             INTEGER,
    atm_id               TEXT,
    atm_location         TEXT,
    city                 TEXT,
    state                TEXT,
    remarks              TEXT,
    raw_beneficiary_bank TEXT,
    bank_source          TEXT,
    bank_flag            TEXT,
    same_day_cashout     INTEGER DEFAULT 0,
    cashout_mode         TEXT,
    is_duplicate         INTEGER DEFAULT 0,
    FOREIGN KEY (report_id) REFERENCES ncrp_reports(id) ON DELETE CASCADE
  )`,

  // ─── repeat_accounts ─────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS repeat_accounts (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    account_no            TEXT    NOT NULL UNIQUE,
    bank_name             TEXT,
    first_seen_report_id  INTEGER,
    appearance_count      INTEGER DEFAULT 1,
    total_amount_passed   REAL    DEFAULT 0,
    mule_score            REAL    DEFAULT 0,
    last_updated          TEXT    DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (first_seen_report_id) REFERENCES ncrp_reports(id) ON DELETE SET NULL
  )`,

  // ─── repeat_account_reports ──────────────────────────────────────
  // Contribution ledger behind repeat_accounts: one row per (canonical
  // account, report). repeat_accounts is DERIVED from this table — its
  // appearance_count counts contributing reports, never upsert calls — so
  // re-analysing a report replaces its contribution instead of inflating
  // the aggregate, and deleting a report withdraws it. All writes go
  // through queries.replaceReportRepeatContributions /
  // removeReportRepeatContributions.
  `CREATE TABLE IF NOT EXISTS repeat_account_reports (
    account_no    TEXT    NOT NULL,
    report_id     INTEGER NOT NULL,
    bank_name     TEXT,
    amount_passed REAL    DEFAULT 0,
    mule_score    REAL    DEFAULT 0,
    PRIMARY KEY (account_no, report_id),
    FOREIGN KEY (report_id) REFERENCES ncrp_reports(id) ON DELETE CASCADE
  )`,

  // ─── layer_analysis ──────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS layer_analysis (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id              INTEGER NOT NULL,
    layer_no               INTEGER NOT NULL,
    account_count          INTEGER,
    total_amount           REAL,
    disputed_amount        REAL,
    cashout_count          INTEGER,
    avg_forward_time_hours REAL,
    FOREIGN KEY (report_id) REFERENCES ncrp_reports(id) ON DELETE CASCADE
  )`,

  // ─── lien_records ────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS lien_records (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id          INTEGER NOT NULL,
    account_no         TEXT    NOT NULL,
    bank_name          TEXT,
    ifsc_code          TEXT,
    available_balance  REAL,
    lien_amount        REAL,
    lien_status        TEXT    DEFAULT 'pending'
      CHECK (lien_status IN ('pending','applied','success','rejected')),
    applied_date       TEXT,
    remarks            TEXT,
    created_at         TEXT    DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES ncrp_reports(id) ON DELETE CASCADE
  )`,

  // ─── draft_emails ────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS draft_emails (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id     INTEGER NOT NULL,
    bank_name     TEXT    NOT NULL,
    subject       TEXT,
    body          TEXT,
    account_list  TEXT,
    status        TEXT    DEFAULT 'draft'
      CHECK (status IN ('draft','sent')),
    created_at    TEXT    DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES ncrp_reports(id) ON DELETE CASCADE
  )`,

  // ─── audit_log ───────────────────────────────────────────────────
  // No FK on report_id — audit rows must outlive the report they reference.
  `CREATE TABLE IF NOT EXISTS audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id  INTEGER,
    action     TEXT    NOT NULL,
    details    TEXT,
    timestamp  TEXT    DEFAULT CURRENT_TIMESTAMP
  )`,
]);

/**
 * Indexes for hot read paths. Composite index on (report_id, layer_no)
 * for layer_analysis carries a UNIQUE constraint to prevent duplicate
 * layer rows from concurrent analysis runs.
 *
 * @type {ReadonlyArray<string>}
 */
const CREATE_INDEXES = Object.freeze([
  // ncrp_transactions hot paths
  'CREATE INDEX IF NOT EXISTS idx_txn_report_id          ON ncrp_transactions(report_id)',
  'CREATE INDEX IF NOT EXISTS idx_txn_beneficiary        ON ncrp_transactions(beneficiary_account)',
  'CREATE INDEX IF NOT EXISTS idx_txn_layer_no           ON ncrp_transactions(layer_no)',
  'CREATE INDEX IF NOT EXISTS idx_txn_transaction_date   ON ncrp_transactions(transaction_date)',
  'CREATE INDEX IF NOT EXISTS idx_txn_payment_mode       ON ncrp_transactions(payment_mode)',
  // Composite index matching the Transaction Browser's hot query: filter by
  // report_id, then ORDER BY transaction_date DESC, id DESC. Without it, every
  // page on a 50k-row report sorts the whole report in memory (>100ms); with
  // it SQLite walks the index backwards and the LIMIT/OFFSET is a cheap slice.
  'CREATE INDEX IF NOT EXISTS idx_txn_report_date        ON ncrp_transactions(report_id, transaction_date DESC, id DESC)',

  // layer_analysis: prevent dupes + enable per-report lookup
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_layer_report_layer ON layer_analysis(report_id, layer_no)',

  // lien_records lookups
  'CREATE INDEX IF NOT EXISTS idx_lien_report_id  ON lien_records(report_id)',
  'CREATE INDEX IF NOT EXISTS idx_lien_account_no ON lien_records(account_no)',

  // repeat_accounts (UNIQUE on account_no already creates an autoindex;
  // a named index is added per spec for explicit query planning)
  'CREATE INDEX IF NOT EXISTS idx_repeat_account_no ON repeat_accounts(account_no)',

  // repeat_account_reports: the PK covers by-account lookups; per-report
  // withdrawal (report delete / re-analysis replace) needs the reverse path.
  'CREATE INDEX IF NOT EXISTS idx_rar_report_id ON repeat_account_reports(report_id)',

  // draft_emails lookups
  'CREATE INDEX IF NOT EXISTS idx_email_report_id ON draft_emails(report_id)',
]);

/**
 * Additive, idempotent column migrations for tables that already exist in a
 * user's database from an earlier version. `CREATE TABLE IF NOT EXISTS` never
 * alters an existing table, so new columns introduced after first install must
 * be added here. Each entry is applied only when the column is absent (checked
 * via PRAGMA table_info), so re-running on every launch is safe.
 *
 * @type {ReadonlyArray<{ table: string, column: string, ddl: string }>}
 */
const COLUMN_MIGRATIONS = Object.freeze([
  // v0.2.0 — IFSC-authoritative bank attribution. `beneficiary_bank` now holds
  // the resolved (IFSC-derived) name; these preserve the original text and how
  // the name was resolved (see lib/ifscBankResolver).
  { table: 'ncrp_transactions', column: 'raw_beneficiary_bank',
    ddl: 'ALTER TABLE ncrp_transactions ADD COLUMN raw_beneficiary_bank TEXT' },
  { table: 'ncrp_transactions', column: 'bank_source',
    ddl: 'ALTER TABLE ncrp_transactions ADD COLUMN bank_source TEXT' },
  { table: 'ncrp_transactions', column: 'bank_flag',
    ddl: 'ALTER TABLE ncrp_transactions ADD COLUMN bank_flag TEXT' },

  // v0.3.0 — evidentiary provenance. SHA-256 of the raw uploaded NCRP file,
  // computed before parsing, so every report is cryptographically traceable to
  // its exact source (stamped into the PDF dossier + audit_log).
  { table: 'ncrp_reports', column: 'source_sha256',
    ddl: 'ALTER TABLE ncrp_reports ADD COLUMN source_sha256 TEXT' },

  // v0.3.1 — "Old Transaction" sheet support. JSON array of transactions that
  // predate the 6-month NCRP window; parsed and stored for the data-quality
  // annexure but excluded from every financial figure.
  { table: 'ncrp_reports', column: 'old_transactions',
    ddl: 'ALTER TABLE ncrp_reports ADD COLUMN old_transactions TEXT' },

  // v0.4.0 — self-healing fuzzy parser. JSON array of structured parse warnings
  // (fuzzy sheet/column resolutions + degraded informational columns), folded
  // into analysis_json for the Data Quality "Parser Warnings" panel + PDF/Excel
  // parse-audit trail. Never affects a financial figure.
  { table: 'ncrp_reports', column: 'parse_warnings',
    ddl: 'ALTER TABLE ncrp_reports ADD COLUMN parse_warnings TEXT' },

  // v0.5.0 — Transactions raw-evidence view. Per-row exact-duplicate flag so the
  // flat ledger table can MARK the re-listed legs that the dedup system collapses
  // (shown but flagged), keeping the raw evidence view self-documenting. Written
  // by the analyzer write-back from its single dedup definition; 0 for the kept
  // first occurrence and every non-duplicate row, 1 for an exact-duplicate leg.
  { table: 'ncrp_transactions', column: 'is_duplicate',
    ddl: 'ALTER TABLE ncrp_transactions ADD COLUMN is_duplicate INTEGER DEFAULT 0' },
]);

/**
 * Apply COLUMN_MIGRATIONS, skipping any column that already exists.
 *
 * @param {Database.Database} db - Open connection.
 */
function applyColumnMigrations(db) {
  const columnsOf = new Map();
  const existing = (table) => {
    if (!columnsOf.has(table)) {
      const cols = new Set(db.pragma(`table_info(${table})`).map((c) => c.name));
      columnsOf.set(table, cols);
    }
    return columnsOf.get(table);
  };
  for (const { table, column, ddl } of COLUMN_MIGRATIONS) {
    if (!existing(table).has(column)) {
      db.exec(ddl);
      existing(table).add(column);
    }
  }
}

/**
 * One-time rebuild of the repeat-account registry for databases created
 * before the contribution ledger existed (≤ v0.5.x). The legacy upsert
 * incremented appearance_count on EVERY analysis run — so re-analysing a
 * report inflated counts — keyed rows on raw display strings (zero-padded
 * variants of one account split into two rows), and never withdrew a
 * deleted report's contribution.
 *
 * Rebuild strategy: re-derive each complete report's contribution from its
 * stored analysis_json (mule_detection) via the same idempotent replace
 * path new analyses use, then drop aggregate rows left with no backing
 * contribution (deleted reports / unparseable snapshots) — those counts
 * were unreliable by construction and self-heal on the next re-analysis.
 *
 * Guarded: runs only when the ledger is empty but legacy aggregates exist,
 * so it executes at most once per database and never on fresh installs.
 *
 * @param {Database.Database} db - Open connection (schema already applied).
 */
function rebuildRepeatRegistryFromSnapshots(db) {
  const hasLedger = db.prepare('SELECT 1 FROM repeat_account_reports LIMIT 1').get();
  const hasLegacy = db.prepare('SELECT 1 FROM repeat_accounts LIMIT 1').get();
  if (hasLedger || !hasLegacy) return;

  // Lazy: queries.js is require-free at load, but keep schema.js importable
  // without pulling the analyzer chain in unless a rebuild actually runs.
  const { replaceReportRepeatContributions } = require('./queries');

  const reports = db.prepare(`
    SELECT id, analysis_json FROM ncrp_reports
     WHERE analysis_status = 'complete' AND analysis_json IS NOT NULL
  `).all();
  for (const r of reports) {
    let mules;
    try {
      const parsed = JSON.parse(r.analysis_json);
      mules = parsed && Array.isArray(parsed.mule_detection) ? parsed.mule_detection : [];
    } catch (_e) {
      continue; // malformed snapshot — heals on next re-analysis
    }
    replaceReportRepeatContributions(db, r.id, mules.map((m) => ({
      account_no: m.account_no,
      bank_name: m.bank_name,
      amount_passed: m.total_received,
      mule_score: m.mule_score,
    })));
  }

  db.prepare(`
    DELETE FROM repeat_accounts
     WHERE account_no NOT IN (SELECT DISTINCT account_no FROM repeat_account_reports)
  `).run();
}

/**
 * Open the SQLite database at `dbPath`, ensuring its parent directory
 * exists, applying connection pragmas, and creating the schema + indexes
 * if not already present. Safe to call on every app launch.
 *
 * Throws a descriptive error (and closes any partially-opened handle) if
 * the file cannot be created, opened, or migrated.
 *
 * @param {string} dbPath - Absolute or relative path to the SQLite file.
 *                         Parent directory will be created recursively.
 * @returns {Database.Database} An open better-sqlite3 connection.
 *
 * @example
 *   const { initializeDatabase } = require('./schema');
 *   const db = initializeDatabase(path.join(appData, 'fintrace.sqlite'));
 */
function initializeDatabase(dbPath) {
  if (typeof dbPath !== 'string' || dbPath.trim() === '') {
    throw new TypeError(
      'initializeDatabase: dbPath must be a non-empty string'
    );
  }

  // ':memory:' is a better-sqlite3 sentinel for an in-memory DB; passing it
  // through path.resolve would convert it to a real filesystem path and break
  // the open. Detect and skip the directory-creation dance.
  const isMemory = dbPath === ':memory:';
  const resolvedPath = isMemory ? ':memory:' : path.resolve(dbPath);

  if (!isMemory) {
    const parentDir = path.dirname(resolvedPath);
    try {
      fs.mkdirSync(parentDir, { recursive: true });
    } catch (err) {
      throw new Error(
        `initializeDatabase: failed to create parent directory ${parentDir}: ${err.message}`
      );
    }
  }

  /** @type {Database.Database} */
  let db;
  try {
    db = new Database(resolvedPath);
  } catch (err) {
    throw new Error(
      `initializeDatabase: failed to open SQLite at ${resolvedPath}: ${err.message}`
    );
  }

  try {
    // Pragmas must run *outside* an explicit transaction.
    for (const pragma of PRAGMAS) {
      db.pragma(pragma);
    }

    // DDL grouped in one transaction — all-or-nothing setup.
    const initTxn = db.transaction(() => {
      for (const ddl of CREATE_TABLES) db.exec(ddl);
      for (const ddl of CREATE_INDEXES) db.exec(ddl);
      applyColumnMigrations(db);
      rebuildRepeatRegistryFromSnapshots(db);
    });
    initTxn();

    return db;
  } catch (err) {
    try { db.close(); } catch (_e) { /* swallow secondary close error */ }
    throw new Error(
      `initializeDatabase: failed to apply schema/indexes: ${err.message}`
    );
  }
}

module.exports = {
  initializeDatabase,
  rebuildRepeatRegistryFromSnapshots,
  PRAGMAS,
  CREATE_TABLES,
  CREATE_INDEXES,
  COLUMN_MIGRATIONS,
};
