'use strict';

/**
 * FinTrace NCRP — day-of-week activity breakdown.
 *
 * Groups dated legs by their IST weekday (Mon–Sun) and reports the transaction
 * count + total amount per weekday. Undated legs (no parseable transaction date)
 * are kept in a separate "Undated" bucket so the visible counts still foot to the
 * full leg total — nothing is silently dropped.
 *
 * IST (UTC+5:30) is used because NCRP is an Indian system and "which day" is an
 * Indian-clock concept — consistent with the rest of the analyzer's calendar-day
 * logic. Pure, synchronous, deterministic (weekday order is fixed Mon→Sun).
 *
 * @module backend/src/analysis/dayOfWeek
 */

const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
dayjs.extend(utc);

/** IST is UTC+5:30. */
const IST_OFFSET_MINUTES = 330;

/** dayjs .day(): 0=Sunday … 6=Saturday. */
const WEEKDAY_NAME = Object.freeze([
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
]);

/** Display order: working week first, weekend last. */
const WEEKDAY_ORDER = Object.freeze([
  'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday',
]);

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}

function toMs(iso) {
  if (iso === null || iso === undefined) return null;
  const m = Date.parse(String(iso));
  return Number.isFinite(m) ? m : null;
}

/**
 * Build the day-of-week breakdown.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched + deduped rows.
 * @returns {{
 *   weekdays: Array<{ weekday: string, txns: number, totalAmount: number }>,
 *   undated: { weekday: 'Undated', txns: number, totalAmount: number },
 * }} `weekdays` is always seven entries in Mon→Sun order (zero-filled).
 */
function dayOfWeekBreakdown(txns) {
  /** @type {Map<string, { weekday: string, txns: number, totalAmount: number }>} */
  const byDay = new Map();
  for (const w of WEEKDAY_ORDER) byDay.set(w, { weekday: w, txns: 0, totalAmount: 0 });

  let undatedTxns = 0;
  let undatedAmount = 0;

  for (const t of (txns || [])) {
    const ms = toMs(t.transaction_date);
    const amt = num(t.transaction_amount);
    if (ms === null) {
      undatedTxns += 1;
      undatedAmount += amt;
      continue;
    }
    const weekday = WEEKDAY_NAME[dayjs.utc(ms).add(IST_OFFSET_MINUTES, 'minute').day()];
    const bucket = byDay.get(weekday);
    bucket.txns += 1;
    bucket.totalAmount += amt;
  }

  return {
    weekdays: WEEKDAY_ORDER.map((w) => {
      const b = byDay.get(w);
      return { weekday: w, txns: b.txns, totalAmount: round2(b.totalAmount) };
    }),
    undated: { weekday: 'Undated', txns: undatedTxns, totalAmount: round2(undatedAmount) },
  };
}

module.exports = { dayOfWeekBreakdown, WEEKDAY_ORDER };
