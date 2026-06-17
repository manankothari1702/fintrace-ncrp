'use strict';

/**
 * FinTrace NCRP — account connectivity / aggregator (in-degree) analysis.
 *
 * Over the shared directed hop graph (see ./hopGraph), computes per account:
 *   • in_degree  — distinct senders that paid INTO the account (fan-in).
 *   • out_degree — distinct receivers the account paid OUT to (fan-out).
 *   • total_in   — Σ amount received over its inbound edges.
 *   • total_out  — Σ amount sent over its outbound edges.
 *
 * Accounts with in_degree >= 2 are flagged COLLECTORS — many senders funnelling
 * into one account is the classic mule-collector signal. Collectors are ranked by
 * in-degree, tie-broken by total_in desc, then account number (fully deterministic).
 *
 * Bank names come from the graph's IFSC-resolved edge banks (Feature 5), never the
 * raw "Action Taken By bank" text.
 *
 * @module backend/src/analysis/connectivity
 */

const { buildHopGraph } = require('./hopGraph');

/** Default cap on collectors returned (top-N by in-degree). */
const DEFAULT_CAP = 25;

/** Threshold at/above which an account is a collector. */
const COLLECTOR_MIN_IN_DEGREE = 2;

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Compute per-account connectivity and the collector ranking.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched + deduped rows.
 * @param {{ cap?: number }} [opts]
 * @returns {{
 *   accounts: Array<{ account_no: string, bank: string|null, in_degree: number,
 *     out_degree: number, total_in: number, total_out: number, is_collector: boolean }>,
 *   collectors: Array<object>,
 *   in_degree_by_account: Map<string, number>,
 * }} `accounts` is every node, sorted by in-degree desc; `collectors` is the
 *   in-degree>=2 subset, capped.
 */
function analyzeConnectivity(txns, opts = {}) {
  const cap = Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : DEFAULT_CAP;
  const { nodes, edges } = buildHopGraph(txns);

  /** @type {Map<string, Set<string>>} */
  const senders = new Map();   // node -> distinct senders into it
  /** @type {Map<string, Set<string>>} */
  const receivers = new Map(); // node -> distinct receivers it paid
  /** @type {Map<string, number>} */
  const totalIn = new Map();
  /** @type {Map<string, number>} */
  const totalOut = new Map();
  /** @type {Map<string, Set<string>>} */
  const banks = new Map();      // node -> IFSC-resolved bank(s) it received under

  for (const e of edges.values()) {
    if (!receivers.has(e.source)) receivers.set(e.source, new Set());
    receivers.get(e.source).add(e.destination);
    if (!senders.has(e.destination)) senders.set(e.destination, new Set());
    senders.get(e.destination).add(e.source);
    totalOut.set(e.source, (totalOut.get(e.source) || 0) + e.amount);
    totalIn.set(e.destination, (totalIn.get(e.destination) || 0) + e.amount);
    if (!banks.has(e.destination)) banks.set(e.destination, new Set());
    for (const b of e.banks) banks.get(e.destination).add(b);
  }

  const accounts = [...nodes].map((acc) => {
    const inDeg = (senders.get(acc) || EMPTY).size;
    const outDeg = (receivers.get(acc) || EMPTY).size;
    const bankSet = banks.get(acc);
    return {
      account_no: acc,
      bank: bankSet && bankSet.size ? [...bankSet].sort().join('; ') : null,
      in_degree: inDeg,
      out_degree: outDeg,
      total_in: round2(totalIn.get(acc) || 0),
      total_out: round2(totalOut.get(acc) || 0),
      is_collector: inDeg >= COLLECTOR_MIN_IN_DEGREE,
    };
  });

  // Deterministic ordering: in-degree desc, total_in desc, account asc.
  const byRank = (a, b) =>
    (b.in_degree - a.in_degree) ||
    (b.total_in - a.total_in) ||
    String(a.account_no).localeCompare(String(b.account_no));

  accounts.sort(byRank);
  const collectors = accounts.filter((a) => a.is_collector).slice(0, cap);

  const inDegreeByAccount = new Map(accounts.map((a) => [a.account_no, a.in_degree]));

  return { accounts, collectors, in_degree_by_account: inDegreeByAccount };
}

const EMPTY = new Set();

module.exports = { analyzeConnectivity, COLLECTOR_MIN_IN_DEGREE, DEFAULT_CAP };
