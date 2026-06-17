'use strict';

/**
 * STEP 1 — read-only audit of the disputed-total reconciliation for case
 * 32709250080512 (BankAction_CompleteTrail.xlsx). Prints findings only; changes
 * nothing. See the reconciliation question for the contract.
 */

const path = require('path');
const { parseNcrpFile } = require('../src/parsers/ncrpParser');
const { _internals } = require('../src/analyzers/analyzer');

const { enrichTransactions, dedupeRows, ROW_KIND } = _internals;

const SRC = path.join(__dirname, '..', '..', 'BankAction_CompleteTrail.xlsx');
const str = (v) => (v === undefined || v === null ? '' : String(v).trim());
const num = (v) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const r2 = (n) => Math.round(n * 100) / 100;

// Re-derive the EXACT dedup key the engine uses (analyzer.js dedupeRows).
function dedupKey(r) {
  const utr = str(r.utr_no);
  if (!utr) return null;
  return `${str(r.beneficiary_account) || ''}|${str(r.transaction_date) || ''}|${num(r.transaction_amount)}|${utr}`;
}

function leg(r) {
  return {
    sheet: r.sheet || r.source_sheet || r.channel || '?',
    src: str(r.victim_account) || str(r.account) || str(r.sender_account) || '',
    dst: str(r.beneficiary_account),
    utr: str(r.utr_no),
    layer: r.layer_no,
    kind: r.row_kind,
    txn: num(r.transaction_amount),
    disp: num(r.disputed_amount),
  };
}

const parsed = parseNcrpFile(SRC);
console.log('=== PARSE ===');
console.log('errors:', JSON.stringify(parsed.errors));
console.log('raw rows:', parsed.rows.length);

// Show which fields a Money-Transfer row actually carries (field discovery).
const sampleMT = parsed.rows.find((r) => /money transfer/i.test(str(r.sheet || r.source_sheet || r.channel)));
console.log('\nsample MT row keys:', sampleMT ? Object.keys(sampleMT).join(', ') : '(none found via sheet field)');

const enriched = enrichTransactions(parsed.rows.map((r, i) => ({ id: i + 1, ...r })));

// ── 1. Which legs does dedup remove? ──────────────────────────────────────
const seen = new Set();
const removed = [];
for (const r of enriched) {
  const k = dedupKey(r);
  if (k === null) continue;
  if (seen.has(k)) { removed.push({ ...leg(r), key: k }); continue; }
  seen.add(k);
}
console.log('\n=== 1. DEDUP-REMOVED LEGS ===');
console.log('count removed:', removed.length);
for (const x of removed) console.log(JSON.stringify(x));

// ── 2. Track the two named legs ────────────────────────────────────────────
console.log('\n=== 2. NAMED LEGS ===');
const utr500 = enriched.filter((r) => str(r.utr_no) === '292427997327');
console.log(`UTR 292427997327 (the genuine ₹500 duplicate) appears ${utr500.length}x:`);
for (const r of utr500) console.log('  ', JSON.stringify({ ...leg(r), key: dedupKey(r) }));

const leg409 = enriched.filter((r) => Math.abs(num(r.disputed_amount) - 409.56) < 0.005);
console.log(`\nLeg(s) with disputed == 409.56 (${leg409.length}):`);
for (const r of leg409) console.log('  ', JSON.stringify({ ...leg(r), key: dedupKey(r) }));

const removedUtrs = new Set(removed.map((x) => x.utr));
console.log('\nIs the ₹500 (UTR 292427997327) leg the one being removed?',
  removedUtrs.has('292427997327'));
console.log('Is a 409.56-disputed leg the one being removed?',
  removed.some((x) => Math.abs(x.disp - 409.56) < 0.005));

