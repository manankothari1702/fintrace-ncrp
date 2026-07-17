'use strict';

/**
 * FinTrace Bank Statement module — behavioral-analysis thresholds.
 *
 * Every tunable number the single-statement analyzer uses, named in one
 * place (the same pattern as NCRP's mule_weights.json: analysts adjust
 * here, never inside the engine). Each threshold documents the behavioral
 * signal it gates.
 *
 * IMPORTANT granularity note: bank-statement transaction dates carry NO
 * time-of-day (PNB exports are date-only), so all "rapid"/"velocity"
 * signals are computed at DAY granularity — never presented as intra-day
 * timing.
 *
 * @module backend/src/config/bankStatementThresholds
 */

module.exports = Object.freeze({
  /** Round-figure structuring signal: an amount counts as "round" when it is
   *  a multiple of this modulus… */
  ROUND_FIGURE_MODULUS: 1000,
  /** …and at least this large (₹500 UPI lunches are round but meaningless). */
  ROUND_FIGURE_MIN_AMOUNT: 1000,
  /** Flag fires when at least this many round-figure transactions exist… */
  ROUND_FIGURE_FLAG_MIN_COUNT: 5,
  /** …and they are at least this share of all transactions. */
  ROUND_FIGURE_FLAG_MIN_SHARE: 0.25,

  /** Rapid-transaction days: a day with at least this many transactions. */
  RAPID_DAY_MIN_TXNS: 8,

  /** Pass-through days: total credited that day at least this much… */
  PASSTHROUGH_MIN_CREDIT_TOTAL: 5000,
  /** …with same-day debits at least this share of the day's credits. */
  PASSTHROUGH_MIN_OUT_RATIO: 0.8,

  /** Repeat counterparty: at least this many transactions with one party. */
  REPEAT_COUNTERPARTY_MIN_TXNS: 5,
  /** High-value counterparty: total volume (sent+received) at least this. */
  HIGH_VALUE_COUNTERPARTY_MIN_TOTAL: 50000,

  /** Entries in each top-counterparties ranking. */
  TOP_N: 5,
});
