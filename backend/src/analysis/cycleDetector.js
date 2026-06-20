'use strict';

/**
 * FinTrace NCRP — circular-flow (cycle) detection.
 *
 * Finds simple directed cycles up to a bounded length in the trail's money-flow
 * graph (see ./hopGraph). A cycle — money that returns to an account it already
 * passed through — is a strong layering signal: legitimate funds do not loop.
 *
 * DETERMINISM (same input file → byte-identical output, a hard project rule):
 *   • Nodes are sorted before traversal.
 *   • Each simple cycle is enumerated exactly once: a cycle is recorded only when
 *     the traversal's start node is the cycle's lexicographically-smallest member
 *     (intermediate hops are restricted to nodes strictly greater than the start),
 *     so rotations of the same loop can never be double-counted.
 *   • Successors are visited in sorted order; the final list is sorted by amount
 *     desc, then length asc, then path — a total order with no ties left to chance.
 *
 * For each cycle we report:
 *   • path[]   — the accounts in loop order, starting at the smallest (normalised).
 *   • length   — number of accounts (= number of edges) in the loop.
 *   • amount   — the MINIMUM edge amount around the loop: the most that could have
 *                actually circulated through the whole cycle (a loop can only carry
 *                as much as its thinnest leg).
 *   • txns     — total transactions across the loop's edges.
 *   • banks[]  — distinct IFSC-resolved banks on the loop's edges (Feature 5: the
 *                bank name is the parser's IFSC-first `beneficiary_bank`, never the
 *                raw "Action Taken By bank" text).
 *
 * Output is capped at the top {@link DEFAULT_CAP} cycles by amount. The true
 * number of simple cycles found (before the cap) is available via the
 * `{ withTotal: true }` option, so a capped display can honestly caption
 * "top N of M" instead of looking complete.
 *
 * @module backend/src/analysis/cycleDetector
 */

const { buildHopGraph } = require('./hopGraph');

/** Default maximum cycle length (accounts) to search for. */
const DEFAULT_MAX_LEN = 6;

/** Default cap on the number of cycles returned (top-N by amount). */
const DEFAULT_CAP = 10;

/** Round to 2 decimals without floating-point noise. */
function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Detect simple directed cycles (length 2..maxLen) in the hop graph.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} txns - Enriched + deduped rows.
 * @param {{ maxLen?: number, cap?: number, withTotal?: boolean }} [opts]
 * @returns {Array<{ path: string[], length: number, amount: number,
 *   txns: number, banks: string[] }> | { cycles: Array<object>, total: number }}
 *   By default the capped, sorted (amount desc, length asc, path asc) cycle list.
 *   With `{ withTotal: true }`, `{ cycles, total }` where `total` is the count of
 *   ALL simple cycles found before the cap (for an honest "top N of M" caption).
 */
function detectCycles(txns, opts = {}) {
  const maxLen = Number.isInteger(opts.maxLen) && opts.maxLen >= 2 ? opts.maxLen : DEFAULT_MAX_LEN;
  const cap = Number.isInteger(opts.cap) && opts.cap > 0 ? opts.cap : DEFAULT_CAP;

  const { edges, adjacency, getEdge } = buildHopGraph(txns);
  if (adjacency.size === 0) return [];

  // Sorted successor lists, computed once, for deterministic traversal.
  /** @type {Map<string, string[]>} */
  const succ = new Map();
  for (const [node, set] of adjacency) succ.set(node, [...set].sort());

  const startNodes = [...adjacency.keys()].sort();
  /** @type {Array<string[]>} */
  const rawCycles = [];

  // Bounded DFS. `start` is fixed as the smallest node of any cycle it records;
  // intermediate nodes are restricted to those strictly greater than `start`, so
  // every simple cycle is found exactly once (at its minimum member).
  const dfs = (start, current, path, onPath) => {
    const neighbours = succ.get(current);
    if (!neighbours) return;
    for (const next of neighbours) {
      if (next === start) {
        if (path.length >= 2 && path.length <= maxLen) rawCycles.push([...path]);
        continue;
      }
      if (next < start) continue;          // smaller nodes own their own cycles
      if (onPath.has(next)) continue;       // keep the cycle simple (no repeats)
      if (path.length >= maxLen) continue;  // length bound
      onPath.add(next);
      path.push(next);
      dfs(start, next, path, onPath);
      path.pop();
      onPath.delete(next);
    }
  };

  for (const start of startNodes) {
    dfs(start, start, [start], new Set([start]));
  }

  // Enrich each normalised path with amount / txns / banks from the edge set.
  const enriched = rawCycles.map((path) => {
    let minAmount = Infinity;
    let txns = 0;
    const banks = new Set();
    for (let i = 0; i < path.length; i++) {
      const e = getEdge(path[i], path[(i + 1) % path.length]);
      if (!e) { minAmount = 0; continue; }
      if (e.amount < minAmount) minAmount = e.amount;
      txns += e.txns;
      for (const b of e.banks) banks.add(b);
    }
    return {
      path,
      length: path.length,
      amount: round2(minAmount === Infinity ? 0 : minAmount),
      txns,
      banks: [...banks].sort(),
    };
  });

  enriched.sort((a, b) =>
    (b.amount - a.amount) ||
    (a.length - b.length) ||
    a.path.join('>').localeCompare(b.path.join('>')));

  const top = enriched.slice(0, cap);
  // The capped list is the historical return value (PDF/Excel/tests rely on it).
  // `withTotal` additionally surfaces the pre-cap count so a top-10 table can be
  // captioned truthfully — no second traversal, just the length already in hand.
  return opts.withTotal ? { cycles: top, total: enriched.length } : top;
}

module.exports = { detectCycles, DEFAULT_MAX_LEN, DEFAULT_CAP };