// ── 3. Cross-sheet collision check ─────────────────────────────────────────
console.log('\n=== 3. CROSS-SHEET COLLISIONS ===');
// For each HOP leg, does the same (beneficiary,date,amount,utr) appear on a
// NON-transfer sheet (hold / other / others<500)?
const bySheet = {};
for (const r of enriched) {
  const s = str(r.sheet || r.source_sheet || r.channel) || '(unknown)';
  (bySheet[s] = bySheet[s] || []).push(r);
}
console.log('rows per sheet:', Object.fromEntries(Object.entries(bySheet).map(([k, v]) => [k, v.length])));

// collisions on the dedup key across different sheets
const keyToSheets = new Map();
for (const r of enriched) {
  const k = dedupKey(r);
  if (k === null) continue;
  const s = str(r.sheet || r.source_sheet || r.channel) || '(unknown)';
  if (!keyToSheets.has(k)) keyToSheets.set(k, []);
  keyToSheets.get(k).push({ sheet: s, kind: r.row_kind, disp: num(r.disputed_amount) });
}
const crossSheet = [...keyToSheets.entries()].filter(([, arr]) => new Set(arr.map((a) => a.sheet)).size > 1);
console.log('keys spanning >1 sheet:', crossSheet.length);
for (const [k, arr] of crossSheet) console.log('  ', k, '->', JSON.stringify(arr));

// Specifically: does the 409.56 leg collide cross-sheet?
for (const r of leg409) {
  const k = dedupKey(r);
  console.log(`\n409.56 leg key: ${k}`);
  console.log('  occurrences:', JSON.stringify((keyToSheets.get(k) || [])));
}

// ── 4. Headline decomposition ──────────────────────────────────────────────
console.log('\n=== 4. HEADLINE DECOMPOSITION ===');
const deduped = dedupeRows(enriched);
const rows = deduped.rows;
const sumBy = (arr, pred) => r2(arr.filter(pred).reduce((a, t) => a + num(t.disputed_amount), 0));

const rawHop = sumBy(enriched, (t) => t.row_kind === ROW_KIND.HOP);
const netHop = sumBy(rows, (t) => t.row_kind === ROW_KIND.HOP);
const exit = sumBy(rows, (t) => t.row_kind === ROW_KIND.EXIT);
const hold = sumBy(rows, (t) => t.row_kind === ROW_KIND.HOLD);
const other = sumBy(rows, (t) => t.row_kind === ROW_KIND.OTHER);
const allMTdisp = r2(enriched
  .filter((t) => /money transfer/i.test(str(t.sheet || t.source_sheet || t.channel)))
  .reduce((a, t) => a + num(t.disputed_amount), 0));

console.log('raw_hop (HOP, incl dup):      ', rawHop);
console.log('net_hop (HOP, deduped):       ', netHop);
console.log('dedup_hop_adjustment:         ', r2(rawHop - netHop));
console.log('exit:                         ', exit);
console.log('hold:                         ', hold);
console.log('other:                        ', other);
console.log('headline = netHop+exit+hold+other:', r2(netHop + exit + hold + other));
console.log('rawHop + other (= all MT disp?):  ', r2(rawHop + other), 'vs sum of Money-Transfer Disputed col:', allMTdisp);
console.log('legs removed total disputed:  ', r2(deduped.removed ? rawHop - netHop : 0), '(removed count:', deduped.removed + ')');

// ── 5. Full identity of the 409.56 collision pair ──────────────────────────
console.log('\n=== 5. THE 409.56 COLLISION PAIR (current key) ===');
const collKey = '702902010004986|2025-09-28T18:32:20.000Z|1400|563707902816';
for (const r of enriched) {
  if (dedupKey(r) === collKey) console.log(JSON.stringify(leg(r)));
}

