'use strict';

/**
 * FinTrace Bank Statement module — template detection signatures.
 *
 * A template's signature answers "is this uploaded file the same bank
 * layout the officer already mapped once?". It is stored as JSON on
 * bank_templates.signature:
 *
 *   {
 *     "headers":    ["txndate", "particulars", ...],  // normalized header
 *                                                     // row, IN ORDER
 *     "ifscPrefix": "MUCB0" | null                    // optional secondary
 *   }
 *
 * The header-row fingerprint is the primary signal: a file matches when
 * some row in its scan window normalizes to EXACTLY the same ordered label
 * list (trailing empties trimmed). Bank exports keep column order stable,
 * so ordered equality is both robust across preamble-length changes and
 * conservative against false positives between banks with similar generic
 * headers. The IFSC prefix (bank code + '0') only breaks ties when two
 * templates share a fingerprint. Filename patterns are deliberately NOT
 * part of the signature — content, never filenames, decides detection
 * (same rule as the dedicated-parser detector).
 *
 * @module backend/src/parsers/bankStatement/templateMatch
 */

const { normalizeHeader, HEADER_SCAN_DEPTH } = require('./tabular');
const { _internals: genericInternals } = require('./genericMapped');
const { locateMappedHeader } = genericInternals;

/** Normalize a header row: per-cell normalizeHeader, trailing empties trimmed. */
function fingerprintRow(row) {
  const cells = (Array.isArray(row) ? row : []).map((c) => normalizeHeader(c));
  while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** IFSC prefix (first 5 chars: bank code + '0') found anywhere in the scan window. */
function sniffIfscPrefix(rows) {
  const depth = Math.min(rows.length, HEADER_SCAN_DEPTH);
  for (let r = 0; r < depth; r++) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    for (const cell of row) {
      if (cell === null || cell === undefined) continue;
      const m = String(cell).toUpperCase().match(/\b([A-Z]{4}0)[A-Z0-9]{6}\b/);
      if (m) return m[1];
    }
  }
  return null;
}

/**
 * Build the signature for a file whose mapping the officer just confirmed.
 * The header row is located from the mapping's own labels (same logic the
 * parser uses), so the fingerprint is exactly the row the mapping targets.
 *
 * @param {Array<Array<unknown>>} rows
 * @param {object} mapping - validated genericMapped mapping.
 * @returns {{ headers: string[], ifscPrefix: string|null }}
 * @throws {Error} code 'MAPPED_HEADER_NOT_FOUND' when the mapping doesn't fit the rows.
 */
function buildSignature(rows, mapping) {
  const sourceHeaders = Object.entries(mapping.columns || {})
    .filter(([, role]) => role !== 'ignore')
    .map(([header]) => header);
  const located = locateMappedHeader(rows, sourceHeaders);
  if (!located) {
    const err = new Error('Cannot build a template signature: mapped headers not found in the file.');
    err.code = 'MAPPED_HEADER_NOT_FOUND';
    throw err;
  }
  return {
    headers: fingerprintRow(rows[located.headerRow]),
    ifscPrefix: sniffIfscPrefix(rows),
  };
}

/**
 * Find the saved template matching an uploaded file, if any.
 *
 * @param {Array<{ id: number, signature: string }>} templates - bank_templates
 *   rows (signature still JSON text), newest first.
 * @param {Array<Array<unknown>>} rows - the uploaded file's rows.
 * @returns {object|null} the matching template row, or null.
 */
function findMatchingTemplate(templates, rows) {
  if (!Array.isArray(templates) || templates.length === 0) return null;

  // Fingerprint every candidate header row in the scan window once (joined
  // for Set lookup; signature and file rows join identically).
  const rowPrints = [];
  const depth = Math.min(rows.length, HEADER_SCAN_DEPTH);
  for (let r = 0; r < depth; r++) {
    const print = fingerprintRow(rows[r]);
    if (print.length >= 2) rowPrints.push(print.join(''));
  }
  const printSet = new Set(rowPrints);

  const matches = [];
  for (const t of templates) {
    let sig;
    try { sig = JSON.parse(t.signature); } catch (_e) { continue; }
    if (!sig || !Array.isArray(sig.headers) || sig.headers.length === 0) continue;
    if (printSet.has(sig.headers.join(''))) matches.push({ template: t, sig });
  }
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].template;

  // Ties: prefer a template whose IFSC prefix appears in the file.
  const filePrefix = sniffIfscPrefix(rows);
  const byIfsc = matches.find((m) => m.sig.ifscPrefix && m.sig.ifscPrefix === filePrefix);
  return (byIfsc || matches[0]).template; // templates arrive newest first
}

module.exports = { buildSignature, findMatchingTemplate, sniffIfscPrefix, fingerprintRow };
