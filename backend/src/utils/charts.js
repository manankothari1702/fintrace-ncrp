'use strict';

/**
 * FinTrace NCRP — deterministic chart rasteriser for the PDF dossier.
 *
 * The dossier is the artefact an SP / court judges the investigation on, so the
 * visual section must print reliably on any machine. We therefore build each
 * chart as a hand-rolled SVG string (no charting lib — the layout maths is
 * explicit and reproducible) and rasterise it to a PNG with @resvg/resvg-js
 * before embedding. PNGs print identically across viewers/printers where raw
 * SVG support is patchy; resvg renders the same SVG byte-for-byte every time,
 * so the same case always yields the same charts (reproducible proof pack).
 *
 * Three charts are produced:
 *   1. Money-flow network — node-link graph laid out hierarchically by layer
 *      (victim → layer 1 → … → exit), edge width ∝ transferred amount, nodes
 *      coloured by role (victim / mule / exit).
 *   2. Layer breakdown — bar of total amount per layer (how money fans out).
 *   3. Daily volume timeline — daily transaction volume, with same-day cash-out
 *      clusters highlighted.
 *
 * Every builder is a pure function of the analysis bundle (+ raw ledger for the
 * cash-out overlay): no Date.now / Math.random, no I/O. If the rasteriser is
 * unavailable (e.g. the native binary failed to load on an exotic platform),
 * {@link renderCharts} degrades to nulls and the PDF falls back to tables only.
 *
 * @module backend/src/utils/charts
 */

// Lazy/guarded load: a missing native binary must never break PDF generation.
let Resvg = null;
let resvgLoadError = null;
try {
  ({ Resvg } = require('@resvg/resvg-js'));
} catch (err) {
  resvgLoadError = err;
}

// IST day bucketing reused from the analyzer so the cash-out overlay lines up
// exactly with the analyzer's `timeline` day keys.
let istDayKey = null;
try {
  istDayKey = require('../analyzers/analyzer')._internals.istDayKey;
} catch (_e) { /* overlay simply stays empty if unavailable */ }

// ─── Palette (matches pdfGenerator) ──────────────────────────────────
const NAVY = '#1f3a5f';
const INK = '#222222';
const MUTED = '#6b7785';
const GRID = '#d7dee8';
const EDGE = '#9fb0c3';
// Role colours — distinct, colour-blind-tolerant, and printable.
const ROLE = Object.freeze({
  victim: '#b00020', // red    — money enters here (the loss)
  mule: '#b26a00',   // amber  — intermediary / layering account
  exit: '#2e7d32',   // green  — leaf node, money leaves the chain (cash-out)
});

// ─── Small numeric / string helpers ──────────────────────────────────

