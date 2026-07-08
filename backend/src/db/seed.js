'use strict';

/**
 * FinTrace NCRP — deterministic demo seed.
 *
 * Populates an empty DB with one sample NCRP report, fifty linked
 * transactions spanning layers 0–4, derived layer aggregates, lien
 * worksheet rows, per-bank draft emails, the cross-case repeat-accounts
 * registry, and three audit-log entries.
 *
 * Designed to satisfy the demo invariants:
 *   • 50 transactions, layers 0..4 all populated
 *   • two beneficiary accounts repeat across layers
 *       — POOL[0] appears in layers 0 + 2
 *       — POOL[3] appears in layers 1 + 3
 *   • ATM cashouts in layers 3 and 4 (with one hotspot ATM)
 *   • three distinct states (Maharashtra, Delhi, Karnataka)
 *   • payment modes include UPI, IMPS, NEFT, ATM, POS
 *
 * Idempotent: re-running on a non-empty DB will insert a fresh report
 * (with a new id), not mutate previous data.
 *
 * @module backend/src/db/seed
 */

const {
  insertReport,
  updateReportAnalysis,
  insertManyTransactions,
  insertLayerAnalysis,
  insertLienRecord,
  insertDraftEmail,
  insertAuditLog,
  replaceReportRepeatContributions,
} = require('./queries');

// ─── Reference data ──────────────────────────────────────────────────

/** The complainant whose funds were stolen. */
const VICTIM = Object.freeze({
  ack_no:          'NCRP202612345678',
  complaint_date:  '2026-05-20T10:30:00.000Z',
  account:         '50100123456789',
  bank:            'HDFC Bank',
});

/**
 * Beneficiary pool — eight downstream accounts referenced by index from
 * the layer plan below. Spread across five banks and three states so the
 * geography breakdown is non-trivial.
 *
 * @type {ReadonlyArray<{
 *   account: string, bank: string, ifsc: string, name: string,
 *   state: string, city: string,
 * }>}
 */
const POOL = Object.freeze([
  // 0 — appears in L0 + L2 (repeat across layers)
  { account: '31234567890',    bank: 'State Bank of India',    ifsc: 'SBIN0005678', name: 'RAVI KUMAR',   state: 'Maharashtra', city: 'Mumbai' },
  // 1
  { account: '50100987654321', bank: 'HDFC Bank',              ifsc: 'HDFC0001234', name: 'PRIYA SHARMA', state: 'Delhi',       city: 'New Delhi' },
  // 2
  { account: '623456789012',   bank: 'ICICI Bank',             ifsc: 'ICIC0009012', name: 'AMIT PATEL',   state: 'Karnataka',   city: 'Bengaluru' },
  // 3 — appears in L1 + L3 (repeat across layers)
  { account: '917890123456',   bank: 'Axis Bank',              ifsc: 'UTIB0003456', name: 'NEHA VERMA',   state: 'Maharashtra', city: 'Pune' },
  // 4
  { account: '823456789012',   bank: 'Kotak Mahindra Bank',    ifsc: 'KKBK0007890', name: 'RAJ MEHTA',    state: 'Delhi',       city: 'Dwarka' },
  // 5
  { account: '112345678901',   bank: 'State Bank of India',    ifsc: 'SBIN0005678', name: 'SANJAY GUPTA', state: 'Karnataka',   city: 'Mysuru' },
  // 6
  { account: '212345678901',   bank: 'ICICI Bank',             ifsc: 'ICIC0009012', name: 'POOJA SINGH',  state: 'Maharashtra', city: 'Nagpur' },
  // 7
  { account: '312345678901',   bank: 'HDFC Bank',              ifsc: 'HDFC0001234', name: 'ARJUN REDDY',  state: 'Karnataka',   city: 'Hubli' },
]);

