'use strict';

/**
 * cashoutPolicy.js — FinTrace NCRP
 * -----------------------------------------------------------------------------
 * Single, explicit definition of "confirmed cashed out" so the figure stops
 * drifting between FinTrace and the gold standard.
 *
 * THE DRIFT (case 32712250107145)
 *   FinTrace (old) ......... Rs 5,89,429.96
 *   CypherSOL / strict cap . Rs 5,73,865    (matches received-capped recompute)
 * The gap is entirely about accounts that withdrew MORE than the disputed
 * amount they received (cash-out ratio > 100%). Whether to count the excess is
 * a definition, not a bug — so make it a named, tested policy.
 *
 * RECOMMENDED DEFAULT: 'CAP_AT_RECEIVED'. Fraud proceeds cashed out cannot
 * exceed what the account received as disputed funds; the excess is the
 * account's own/clean money and should not inflate the laundered total. This is
 * what aligns FinTrace with the gold standard.
 *
 * Set policy to 'RAW' to keep the legacy behaviour (sum of ATM+POS disputed
 * with no cap) if you decide the higher figure is intended.
 */

const POLICIES = Object.freeze({
  CAP_AT_RECEIVED: 'CAP_AT_RECEIVED',
  RAW: 'RAW',
});

/**
 * @param {Map<string, number>} disputedReceivedByAccount  account -> Σ disputed inflow
 * @param {Map<string, number>} disputedCashedByAccount     account -> Σ ATM+POS disputed
 * @param {string} [policy='CAP_AT_RECEIVED']
 * @returns {{ total: number, perAccount: Map<string,{cashed:number, capped:number, exceeded:boolean}> }}
 */
function computeCashedOut(disputedReceivedByAccount, disputedCashedByAccount, policy = POLICIES.CAP_AT_RECEIVED) {
  let total = 0;
  const perAccount = new Map();
  for (const [acct, cashed] of disputedCashedByAccount.entries()) {
    const received = disputedReceivedByAccount.get(acct);
    let counted = cashed;
    let exceeded = false;
    if (policy === POLICIES.CAP_AT_RECEIVED && received != null) {
      counted = Math.min(cashed, received);
      exceeded = cashed > received + 0.005; // tolerance for paise rounding
    }
    total += counted;
    perAccount.set(acct, { cashed, capped: counted, exceeded });
  }
  return { total: round2(total), perAccount };
}

function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

module.exports = { computeCashedOut, POLICIES };
