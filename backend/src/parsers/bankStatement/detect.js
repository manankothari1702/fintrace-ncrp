'use strict';

/**
 * FinTrace Bank Statement module — bank auto-detection.
 *
 * Decides which bank's statement parser can handle an uploaded file by
 * inspecting its CONTENT (banner text, IFSC prefix, header signature) —
 * never the filename. Currently only PNB is recognised; anything else
 * returns null so the UI can fall back to "not recognised" + the manual
 * mapping wizard.
 *
 * @module backend/src/parsers/bankStatement/detect
 */

const XLSX = require('xlsx');

const { extractPdfLines } = require('./pnbPdf');

/** Public identity attached to every PNB detection result. */
const PNB = Object.freeze({ bank: 'PNB', bankName: 'Punjab National Bank' });

const RE_PNB_BANNER = /Account\s+Statement\s+for\s+Account\s+Number/i;
const RE_PNB_PDF_BANNER = /Statement\s+of\s+Account\s*:?\s*\d{6,}/i;
const RE_PNB_IFSC = /\bPUNB0[A-Z0-9]{6}\b/i;
const RE_PNB_ONE = /PNB\s+ONE/i;

/**
 * Sniff the first sheet's leading rows as text (cheap: sheetRows-limited).
 *
 * @param {string} filePath
 * @param {number} rows
 * @returns {string[]} cell strings, or [] when unreadable as a workbook.
 */
function excelLeadingCells(filePath, rows = 45) {
  let wb;
  try {
    wb = XLSX.readFile(filePath, { sheetRows: rows, raw: true });
  } catch (_e) {
    return [];
  }
  const cells = [];
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], {
      header: 1, raw: true, defval: null, blankrows: false,
    });
    for (const row of aoa) {
      if (!Array.isArray(row)) continue;
      for (const cell of row) {
        if (cell !== null && cell !== undefined && String(cell).trim() !== '') {
          cells.push(String(cell));
        }
      }
    }
  }
  return cells;
}

/**
 * Detect the issuing bank of an Excel statement from its content.
 *
 * @param {string} filePath
 * @returns {{ bank: string, bankName: string, confidence: number }|null}
 */
function detectExcelBank(filePath) {
  const cells = excelLeadingCells(filePath);
  if (cells.length === 0) return null;
  const text = cells.join('\n');

  const hasBanner = RE_PNB_BANNER.test(text);
  const hasIfsc = RE_PNB_IFSC.test(text);
  const hasHeader = /Txn\s*No\.?/i.test(text) && /Dr\s*Amount/i.test(text) && /Cr\s*Amount/i.test(text);

  if ((hasBanner && hasIfsc) || (hasBanner && hasHeader) || (hasIfsc && hasHeader)) {
    return { ...PNB, confidence: hasBanner && hasIfsc && hasHeader ? 0.99 : 0.9 };
  }
  return null;
}

/**
 * Detect the issuing bank of a PDF statement from its extracted text.
 *
 * @param {string|Buffer} src - file path or raw bytes.
 * @returns {Promise<{ bank: string, bankName: string, confidence: number }|null>}
 */
async function detectPdfBank(src) {
  let lines;
  try {
    lines = await extractPdfLines(src);
  } catch (_e) {
    return null;
  }
  const text = lines.map((l) => l.items.map((i) => i.str).join(' ')).join('\n');

  const hasBanner = RE_PNB_PDF_BANNER.test(text);
  const hasIfsc = RE_PNB_IFSC.test(text);
  const hasPnbOne = RE_PNB_ONE.test(text);

  if ((hasBanner && hasIfsc) || (hasIfsc && hasPnbOne)) {
    return { ...PNB, confidence: hasBanner && hasIfsc && hasPnbOne ? 0.99 : 0.9 };
  }
  return null;
}

/**
 * Detect the issuing bank for an uploaded statement file.
 *
 * @param {string} filePath
 * @param {'excel'|'pdf'|'csv'} format - sniffed container format (magic bytes).
 * @returns {Promise<{ bank: string, bankName: string, confidence: number }|null>}
 */
async function detectBank(filePath, format) {
  if (format === 'excel') return detectExcelBank(filePath);
  if (format === 'pdf') return detectPdfBank(filePath);
  return null; // no CSV statement format is recognised yet
}

/**
 * Best-effort header sniff for UNRECOGNISED spreadsheets, so the manual
 * mapping wizard has real column names to offer. Returns the first row that
 * looks like a header (≥3 non-empty short text cells).
 *
 * @param {string} filePath
 * @returns {string[]} header labels ([] when none found / not a spreadsheet)
 */
function sniffSpreadsheetHeaders(filePath) {
  let wb;
  try {
    wb = XLSX.readFile(filePath, { sheetRows: 30, raw: true });
  } catch (_e) {
    return [];
  }
  const first = wb.SheetNames[0];
  if (!first) return [];
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[first], {
    header: 1, raw: true, defval: null, blankrows: false,
  });
  for (const row of aoa) {
    if (!Array.isArray(row)) continue;
    const labels = row
      .map((c) => (c === null || c === undefined ? '' : String(c).trim()))
      .filter((s) => s !== '');
    const shortTexty = labels.filter((s) => s.length <= 40 && !/^\d+(\.\d+)?$/.test(s));
    if (shortTexty.length >= 3) return labels;
  }
  return [];
}

module.exports = { detectBank, detectExcelBank, detectPdfBank, sniffSpreadsheetHeaders };