/** ATM terminals; ATM00012 is intentionally hit multiple times → hotspot. */
const ATMS = Object.freeze([
  { atm_id: 'ATM00012', atm_location: 'Mumbai Central Railway Station',  state: 'Maharashtra', city: 'Mumbai' },
  { atm_id: 'ATM00034', atm_location: 'Connaught Place Branch ATM',      state: 'Delhi',       city: 'New Delhi' },
  { atm_id: 'ATM00056', atm_location: 'MG Road Cross ATM',               state: 'Karnataka',   city: 'Bengaluru' },
  { atm_id: 'ATM00078', atm_location: 'Indiranagar 100ft Road ATM',      state: 'Karnataka',   city: 'Bengaluru' },
  { atm_id: 'ATM00012', atm_location: 'Mumbai Central Railway Station',  state: 'Maharashtra', city: 'Mumbai' }, // hotspot
]);

/**
 * The full transaction plan: 50 entries, layers 0..4. Each entry has a
 * beneficiary pool index plus a payment mode; ATM rows additionally
 * carry an `atm` index into ATMS so the cashout location is concrete.
 *
 * @type {ReadonlyArray<{
 *   layer: number,
 *   beneficiary: number,
 *   mode: 'UPI'|'IMPS'|'NEFT'|'ATM'|'POS',
 *   amount: number,
 *   atm?: number,
 * }>}
 */
const TXN_PLAN = Object.freeze([
  // ─ Layer 0 — victim → first hop (5 txns) ───────────────────────────
  { layer: 0, beneficiary: 0, mode: 'IMPS', amount:  50000 },
  { layer: 0, beneficiary: 0, mode: 'IMPS', amount:  75000 },
  { layer: 0, beneficiary: 1, mode: 'UPI',  amount: 100000 },
  { layer: 0, beneficiary: 2, mode: 'NEFT', amount:  60000 },
  { layer: 0, beneficiary: 1, mode: 'IMPS', amount:  80000 },

  // ─ Layer 1 — first split (10 txns) ─────────────────────────────────
  { layer: 1, beneficiary: 3, mode: 'UPI',  amount:  30000 },
  { layer: 1, beneficiary: 4, mode: 'IMPS', amount:  25000 },
  { layer: 1, beneficiary: 3, mode: 'UPI',  amount:  40000 },
  { layer: 1, beneficiary: 5, mode: 'NEFT', amount:  20000 },
  { layer: 1, beneficiary: 4, mode: 'UPI',  amount:  35000 },
  { layer: 1, beneficiary: 3, mode: 'IMPS', amount:  28000 },
  { layer: 1, beneficiary: 5, mode: 'UPI',  amount:  22000 },
  { layer: 1, beneficiary: 4, mode: 'NEFT', amount:  18000 },
  { layer: 1, beneficiary: 5, mode: 'IMPS', amount:  32000 },
  { layer: 1, beneficiary: 4, mode: 'UPI',  amount:  27000 },

  // ─ Layer 2 — second split, POOL[0] reappears here (12 txns) ─────────
  { layer: 2, beneficiary: 0, mode: 'UPI',  amount:  15000 }, // ← repeat
  { layer: 2, beneficiary: 6, mode: 'IMPS', amount:  12000 },
  { layer: 2, beneficiary: 0, mode: 'UPI',  amount:  18000 }, // ← repeat
  { layer: 2, beneficiary: 6, mode: 'NEFT', amount:  20000 },
  { layer: 2, beneficiary: 5, mode: 'UPI',  amount:  14000 },
  { layer: 2, beneficiary: 0, mode: 'IMPS', amount:  16000 }, // ← repeat
  { layer: 2, beneficiary: 6, mode: 'UPI',  amount:  10000 },
  { layer: 2, beneficiary: 5, mode: 'UPI',  amount:  13000 },
  { layer: 2, beneficiary: 6, mode: 'NEFT', amount:  17000 },
  { layer: 2, beneficiary: 5, mode: 'IMPS', amount:  11000 },
  { layer: 2, beneficiary: 6, mode: 'UPI',  amount:  19000 },
  { layer: 2, beneficiary: 5, mode: 'UPI',  amount:   9000 },

  // ─ Layer 3 — transfers + ATM cashouts, POOL[3] reappears (13 txns) ──
  { layer: 3, beneficiary: 7, mode: 'UPI',  amount:   8000 },
  { layer: 3, beneficiary: 7, mode: 'IMPS', amount:   9500 },
  { layer: 3, beneficiary: 3, mode: 'UPI',  amount:   7500 }, // ← repeat
  { layer: 3, beneficiary: 7, mode: 'ATM',  amount:  10000, atm: 0 },
  { layer: 3, beneficiary: 3, mode: 'NEFT', amount:   6000 }, // ← repeat
  { layer: 3, beneficiary: 7, mode: 'ATM',  amount:  10000, atm: 1 },
  { layer: 3, beneficiary: 6, mode: 'UPI',  amount:   5500 },
  { layer: 3, beneficiary: 7, mode: 'POS',  amount:   8500 },
  { layer: 3, beneficiary: 3, mode: 'UPI',  amount:   7000 }, // ← repeat
  { layer: 3, beneficiary: 7, mode: 'ATM',  amount:  10000, atm: 2 },
  { layer: 3, beneficiary: 6, mode: 'IMPS', amount:   6500 },
  { layer: 3, beneficiary: 7, mode: 'ATM',  amount:  10000, atm: 4 }, // hotspot
  { layer: 3, beneficiary: 6, mode: 'UPI',  amount:   7200 },

  // ─ Layer 4 — terminal cashouts (10 txns) ───────────────────────────
  { layer: 4, beneficiary: 7, mode: 'ATM',  amount:  10000, atm: 0 },
  { layer: 4, beneficiary: 6, mode: 'ATM',  amount:  10000, atm: 3 },
  { layer: 4, beneficiary: 7, mode: 'ATM',  amount:  10000, atm: 4 }, // hotspot
  { layer: 4, beneficiary: 7, mode: 'POS',  amount:  12000 },
  { layer: 4, beneficiary: 6, mode: 'ATM',  amount:  10000, atm: 1 },
  { layer: 4, beneficiary: 7, mode: 'ATM',  amount:  10000, atm: 4 }, // hotspot
  { layer: 4, beneficiary: 6, mode: 'POS',  amount:   9500 },
  { layer: 4, beneficiary: 7, mode: 'ATM',  amount:  10000, atm: 2 },
  { layer: 4, beneficiary: 7, mode: 'ATM',  amount:  10000, atm: 3 },
  { layer: 4, beneficiary: 6, mode: 'ATM',  amount:  10000, atm: 0 },
]);

