'use strict';

/**
 * FinTrace NCRP — shared directed money-flow graph builder.
 *
 * The "Money Transfer to" sheet is the only channel that records a real
 * account-to-account fund movement (a HOP): sender = `victim_account`
 * ("Account No./ (Wallet /PG/PA) Id"), receiver = `beneficiary_account`
 * ("Account No"). Every other channel (ATM / POS / AEPS / hold / other) folds
 * its single account into BOTH columns at parse time, so `beneficiary === victim`
 * — those are dispositions, not edges, and are excluded here by the
 * `source !== destination` guard (belt-and-braces with the `row_kind` check).
 *
 * This is the SINGLE definition of the trail's directed graph, reused by
 * {@link module:backend/src/analysis/cycleDetector} (circular flows) and
 * {@link module:backend/src/analysis/connectivity} (aggregator / in-degree
 * analysis) so the two never disagree about what an edge or a node is.
 *
 * Bank names on edges are taken from `beneficiary_bank`, which the parser has
 * already resolved IFSC-first (see lib/ifscBankResolver) — never the raw
 * "Action Taken By bank" text. Pure, synchronous, deterministic.
 *
 * @module backend/src/analysis/hopGraph
 */

/** Row-kind label for a real hop. Mirrors analyzer ROW_KIND.HOP without importing it. */
const ROW_KIND_HOP = 'HOP';

/** Edge-key separator — a char that cannot appear in an account number or VPA. */
const SEP = '|';

/** Deterministic edge key for a directed (src -> dst) pair. */
function edgeKey(src, dst) {
  return `${src}${SEP}${dst}`;
}

/** @param {unknown} v @returns {string|null} */
function str(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/** @param {unknown} v @returns {number} */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Coerce a layer cell to a non-negative integer (tolerates numeric strings). */
function layerOf(v) {
  if (Number.isInteger(v)) return v;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Build the directed hop graph from canonical transaction rows.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched + deduped rows
 *   (ideally carrying `row_kind`; when absent, the source != destination guard
 *   still isolates real hops because dispositions share one account on both sides).
 * @returns {{
 *   nodes: Set<string>,
 *   edges: Map<string, { source: string, destination: string, amount: number,
 *     txns: number, layers: Set<number>, banks: Set<string> }>,
 *   adjacency: Map<string, Set<string>>,
 *   getEdge: (src: string, dst: string) => object|null,
 *   edgeAmount: (src: string, dst: string) => number,
 * }} `adjacency[src]` is the set of direct successors of `src`.
 */
function buildHopGraph(txns) {
  /** @type {Map<string, any>} */
  const edges = new Map();
  /** @type {Set<string>} */
  const nodes = new Set();
  /** @type {Map<string, Set<string>>} */
  const adjacency = new Map();

  for (const t of (txns || [])) {
    // Honour the analyzer's authoritative classification when present.
    if (t.row_kind !== undefined && t.row_kind !== null && t.row_kind !== ROW_KIND_HOP) continue;
    const source = str(t.victim_account);
    const destination = str(t.beneficiary_account);
    if (!source || !destination || source === destination) continue;

    nodes.add(source);
    nodes.add(destination);

    const key = edgeKey(source, destination);
    let e = edges.get(key);
    if (!e) {
      e = { source, destination, amount: 0, txns: 0, layers: new Set(), banks: new Set() };
      edges.set(key, e);
    }
    e.amount += num(t.transaction_amount);
    e.txns += 1;
    e.layers.add(layerOf(t.layer_no));
    const bank = str(t.beneficiary_bank); // IFSC-resolved by the parser
    if (bank) e.banks.add(bank);

    if (!adjacency.has(source)) adjacency.set(source, new Set());
    adjacency.get(source).add(destination);
  }

  const getEdge = (src, dst) => edges.get(edgeKey(src, dst)) || null;
  const edgeAmount = (src, dst) => {
    const e = getEdge(src, dst);
    return e ? e.amount : 0;
  };

  return { nodes, edges, adjacency, getEdge, edgeAmount };
}

module.exports = {
  buildHopGraph,
  _internals: Object.freeze({ str, num, layerOf, edgeKey, ROW_KIND_HOP }),
};