/** @param {unknown} v */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Escape the five XML predefined entities for safe SVG text. @param {unknown} v */
function xml(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Last-4 masked account for compact node labels. @param {unknown} acc */
function mask4(acc) {
  const s = String(acc ?? '').trim();
  if (s.length <= 4) return s || '?';
  return `…${s.slice(-4)}`;
}

/**
 * Canonical account identity for node de-duplication. Some source/destination
 * values carry a payment-channel prefix (e.g. "PhonePe -:661910110017777")
 * while the same account also appears bare ("661910110017777"); both denote one
 * account, so the network graph must collapse them to a single node. The account
 * identifier is the segment after the last colon, trimmed. Purely cosmetic — the
 * analyzer's own figures are untouched; this only governs how nodes are drawn.
 * @param {unknown} acc
 */
function canonicalAcct(acc) {
  const s = String(acc ?? '').trim();
  const i = s.lastIndexOf(':');
  const tail = i >= 0 ? s.slice(i + 1).trim() : s;
  return tail || s;
}

/**
 * Compact rupee label for chart annotations (Indian Cr/L/K scale).
 * @param {unknown} value
 * @returns {string}
 */
function compactMoney(value) {
  const v = num(value);
  const a = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (a >= 1e7) return `${sign}Rs.${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}Rs.${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${sign}Rs.${(a / 1e3).toFixed(1)}K`;
  return `${sign}Rs.${Math.round(a)}`;
}

/** Linear map of `v` in [d0,d1] to [r0,r1], clamped, guarding a zero domain. */
function scale(v, d0, d1, r0, r1) {
  if (d1 === d0) return (r0 + r1) / 2;
  const t = Math.max(0, Math.min(1, (v - d0) / (d1 - d0)));
  return r0 + t * (r1 - r0);
}

/** Round to 2dp for stable SVG coordinate strings (keeps output deterministic). */
function r2(n) {
  return Math.round(n * 100) / 100;
}

// ─── SVG scaffolding ─────────────────────────────────────────────────

/**
 * Wrap body markup in an `<svg>` root with a white background and the chart
 * title. All charts share the same header band for a consistent look.
 *
 * @param {{ w: number, h: number, title: string, subtitle?: string, body: string }} o
 * @returns {string}
 */
function svgDoc({ w, h, title, subtitle, body }) {
  const fam = 'Arial, Helvetica, sans-serif';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" `
    + `viewBox="0 0 ${w} ${h}" font-family="${fam}">`
    + `<rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>`
    + `<text x="24" y="34" font-size="22" font-weight="bold" fill="${NAVY}">${xml(title)}</text>`
    + (subtitle
      ? `<text x="24" y="56" font-size="14" fill="${MUTED}">${xml(subtitle)}</text>`
      : '')
    + body
    + '</svg>';
}

/** A coloured legend swatch + label at (x,y). */
function legendItem(x, y, color, label) {
  return `<rect x="${r2(x)}" y="${r2(y - 11)}" width="14" height="14" rx="3" fill="${color}"/>`
    + `<text x="${r2(x + 20)}" y="${r2(y)}" font-size="13" fill="${INK}">${xml(label)}</text>`;
}

// ─── Chart 1 — money-flow network ────────────────────────────────────

/**
 * Hierarchical node-link diagram of the fund trail from the analyzer's
 * `money_flow_network.top_edges` (the heaviest account→account transfers).
 *
 * Layout: one column per layer (victim sources on the left, cash-out leaves on
 * the right). Edge stroke width is proportional to the transferred amount and
 * each edge is labelled with a compact rupee figure; nodes are coloured by role
 * — victim (in-degree 0), exit (out-degree 0), or mule (both).
 *
 * @param {{ top_edges?: Array<Record<string, unknown>> }} network
 * @returns {string|null} SVG markup, or null when there are no edges to draw.
 */
function buildNetworkSvg(network) {
  const edges = (network && Array.isArray(network.top_edges) ? network.top_edges : [])
    .filter((e) => e && e.source != null && e.destination != null);
  if (edges.length === 0) return null;

  const parseLayer = (s) => {
    const n = parseInt(String(s ?? '').split(',')[0], 10);
    return Number.isFinite(n) ? n : 1;
  };

  const destCol = new Map();
  const srcCol = new Map();
  const inDeg = new Map();
  const outDeg = new Map();
  const through = new Map();
  let maxAmt = 0;
  for (const e of edges) {
    const L = parseLayer(e.layers);
    const a = num(e.amount);
    if (a > maxAmt) maxAmt = a;
    const s = canonicalAcct(e.source);
    const d = canonicalAcct(e.destination);
    destCol.set(d, Math.min(destCol.has(d) ? destCol.get(d) : Infinity, L));
    srcCol.set(s, Math.min(srcCol.has(s) ? srcCol.get(s) : Infinity, Math.max(0, L - 1)));
    inDeg.set(d, (inDeg.get(d) || 0) + 1);
    outDeg.set(s, (outDeg.get(s) || 0) + 1);
    through.set(s, (through.get(s) || 0) + a);
    through.set(d, (through.get(d) || 0) + a);
  }

  const ids = [...new Set(edges.flatMap((e) => [canonicalAcct(e.source), canonicalAcct(e.destination)]))];
  const colOf = (id) => (destCol.has(id) ? destCol.get(id) : (srcCol.has(id) ? srcCol.get(id) : 0));
  const maxThrough = Math.max(1, ...ids.map((id) => through.get(id) || 0));

  // Remap raw layer numbers to contiguous column indices for even spacing.
  const cols = [...new Set(ids.map(colOf))].sort((a, b) => a - b);
  const originCol = cols[0];
  // Role by position + degree: leaves (no onward transfer) are cash-out exits;
  // origin-column accounts that still forward are the victims funding the trail;
  // everything in between is a layering mule.
  const roleOf = (id) => {
    if ((outDeg.get(id) || 0) === 0) return 'exit';
    if (colOf(id) === originCol) return 'victim';
    return 'mule';
  };
  const colIndex = new Map(cols.map((c, i) => [c, i]));

  // Canvas geometry.
  const W = 960;
  const padL = 70;
  const padR = 70;
  const top = 84;
  const legendH = 56;
  // Height grows with the busiest column so dense layers don't overlap.
  const perCol = new Map();
  for (const id of ids) {
    const c = colOf(id);
    perCol.set(c, (perCol.get(c) || 0) + 1);
  }
  const maxPerCol = Math.max(1, ...perCol.values());
  const rowGap = 62;
  const plotH = Math.max(360, maxPerCol * rowGap + 40);
  const H = top + plotH + legendH;
  const span = cols.length > 1 ? (W - padL - padR) / (cols.length - 1) : 0;
  const colX = (c) => (cols.length > 1 ? padL + colIndex.get(c) * span : W / 2);

  // Position every node: spread vertically within its column, heaviest first.
  const byCol = new Map();
  for (const id of ids) {
    const c = colOf(id);
    if (!byCol.has(c)) byCol.set(c, []);
    byCol.get(c).push(id);
  }
  const pos = new Map();
  for (const [c, list] of byCol) {
    list.sort((a, b) => (through.get(b) || 0) - (through.get(a) || 0));
    const n = list.length;
    for (let i = 0; i < n; i++) {
      const y = top + (plotH * (i + 1)) / (n + 1);
      const radius = scale(through.get(list[i]) || 0, 0, maxThrough, 12, 24);
      pos.set(list[i], { x: colX(c), y, r: radius, role: roleOf(list[i]) });
    }
  }

  // Column headers describe the hop by its analyzer layer number (col index ==
  // layer number: a layer-L edge's destination sits in column L). The origin
  // column carries the Layer-0 victim/source accounts, so it is named by its
  // layer with the role as a parenthetical — the header states the hop, the
  // legend states the colour/role.
  let headers = '';
  for (const c of cols) {
    headers += `<text x="${r2(colX(c))}" y="${top - 18}" font-size="13" font-weight="bold" `
      + `text-anchor="middle" fill="${MUTED}">${xml(`Layer ${c}`)}</text>`;
    if (c === originCol) {
      headers += `<text x="${r2(colX(c))}" y="${top - 4}" font-size="11" `
        + `text-anchor="middle" fill="${MUTED}">(Victim)</text>`;
    }
  }

  // Non-contiguous layers: the top-10 edge set can skip whole hops (e.g. L3/L4
  // carry no top edge), so adjacent columns may jump in layer number. Mark each
  // such jump with a "···" between the columns and name the omitted layers, so
  // the axis is not misread as proof those layers are empty.
  let gapMarkup = '';
  let hasGap = false;
  for (let i = 0; i < cols.length - 1; i++) {
    const lo = cols[i] + 1;
    const hi = cols[i + 1] - 1;
    if (hi < lo) continue;
    hasGap = true;
    const gx = r2((colX(cols[i]) + colX(cols[i + 1])) / 2);
    const gy = r2(top + plotH * 0.42);
    const range = lo === hi ? `L${lo}` : `L${lo}–L${hi}`;
    gapMarkup += `<text x="${gx}" y="${gy}" font-size="24" font-weight="bold" `
      + `text-anchor="middle" fill="${MUTED}">···</text>`;
    gapMarkup += `<text x="${gx}" y="${r2(gy + 20)}" font-size="11" `
      + `text-anchor="middle" fill="${MUTED}">${xml(range)} omitted</text>`;
  }

  // Edges first (under nodes). Cubic bezier with a horizontal tangent.
  let edgeMarkup = '';
  let edgeLabels = '';
  for (const e of edges) {
    const s = pos.get(canonicalAcct(e.source));
    const d = pos.get(canonicalAcct(e.destination));
    if (!s || !d) continue;
    const x1 = s.x + s.r;
    const x2 = d.x - d.r;
    const mx = (x1 + x2) / 2;
    const sw = r2(scale(num(e.amount), 0, maxAmt, 1.4, 9));
    edgeMarkup += `<path d="M${r2(x1)},${r2(s.y)} C${r2(mx)},${r2(s.y)} ${r2(mx)},${r2(d.y)} `
      + `${r2(x2)},${r2(d.y)}" fill="none" stroke="${EDGE}" stroke-width="${sw}" `
      + `stroke-opacity="0.7" marker-end="url(#arrow)"/>`;
    const ly = r2((s.y + d.y) / 2 - 4);
    edgeLabels += `<text x="${r2(mx)}" y="${ly}" font-size="11" text-anchor="middle" `
      + `fill="${INK}">${xml(compactMoney(e.amount))}</text>`;
  }

  // Nodes + labels.
  let nodeMarkup = '';
  for (const [id, p] of pos) {
    nodeMarkup += `<circle cx="${r2(p.x)}" cy="${r2(p.y)}" r="${r2(p.r)}" fill="${ROLE[p.role]}" `
      + `stroke="#ffffff" stroke-width="2"/>`;
    nodeMarkup += `<text x="${r2(p.x)}" y="${r2(p.y + p.r + 15)}" font-size="11" `
      + `text-anchor="middle" fill="${INK}">${xml(mask4(id))}</text>`;
  }

  const legendY = H - 20;
  const legend = legendItem(padL, legendY, ROLE.victim, 'Victim (funds enter)')
    + legendItem(padL + 230, legendY, ROLE.mule, 'Mule / layering')
    + legendItem(padL + 430, legendY, ROLE.exit, 'Exit / cash-out');

  // markerUnits=userSpaceOnUse keeps the arrowhead a fixed size regardless of
  // the (amount-scaled) edge stroke width.
  const defs = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" `
    + `markerUnits="userSpaceOnUse" markerWidth="11" markerHeight="11" orient="auto-start-reverse">`
    + `<path d="M0,0 L10,5 L0,10 z" fill="${EDGE}"/></marker></defs>`;

  const subtitle = `Heaviest ${edges.length} transfers by amount — layers shown are those with top-10 edges`
    + (hasGap ? '; non-adjacent layers indicated by ···' : '');

  return svgDoc({
    w: W,
    h: H,
    title: 'Money-Flow Network',
    subtitle,
    body: defs + headers + edgeMarkup + nodeMarkup + edgeLabels + gapMarkup + legend,
  });
}

// ─── Chart 2 — layer breakdown bars ──────────────────────────────────

/**
 * Vertical bar chart of total amount moved per layer, showing how funds fan out
 * outward from the victim across the (up to 7) layers.
 *
 * @param {Array<Record<string, unknown>>} layers - analyzer `layer_analysis`.
 * @returns {string|null}
 */
function buildLayerSvg(layers) {
  const rows = (Array.isArray(layers) ? layers : [])
    .filter((l) => l && l.layer_no != null)
    .sort((a, b) => num(a.layer_no) - num(b.layer_no));
  if (rows.length === 0) return null;

  const W = 960;
  const H = 470;
  const padL = 96;
  const padR = 40;
  const top = 90;
  const baseY = H - 70;
  const plotW = W - padL - padR;
  const plotH = baseY - top;
  const maxAmt = Math.max(1, ...rows.map((l) => num(l.total_amount)));

  // Y grid (4 lines).
  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const y = r2(baseY - (plotH * i) / 4);
    const val = (maxAmt * i) / 4;
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`;
    grid += `<text x="${padL - 10}" y="${y + 4}" font-size="11" text-anchor="end" fill="${MUTED}">`
      + `${xml(compactMoney(val))}</text>`;
  }

  const slot = plotW / rows.length;
  const barW = Math.min(72, slot * 0.6);
  let bars = '';
  for (let i = 0; i < rows.length; i++) {
    const l = rows[i];
    const cx = padL + slot * (i + 0.5);
    const h = r2(scale(num(l.total_amount), 0, maxAmt, 0, plotH));
    const x = r2(cx - barW / 2);
    const y = r2(baseY - h);
    bars += `<rect x="${x}" y="${y}" width="${r2(barW)}" height="${h}" fill="${NAVY}" rx="3"/>`;
    // Value above the bar.
    bars += `<text x="${r2(cx)}" y="${r2(y - 7)}" font-size="12" font-weight="bold" `
      + `text-anchor="middle" fill="${INK}">${xml(compactMoney(l.total_amount))}</text>`;
    // Axis label: layer + account count.
    bars += `<text x="${r2(cx)}" y="${baseY + 20}" font-size="13" font-weight="bold" `
      + `text-anchor="middle" fill="${INK}">L${xml(l.layer_no)}</text>`;
    bars += `<text x="${r2(cx)}" y="${baseY + 38}" font-size="11" text-anchor="middle" `
      + `fill="${MUTED}">${xml(num(l.account_count))} a/c</text>`;
  }

  return svgDoc({
    w: W,
    h: H,
    title: 'Layer Breakdown — Amount per Layer',
    subtitle: 'Total amount moved at each hop from the victim (Layer 1 = first hop)',
    body: grid + bars,
  });
}

// ─── Chart 3 — daily volume timeline ─────────────────────────────────

/**
 * Per-day cash-out amount bucketed by IST calendar day from the raw ledger, so
 * the timeline can highlight the same-day cash-out clusters. Returns an empty
 * map if the ledger or the IST helper is unavailable.
 *
 * @param {ReadonlyArray<Record<string, unknown>>} transactions
 * @returns {Map<string, number>} day key (YYYY-MM-DD) -> cash-out amount
 */
function dailyCashoutByDay(transactions) {
  const out = new Map();
  if (!istDayKey || !Array.isArray(transactions)) return out;
  for (const t of transactions) {
    // payment_mode is the source-column ground truth (present on both raw
    // parsed rows and DB rows); cashout_mode is the analyzer's write-back and
    // only a fallback for rows whose payment_mode was blank.
    const pm = String(t.payment_mode ?? '').toUpperCase();
    const cm = String(t.cashout_mode ?? '').toUpperCase();
    const isExit = pm.includes('ATM') || pm.includes('AEPS') || pm === 'POS'
      || cm === 'ATM' || cm === 'POS' || cm === 'AEPS';
    if (!isExit) continue;
    const day = istDayKey(t.transaction_date);
    if (day == null) continue;
    out.set(day, (out.get(day) || 0) + num(t.transaction_amount));
  }
  return out;
}

/**
 * Daily transaction-volume chart. Each day is a bar sized by total amount; the
 * cash-out share of that day (from {@link dailyCashoutByDay}) is stacked on top
 * in the exit colour so same-day cash-out clusters stand out.
 *
 * @param {Array<Record<string, unknown>>} timeline - analyzer `timeline`.
 * @param {ReadonlyArray<Record<string, unknown>>} transactions - raw ledger.
 * @returns {string|null}
 */
function buildTimelineSvg(timeline, transactions) {
  const days = (Array.isArray(timeline) ? timeline : [])
    .filter((d) => d && d.date)
    .slice()
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (days.length === 0) return null;

  const cashoutByDay = dailyCashoutByDay(transactions);

  const W = 960;
  const H = 470;
  const padL = 96;
  const padR = 40;
  const top = 90;
  const baseY = H - 84;
  const plotW = W - padL - padR;
  const plotH = baseY - top;
  const maxAmt = Math.max(1, ...days.map((d) => num(d.total_amount)));

  let grid = '';
  for (let i = 0; i <= 4; i++) {
    const y = r2(baseY - (plotH * i) / 4);
    const val = (maxAmt * i) / 4;
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${GRID}" stroke-width="1"/>`;
    grid += `<text x="${padL - 10}" y="${y + 4}" font-size="11" text-anchor="end" fill="${MUTED}">`
      + `${xml(compactMoney(val))}</text>`;
  }

  const slot = plotW / days.length;
  const barW = Math.max(2, Math.min(46, slot * 0.7));
  // Label every Nth day so a long trail's axis stays legible.
  const labelEvery = Math.ceil(days.length / 12);
  let bars = '';
  let cashoutDays = 0;
  for (let i = 0; i < days.length; i++) {
    const d = days[i];
    const cx = padL + slot * (i + 0.5);
    const x = r2(cx - barW / 2);
    const totalH = scale(num(d.total_amount), 0, maxAmt, 0, plotH);
    const cashAmt = cashoutByDay.get(String(d.date)) || 0;
    const cashH = Math.min(totalH, scale(cashAmt, 0, maxAmt, 0, plotH));
    const baseH = Math.max(0, totalH - cashH);
    const yTop = r2(baseY - totalH);
    // Non-cash-out portion (navy) then the cash-out portion (green) on top.
    bars += `<rect x="${x}" y="${r2(baseY - baseH)}" width="${r2(barW)}" height="${r2(baseH)}" fill="${NAVY}"/>`;
    if (cashH > 0) {
      bars += `<rect x="${x}" y="${yTop}" width="${r2(barW)}" height="${r2(cashH)}" fill="${ROLE.exit}"/>`;
      cashoutDays += 1;
      // Cluster marker tick above the bar.
      bars += `<circle cx="${r2(cx)}" cy="${r2(yTop - 8)}" r="3" fill="${ROLE.exit}"/>`;
    }
    if (i % labelEvery === 0) {
      const lbl = String(d.date).slice(5); // MM-DD
      bars += `<text x="${r2(cx)}" y="${baseY + 18}" font-size="10" text-anchor="end" `
        + `transform="rotate(-45 ${r2(cx)} ${baseY + 18})" fill="${MUTED}">${xml(lbl)}</text>`;
    }
  }

  const legendY = H - 16;
  const legend = legendItem(padL, legendY, NAVY, 'Daily transaction volume')
    + legendItem(padL + 250, legendY, ROLE.exit,
      `Same-day cash-out (${cashoutDays} day${cashoutDays === 1 ? '' : 's'})`);

  return svgDoc({
    w: W,
    h: H,
    title: 'Daily Volume Timeline',
    subtitle: 'Transaction volume per IST day; cash-out clusters highlighted',
    body: grid + bars + legend,
  });
}