// ─── Builders ────────────────────────────────────────────────────────

/** First L0 transaction time. */
const TRAIL_START_MS = Date.parse('2026-05-15T10:00:00.000Z');
/** Spacing between rows in the plan. ~1.5 h × 50 = ~75 h trail = ~3 days. */
const TXN_INTERVAL_MS = 90 * 60 * 1000;

/**
 * Materialise the abstract TXN_PLAN into row objects ready for
 * insertManyTransactions, stamping them with report_id, victim info,
 * UTR numbers, and per-row beneficiary / ATM geography.
 *
 * @param {number} reportId
 * @returns {Array<Record<string, unknown>>}
 */
function buildTransactionRows(reportId) {
  return TXN_PLAN.map((row, idx) => {
    const benef = POOL[row.beneficiary];
    const isCashout = row.mode === 'ATM' || row.mode === 'POS';
    const atm = row.atm != null ? ATMS[row.atm] : null;

    // ATM rows take their location from the ATM (where the cash was
    // withdrawn). Non-ATM transfers take the beneficiary's home city.
    const geo = atm
      ? { state: atm.state, city: atm.city }
      : { state: benef.state, city: benef.city };

    const txnDate = new Date(TRAIL_START_MS + idx * TXN_INTERVAL_MS).toISOString();
    const utrNo  = `UTR${String(2026050000000 + idx + 1).padStart(15, '0')}`;

    // Derive cashout_mode from payment_mode; cashouts in L3/L4 fall
    // within the same synthetic day so same_day_cashout is set there.
    const cashoutMode =
      row.mode === 'ATM'  ? 'ATM_WITHDRAWAL'   :
      row.mode === 'POS'  ? 'POS_PURCHASE'     :
      row.mode === 'UPI'  ? 'UPI_TRANSFER_OUT' :
      row.mode === 'IMPS' ? 'ONLINE_PURCHASE'  :
      row.mode === 'NEFT' ? 'ONLINE_PURCHASE'  :
                            'UNKNOWN';
    const sameDayCashout =
      (row.mode === 'ATM' || row.mode === 'POS') && row.layer >= 3 ? 1 : 0;

    return {
      report_id:           reportId,
      ack_no:              VICTIM.ack_no,
      complaint_date:      VICTIM.complaint_date,
      victim_account:      VICTIM.account,
      victim_bank:         VICTIM.bank,
      beneficiary_account: benef.account,
      beneficiary_bank:    benef.bank,
      beneficiary_name:    benef.name,
      ifsc_code:           benef.ifsc,
      transaction_date:    txnDate,
      transaction_amount:  row.amount,
      disputed_amount:     row.amount, // every transfer in the trail is disputed
      utr_no:              utrNo,
      payment_mode:        row.mode,
      layer_no:            row.layer,
      atm_id:              atm ? atm.atm_id       : null,
      atm_location:        atm ? atm.atm_location : null,
      city:                geo.city,
      state:               geo.state,
      remarks: isCashout
        ? (atm ? `Cash withdrawal @ ${atm.atm_id}` : 'POS purchase')
        : `${row.mode} transfer to ${benef.name}`,
      same_day_cashout:    sameDayCashout,
      cashout_mode:        cashoutMode,
    };
  });
}

