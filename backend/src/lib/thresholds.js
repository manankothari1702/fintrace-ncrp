'use strict';

/**
 * Batch-1 investigation-metric thresholds — every tunable number for the five
 * competitive-parity features lives here (spec non-negotiable: no magic numbers
 * inline). Each value was sanity-checked against the two gold-standard cases
 * (32712250107145 and 32712250107170); where a UX-doc placeholder would have
 * flagged every case or no case, it was changed and the reason is noted inline.
 *
 * The analyzer reads these to compute per-metric severities/flags ONCE at
 * analysis time; the flags are cached in analysis_json and the frontend only
 * renders them, so the thresholds have a single source of truth (here).
 */
module.exports = Object.freeze({
  // ── Feature 1 · Response Gap (fraud → first bank action), in DAYS ──────────
  // Gold: case 145 = 7.6 d, case 170 = 200.7 d. The doc's 7/14 bands differentiate
  // the two cleanly (145 amber, 170 red), so they are kept as-is.
  RESPONSE_GAP_AMBER_DAYS: 7,
  RESPONSE_GAP_RED_DAYS: 14,

  // ── Feature 1 · Recovery Rate = (on_hold + refunded) / victim_loss, PERCENT ─
  // The UX doc measured refunded / loss, but `refunded` is 0 for every case at
  // ingest (nothing is refunded before officers act), so that metric is a flat
  // 0% and its "red at 0%" band would fire on EVERY case — meaningless. Redefined
  // to "funds secured or returned" (frozen + refunded), which varies across real
  // cases (145 = 13.1%, 170 = 43.8%). The doc's 25%/0% bands are kept.
  RECOVERY_RATE_AMBER_PCT: 25, // below this → amber (attention)
  RECOVERY_RATE_RED_PCT: 0, // at/below this → red (nothing secured at all)

  // ── Feature 1 · Cash-out Speed ─────────────────────────────────────────────
  // Neutral/informational per the doc — no good/bad band, so no threshold here.

  // ── Feature 2 · Layer fan-out HIGH flag (accounts_next / accounts_this) ─────
  // Gold: 145 flags only L3 (2.25×); 170 flags L1 (25.67×) and L2 (3.42×). An
  // absolute ratio ≥ 2.0 ("money more than doubled its spread here") is legible
  // and flags a meaningful minority of layers rather than all or none.
  FANOUT_HIGH_RATIO: 2.0,

  // ── Feature 3 · Aggregator (collection point) by distinct-sender fan-in ─────
  // in_degree = count of distinct upstream senders into an account. The doc's
  // "5+ senders" flags ZERO accounts on the primary gold case 145 (its max
  // in_degree is 3), so the feature would look empty. The detection floor is
  // lowered to 3 — which matches the existing mule "collector" bonus that starts
  // at in_degree ≥ 3 — and the doc's 5+ is preserved as the high-severity (red)
  // tier. Gold: 145 → 1 aggregator (amber); 170 → 18 (11 amber, 7 red).
  AGGREGATOR_MIN_SENDERS: 3, // in_degree ≥ 3 → flagged aggregator (amber)
  AGGREGATOR_RED_SENDERS: 5, // in_degree ≥ 5 → high severity (red)

  // ── Feature 4 · ATM behavioral flags ───────────────────────────────────────
  // Rapid withdrawals: an account making ≥ N cash-exits inside a rolling window.
  RAPID_WITHDRAWAL_MIN_COUNT: 3,
  RAPID_WITHDRAWAL_WINDOW_MINUTES: 60,
  // Multi-ATM: an account withdrawing at ≥ N distinct ATMs within one IST day.
  MULTI_ATM_MIN_DISTINCT: 3,

  // ── Feature 5 · Suspicious POS merchant / terminal by high frequency ────────
  // ≥ N POS transactions at one terminal/MID inside a rolling window.
  SUSPICIOUS_MERCHANT_MIN_TXNS: 3,
  SUSPICIOUS_MERCHANT_WINDOW_MINUTES: 60,
});
