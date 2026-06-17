'use strict';

/**
 * Unit tests for lib/cashoutPolicy.js — the single, named definition of
 * "confirmed cashed out" (FinTrace v0.2.0). Locks the per-account cap so the
 * headline figure cannot silently drift again.
 */

const { computeCashedOut, POLICIES } = require('../lib/cashoutPolicy');

describe('cashoutPolicy.computeCashedOut', () => {
  test('CAP_AT_RECEIVED caps each account at its disputed inflow', () => {
    const received = new Map([['A', 50000], ['B', 100000]]);
    const cashed = new Map([['A', 80000], ['B', 90000]]); // A withdrew MORE than received
    const r = computeCashedOut(received, cashed, POLICIES.CAP_AT_RECEIVED);
    expect(r.total).toBe(50000 + 90000);          // A capped to 50k, B unchanged
    expect(r.perAccount.get('A')).toEqual({ cashed: 80000, capped: 50000, exceeded: true });
    expect(r.perAccount.get('B')).toEqual({ cashed: 90000, capped: 90000, exceeded: false });
  });

  test('RAW sums withdrawals with no cap (legacy behaviour)', () => {
    const received = new Map([['A', 50000]]);
    const cashed = new Map([['A', 80000]]);
    const r = computeCashedOut(received, cashed, POLICIES.RAW);
    expect(r.total).toBe(80000);
    expect(r.perAccount.get('A').exceeded).toBe(false);
  });

  test('an account with no recorded inflow is not capped (received unknown)', () => {
    const received = new Map();                    // nothing received
    const cashed = new Map([['A', 30000]]);
    const r = computeCashedOut(received, cashed, POLICIES.CAP_AT_RECEIVED);
    expect(r.total).toBe(30000);                   // can't cap what we never saw received
  });

  test('paise rounding does not falsely mark an account as exceeded', () => {
    const received = new Map([['A', 10000]]);
    const cashed = new Map([['A', 10000.004]]);    // within the 0.005 tolerance
    const r = computeCashedOut(received, cashed, POLICIES.CAP_AT_RECEIVED);
    expect(r.perAccount.get('A').exceeded).toBe(false);
  });
});