/**
 * Compute per-layer aggregates from the materialised rows.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {number} reportId
 * @returns {Array<{
 *   report_id: number, layer_no: number, account_count: number,
 *   total_amount: number, disputed_amount: number, cashout_count: number,
 *   avg_forward_time_hours: number,
 * }>}
 */
function buildLayerAggregates(rows, reportId) {
  const byLayer = new Map();
  for (const r of rows) {
    const layer = r.layer_no;
    if (!byLayer.has(layer)) {
      byLayer.set(layer, {
        report_id:        reportId,
        layer_no:         layer,
        accountsSet:      new Set(),
        total_amount:     0,
        disputed_amount:  0,
        cashout_count:    0,
      });
    }
    const agg = byLayer.get(layer);
    agg.accountsSet.add(r.beneficiary_account);
    agg.total_amount    += r.transaction_amount;
    agg.disputed_amount += r.disputed_amount;
    if (r.payment_mode === 'ATM' || r.payment_mode === 'POS') agg.cashout_count++;
  }

  // Demo values for avg forward-time per layer (closer to victim = faster
  // forwarding in real cases). Plausible numbers, not derived here.
  const avgForwardHoursByLayer = { 0: 0.3, 1: 1.2, 2: 3.5, 3: 8.1, 4: 14.4 };

  return [...byLayer.values()]
    .sort((a, b) => a.layer_no - b.layer_no)
    .map((a) => ({
      report_id:              a.report_id,
      layer_no:               a.layer_no,
      account_count:          a.accountsSet.size,
      total_amount:           a.total_amount,
      disputed_amount:        a.disputed_amount,
      cashout_count:          a.cashout_count,
      avg_forward_time_hours: avgForwardHoursByLayer[a.layer_no] ?? null,
    }));
}

/**
 * One lien_records row per unique beneficiary account in the trail, with
 * a recoverable amount equal to the sum of inflows on that account.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {number} reportId
 */
