'use strict';

/**
 * Best-effort text extraction from a PDF buffer for assertions — inflates
 * every content stream and pulls the string literals out of Tj / TJ text-show
 * operators. Same approach as scripts/validate_v020.js (kept in sync by hand;
 * it is deliberately dependency-free).
 */

const zlib = require('zlib');

/** Decode a PDF `(literal)` string body (backslash escapes + octal). */
function decodePdfString(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = inner[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let oct = next; i += 1;
      for (let k = 0; k < 2 && inner[i + 1] >= '0' && inner[i + 1] <= '7'; k++) { oct += inner[++i]; }
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    if (next === '\n') { i += 1; continue; } // line continuation
    out += (next in map) ? map[next] : next;
    i += 1;
  }
  return out;
}

/** Decode a PDF `<hex>` string body. */
function decodeHex(hex) {
  const clean = String(hex).replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
  }
  if (clean.length % 2 === 1) out += String.fromCharCode(parseInt(clean[clean.length - 1] + '0', 16));
  return out;
}

/** Concatenate the `<hex>` / `(literal)` string pieces inside one operator. */
function piecesToText(inner) {
  let out = '';
  const re = /<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    out += (m[1] !== undefined) ? decodeHex(m[1]) : decodePdfString(m[2]);
  }
  return out;
}

/** Pull rendered text from one content-stream chunk, one token per text show. */
function literalsFromContent(s) {
  const tokens = [];
  const reTJ = /\[([^\]]*)\]\s*TJ/g;
  let m;
  while ((m = reTJ.exec(s)) !== null) tokens.push(piecesToText(m[1]));
  const reTj = /(<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\()])*\))\s*Tj/g;
  while ((m = reTj.exec(s)) !== null) tokens.push(piecesToText(m[1]));
  return tokens.join(' ');
}

/**
 * Extract a best-effort text dump from a PDF buffer.
 * @param {Buffer} buf
 * @returns {string}
 */
function extractPdfText(buf) {
  const out = [];
  const streamTok = Buffer.from('stream');
  const endTok = Buffer.from('endstream');
  let pos = 0;
  while (true) {
    const s = buf.indexOf(streamTok, pos);
    if (s < 0) break;
    let cs = s + streamTok.length;
    if (buf[cs] === 0x0d) cs++;
    if (buf[cs] === 0x0a) cs++;
    const e = buf.indexOf(endTok, cs);
    if (e < 0) break;
    const chunk = buf.slice(cs, e);
    let content = null;
    try { content = zlib.inflateSync(chunk); }
    catch (_a) {
      try { content = zlib.inflateRawSync(chunk); }
      catch (_b) { content = chunk; }
    }
    try { out.push(literalsFromContent(content.toString('latin1'))); } catch (_c) { /* skip */ }
    pos = e + endTok.length;
  }
  return out.join('\n');
}

module.exports = { extractPdfText };
