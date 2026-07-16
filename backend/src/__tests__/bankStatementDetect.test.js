'use strict';

/**
 * Bank auto-detection + upload container sniffing. Detection must be
 * CONTENT-based (banner text / IFSC prefix / header signature) — a filename
 * like "pnb.xlsx" over non-PNB content must NOT detect.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const XLSX = require('xlsx');

const {
  detectBank, detectExcelBank, detectPdfBank, sniffSpreadsheetHeaders,
} = require('../parsers/bankStatement/detect');
const { sniffContainerFormat } = require('../routes/bankStatements');

const FIXTURES = path.join(__dirname, 'fixtures');
const PNB_XLS = path.join(FIXTURES, 'pnb_statement.xls');
const PNB_PDF = path.join(FIXTURES, 'pnb_statement.pdf');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bankstmt-'));

function writeWorkbook(rows, ext = '.xlsx') {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  const file = path.join(tmpDir(), `sample${ext}`);
  XLSX.writeFile(wb, file, ext === '.xls' ? { bookType: 'biff8' } : undefined);
  return file;
}

describe('detectBank — content-based, never filename-based', () => {
  test('recognises the real PNB .xls (banner + IFSC + header signature)', () => {
    const d = detectExcelBank(PNB_XLS);
    expect(d).toMatchObject({ bank: 'PNB', bankName: 'Punjab National Bank' });
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('recognises the real PNB PDF', async () => {
    const d = await detectPdfBank(PNB_PDF);
    expect(d).toMatchObject({ bank: 'PNB', bankName: 'Punjab National Bank' });
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
  });

  test('a non-PNB workbook is NOT recognised even with a pnb-ish filename', () => {
    const file = writeWorkbook([
      ['Date', 'Details', 'Withdrawal', 'Deposit', 'Balance'],
      ['01/06/2026', 'ATM CASH', '500', '', '1000.00'],
    ]);
    const renamed = path.join(path.dirname(file), 'pnb_statement_export.xlsx');
    fs.renameSync(file, renamed);
    expect(detectExcelBank(renamed)).toBeNull();
  });

  test('another bank\'s IFSC does not trip the PNB detector', () => {
    const file = writeWorkbook([
      ['Account Statement for Account Number 111122223333'],
      ['IFSC:', 'HDFC0000240'],
      ['Date', 'Narration', 'Amount', 'Balance'],
    ]);
    expect(detectExcelBank(file)).toBeNull();
  });

  test('detectBank routes by container format and rejects csv', async () => {
    await expect(detectBank(PNB_XLS, 'excel')).resolves.toMatchObject({ bank: 'PNB' });
    await expect(detectBank(PNB_XLS, 'csv')).resolves.toBeNull();
  });

  test('garbage bytes detect as nothing (no throw)', async () => {
    const file = path.join(tmpDir(), 'junk.pdf');
    fs.writeFileSync(file, 'not really a pdf');
    await expect(detectPdfBank(file)).resolves.toBeNull();
  });
});

describe('sniffSpreadsheetHeaders — wizard fallback for unrecognised files', () => {
  test('returns the first header-looking row', () => {
    const file = writeWorkbook([
      ['Statement of transactions'],
      ['Date', 'Details', 'Withdrawal', 'Deposit', 'Balance'],
      ['01/06/2026', 'ATM', '500', '', '1000'],
    ]);
    expect(sniffSpreadsheetHeaders(file)).toEqual(
      ['Date', 'Details', 'Withdrawal', 'Deposit', 'Balance'],
    );
  });

  test('returns [] for unreadable input', () => {
    const file = path.join(tmpDir(), 'junk.xlsx');
    fs.writeFileSync(file, Buffer.from([0x00, 0x01, 0x02]));
    expect(sniffSpreadsheetHeaders(file)).toEqual([]);
  });
});

describe('sniffContainerFormat — magic bytes cross-checked with extension', () => {
  test('real fixtures sniff to their own formats', () => {
    expect(sniffContainerFormat(PNB_XLS, '.xls')).toBe('excel');
    expect(sniffContainerFormat(PNB_PDF, '.pdf')).toBe('pdf');
  });

  test('an OLE2 .xls renamed to .pdf fails the check (and vice versa)', () => {
    expect(sniffContainerFormat(PNB_XLS, '.pdf')).toBeNull();
    expect(sniffContainerFormat(PNB_PDF, '.xls')).toBeNull();
  });

  test('a text file passes as .csv but binary does not', () => {
    const dir = tmpDir();
    const csv = path.join(dir, 'data.csv');
    fs.writeFileSync(csv, 'date,amount\n01/06/2026,100\n');
    expect(sniffContainerFormat(csv, '.csv')).toBe('csv');

    const binCsv = path.join(dir, 'bin.csv');
    fs.writeFileSync(binCsv, Buffer.from([0x64, 0x00, 0x61, 0x74, 0x61, 0x00]));
    expect(sniffContainerFormat(binCsv, '.csv')).toBeNull();

    expect(sniffContainerFormat(PNB_PDF, '.csv')).toBeNull(); // pdf masquerading as csv
  });

  test('unknown extensions are rejected outright', () => {
    expect(sniffContainerFormat(PNB_XLS, '.exe')).toBeNull();
  });
});