function buildLienRecords(rows, reportId) {
  const byAccount = new Map();
  for (const r of rows) {
    const key = r.beneficiary_account;
    if (!byAccount.has(key)) {
      byAccount.set(key, {
        report_id:         reportId,
        account_no:        r.beneficiary_account,
        bank_name:         r.beneficiary_bank,
        ifsc_code:         r.ifsc_code,
        available_balance: 0,
        lien_amount:       0,
        lien_status:       'pending',
        applied_date:      null,
        remarks:           `Disputed funds across multiple layers (ack ${VICTIM.ack_no})`,
      });
    }
    byAccount.get(key).lien_amount += r.transaction_amount;
  }

  // Plausible available_balance: 60% of disputed lien amount, rounded.
  for (const rec of byAccount.values()) {
    rec.available_balance = Math.round(rec.lien_amount * 0.6);
  }
  return [...byAccount.values()];
}

/**
 * One draft email per beneficiary bank, listing all flagged accounts at
 * that bank for the lien request.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {number} reportId
 */
function buildDraftEmails(rows, reportId) {
  const byBank = new Map();
  for (const r of rows) {
    const bank = r.beneficiary_bank;
    if (!bank) continue;
    if (!byBank.has(bank)) byBank.set(bank, new Set());
    byBank.get(bank).add(r.beneficiary_account);
  }

  return [...byBank.entries()].map(([bankName, accountsSet]) => {
    const accounts = [...accountsSet];
    const subject =
      `Request for Lien Marking under Section 102 CrPC / IT Act, 2000 ` +
      `— Acknowledgement No: ${VICTIM.ack_no}`;
    const body =
      `To,\nThe Nodal Officer,\n${bankName}\n\n` +
      `Subject: ${subject}\n\n` +
      `Respected Sir/Madam,\n\n` +
      `In reference to NCRP complaint ${VICTIM.ack_no} dated ` +
      `${VICTIM.complaint_date.slice(0, 10)}, you are requested to mark ` +
      `lien on the following ${accounts.length} account(s) held with ` +
      `${bankName} that received disputed funds:\n\n` +
      accounts.map((a, i) => `  ${i + 1}. ${a}`).join('\n') +
      `\n\nThis request is made under Section 102 CrPC read with the ` +
      `Information Technology Act, 2000.\n\n` +
      `For Official Use Only.\n\n` +
      `Yours sincerely,\n[Investigating Officer]\n`;

    return {
      report_id:    reportId,
      bank_name:    bankName,
      subject,
      body,
      account_list: accounts, // helper stringifies arrays
      status:       'draft',
    };
  });
}

/**
 * Pre-computed mule_score per pool index. Hand-picked so demo screens
 * show a realistic spread; in production these come from analysis/muleScoring.
 */
const SEED_MULE_SCORES = Object.freeze({
  '31234567890':    82, // POOL[0] — repeat across layers, high pass-through
  '50100987654321': 55, // POOL[1]
  '623456789012':   42, // POOL[2]
  '917890123456':   78, // POOL[3] — repeat across layers
  '823456789012':   48, // POOL[4]
  '112345678901':   51, // POOL[5]
  '212345678901':   71, // POOL[6] — many cashouts
  '312345678901':   89, // POOL[7] — heaviest cashout terminal
});

// ─── Public entry point ──────────────────────────────────────────────

/**
 * Seed the database with one sample report and its full derived state.
 *
 * The whole seed runs inside a single transaction — either every table
 * gains its sample rows or none do.
 *
 * @param {Database.Database} db An open better-sqlite3 connection,
 *   already initialised via `initializeDatabase(...)`.
 * @returns {{
 *   reportId: number,
 *   transactionsInserted: number,
 *   layersInserted: number,
 *   liensInserted: number,
 *   emailsInserted: number,
 *   repeatAccountsTouched: number,
 * }} Summary of what was written.
 */