// ─── Rasterisation ───────────────────────────────────────────────────

/**
 * Rasterise one SVG string to a PNG buffer. Renders at the SVG's authored pixel
 * size (≈2× the dossier's content width) for crisp print output. Deterministic
 * for a given SVG + font set.
 *
 * @param {string} svg
 * @returns {{ png: Buffer, w: number, h: number }|null}
 */
function rasterise(svg) {
  if (!Resvg || !svg) return null;
  try {
    const resvg = new Resvg(svg, {
      background: 'white',
      font: { loadSystemFonts: true, defaultFontFamily: 'Arial' },
      // Keep text shaping stable even if the named family is missing.
      shapeRendering: 2,
      textRendering: 2,
      imageRendering: 0,
    });
    const rendered = resvg.render();
    return { png: rendered.asPng(), w: rendered.width, h: rendered.height };
  } catch (_e) {
    return null;
  }
}

/**
 * Build and rasterise all dossier charts from one analysis bundle.
 *
 * @param {Record<string, unknown>} analysis - parsed analysis_json.
 * @param {ReadonlyArray<Record<string, unknown>>} [transactions] - raw ledger,
 *   used only for the timeline's same-day cash-out overlay.
 * @returns {{
 *   available: boolean,
 *   network: { png: Buffer, w: number, h: number }|null,
 *   layers:  { png: Buffer, w: number, h: number }|null,
 *   timeline:{ png: Buffer, w: number, h: number }|null,
 *   svg: { network: string|null, layers: string|null, timeline: string|null },
 * }}
 */
function renderCharts(analysis = {}, transactions = []) {
  const networkSvg = buildNetworkSvg(analysis.money_flow_network || {});
  const layerSvg = buildLayerSvg(analysis.layer_analysis || []);
  const timelineSvg = buildTimelineSvg(analysis.timeline || [], transactions);
  return {
    available: Boolean(Resvg),
    loadError: resvgLoadError ? String(resvgLoadError.message || resvgLoadError) : null,
    network: rasterise(networkSvg),
    layers: rasterise(layerSvg),
    timeline: rasterise(timelineSvg),
    svg: { network: networkSvg, layers: layerSvg, timeline: timelineSvg },
  };
}

module.exports = {
  renderCharts,
  // Exposed for unit tests; not part of the stable contract.
  _internals: Object.freeze({
    buildNetworkSvg,
    buildLayerSvg,
    buildTimelineSvg,
    dailyCashoutByDay,
    compactMoney,
    rasterise,
  }),
};