// ── 6. Simulate the PROPOSED key (UTR + src + dst + amount) ─────────────────
console.log('\n=== 6. PROPOSED KEY (utr|src|dst|amount) — simulation ===');
function proposedKey(r) {
  const utr = str(r.utr_no);
  if (!utr) return null;
  const src = str(r.victim_account) || str(r.account) || str(r.sender_account) || '';
  return `${utr}|${src}|${str(r.beneficiary_account)}|${num(r.transaction_amount)}`;
}
const seen2 = new Set();
const removed2 = [];
for (const r of enriched) {
  const k = proposedKey(r);
  if (k === null) continue;
  if (seen2.has(k)) { removed2.push({ ...leg(r), key: k }); continue; }
  seen2.add(k);
}
console.log('proposed-key removed count:', removed2.length);
for (const x of removed2) console.log('  ', JSON.stringify(x));

const keep2 = new Set();
const rows2 = [];
for (const r of enriched) {
  const k = proposedKey(r);
  if (k !== null) { if (keep2.has(k)) continue; keep2.add(k); }
  rows2.push(r);
}
const netHop2 = sumBy(rows2, (t) => t.row_kind === ROW_KIND.HOP);
const other2 = sumBy(rows2, (t) => t.row_kind === ROW_KIND.OTHER);
const exit2 = sumBy(rows2, (t) => t.row_kind === ROW_KIND.EXIT);
const hold2 = sumBy(rows2, (t) => t.row_kind === ROW_KIND.HOLD);
console.log('proposed net_hop:', netHop2, ' other:', other2, ' exit:', exit2, ' hold:', hold2);
console.log('proposed headline:', r2(netHop2 + other2 + exit2 + hold2));
console.log('409.56 leg present after proposed dedup?',
  rows2.some((t) => Math.abs(num(t.disputed_amount) - 409.56) < 0.005));
console.log('18.64 leg present after proposed dedup?',
  rows2.some((t) => Math.abs(num(t.disputed_amount) - 18.64) < 0.005));
console.log('₹500/UTR292427997327 legs present after proposed dedup:',
  rows2.filter((t) => str(t.utr_no) === '292427997327' && num(t.transaction_amount) === 500).length,
  '(was 2)');

// ── 7. CORRECTED key (src|dst|utr|amount|disputed) — identical-row collapse ──
console.log('\n=== 7. CORRECTED KEY (src|dst|utr|amount|disputed) ===');
function correctedKey(r) {
  const utr = str(r.utr_no);
  if (!utr) return null;
  const src = str(r.victim_account) || str(r.account) || str(r.sender_account) || '';
  return `${src}|${str(r.beneficiary_account)}|${utr}|${num(r.transaction_amount)}|${num(r.disputed_amount)}`;
}
const keep3 = new Set();
const rows3 = [];
const removed3 = [];
for (const r of enriched) {
  const k = correctedKey(r);
  if (k !== null) { if (keep3.has(k)) { removed3.push(leg(r)); continue; } keep3.add(k); }
  rows3.push(r);
}
console.log('corrected-key removed count:', removed3.length);
for (const x of removed3) console.log('  ', JSON.stringify(x));
const netHop3 = sumBy(rows3, (t) => t.row_kind === ROW_KIND.HOP);
const other3 = sumBy(rows3, (t) => t.row_kind === ROW_KIND.OTHER);
const exit3 = sumBy(rows3, (t) => t.row_kind === ROW_KIND.EXIT);
const hold3 = sumBy(rows3, (t) => t.row_kind === ROW_KIND.HOLD);
console.log('corrected net_hop:', netHop3, ' other:', other3);
console.log('CORRECTED headline:', r2(netHop3 + other3 + exit3 + hold3));
console.log('409.56 leg present?', rows3.some((t) => Math.abs(num(t.disputed_amount) - 409.56) < 0.005));
console.log('18.64 leg present?', rows3.some((t) => Math.abs(num(t.disputed_amount) - 18.64) < 0.005));
console.log('₹500/UTR292427997327 legs present:',
  rows3.filter((t) => str(t.utr_no) === '292427997327' && num(t.transaction_amount) === 500).length, '(was 2)');