function seedDatabase(db) {
  if (!db || typeof db.transaction !== 'function') {
    throw new TypeError(
      'seedDatabase: db must be an open better-sqlite3 connection'
    );
  }

  const result = {
    reportId:              0,
    transactionsInserted:  0,
    layersInserted:        0,
    liensInserted:         0,
    emailsInserted:        0,
    repeatAccountsTouched: 0,
  };

  const runSeed = db.transaction(() => {
    // 1. Report row — totals filled in once we know them.
    const reportId = insertReport(db, {
      filename:              'sample_ncrp_demo.xlsx',
      original_filename:     `BankAction_CompleteTrail_${VICTIM.ack_no}.xlsx`,
      upload_date:           new Date().toISOString(),
      analysis_status:       'processing',
    });
    result.reportId = reportId;

    insertAuditLog(db, {
      report_id: reportId,
      action:    'seed.report_inserted',
      details:   { ack_no: VICTIM.ack_no },
    });

    // 2. Transactions (one batch transaction → fast).
    const rows = buildTransactionRows(reportId);
    result.transactionsInserted = insertManyTransactions(db, rows);

    insertAuditLog(db, {
      report_id: reportId,
      action:    'seed.transactions_inserted',
      details:   { count: result.transactionsInserted },
    });

    // 3. Layer aggregates.
    const layerAggs = buildLayerAggregates(rows, reportId);
    for (const agg of layerAggs) insertLayerAnalysis(db, agg);
    result.layersInserted = layerAggs.length;

    // 4. Lien worksheet.
    const liens = buildLienRecords(rows, reportId);
    for (const lien of liens) insertLienRecord(db, lien);
    result.liensInserted = liens.length;

    // 5. Draft emails (per bank).
    const emails = buildDraftEmails(rows, reportId);
    for (const email of emails) insertDraftEmail(db, email);
    result.emailsInserted = emails.length;

    // 6. Cross-case repeat-account registry: ONE contribution per beneficiary
    //    account for this report (replace() folds the per-transaction entries
    //    by canonical key — amounts sum, mule_score takes the max). Idempotent:
    //    re-seeding replaces this report's contribution instead of inflating
    //    appearance_count, which now counts contributing reports, not calls.
    const { accounts: repeatAccounts } = replaceReportRepeatContributions(
      db, reportId,
      rows.map((r) => ({
        account_no:    r.beneficiary_account,
        bank_name:     r.beneficiary_bank,
        amount_passed: r.transaction_amount,
        mule_score:    SEED_MULE_SCORES[r.beneficiary_account] ?? 0,
      }))
    );
    result.repeatAccountsTouched = repeatAccounts;

    // 7. Update report row with totals + flip status to complete.
    const totalDisputed = layerAggs.reduce((s, l) => s + l.disputed_amount, 0);
    updateReportAnalysis(db, reportId, {
      analysis_status:       'complete',
      total_transactions:    rows.length,
      total_disputed_amount: totalDisputed,
      total_layers:          layerAggs.length,
      fraud_start_date:      rows[0].transaction_date.slice(0, 10),
      analysis_json: JSON.stringify({
        ack_no:           VICTIM.ack_no,
        victim:           { account: VICTIM.account, bank: VICTIM.bank },
        layers:           layerAggs.length,
        total_disputed:   totalDisputed,
        hotspot_atms:     ['ATM00012'],
        top_suspects:     [
          { account: '312345678901', score: SEED_MULE_SCORES['312345678901'] },
          { account: '31234567890',  score: SEED_MULE_SCORES['31234567890']  },
          { account: '917890123456', score: SEED_MULE_SCORES['917890123456'] },
        ],
      }),
    });

    insertAuditLog(db, {
      report_id: reportId,
      action:    'seed.analysis_complete',
      details:   {
        total_transactions:  rows.length,
        total_disputed:      totalDisputed,
        layers:              layerAggs.length,
      },
    });
  });

  try {
    runSeed();
  } catch (err) {
    throw new Error(`seedDatabase: failed to seed sample data: ${err.message}`);
  }

  return result;
}

module.exports = {
  seedDatabase,
  // Exported for tests / introspection
  VICTIM,
  POOL,
  ATMS,
  TXN_PLAN,
};
