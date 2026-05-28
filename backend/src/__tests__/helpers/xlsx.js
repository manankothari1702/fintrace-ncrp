'use strict';

/**
 * Shared XLSX builders for the test suite.
 *
 * Produces real Excel buffers / files via SheetJS so the parser and upload
 * endpoint see authentic .xlsx bytes (passing the magic-byte gate that rejects
 * arbitrary data renamed to .xlsx).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const XLSX = require('xlsx');

/**
 * Build an .xlsx buffer from a 2-D array of cell values.
 *
 * @param {Array<Array<unknown>>} rows  Including the header row at index 0.
 * @param {string} [sheetName='Sheet1']
 * @returns {Buffer}
 */
function makeTestXlsx(rows, sheetName = 'Sheet1') {
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

/**
 * Write an .xlsx buffer to a temporary file (in os.tmpdir) and return the path.
 * The caller is responsible for unlinking the file when done.
 *
 * @param {Array<Array<unknown>>} rows
 * @param {string} [prefix='ncrp-test-']
 * @returns {string} Absolute path to the file.
 */
function writeTempXlsx(rows, prefix = 'ncrp-test-') {
  const buf = makeTestXlsx(rows);
  const filePath = path.join(
    os.tmpdir(),
    `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}.xlsx`
  );
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/**
 * Build the canonical NCRP header row used by most tests.
 */
const STANDARD_HEADERS = Object.freeze([
  'Acknowledgement No',
  'Complaint Date',
  'Victim Account No',
  'Victim Bank',
  'Beneficiary A/C',
  'Beneficiary Bank',
  'Beneficiary Name',
  'IFSC Code',
  'Transaction Date',
  'Transaction Amount',
  'Disputed Amount',
  'UTR/Reference No',
  'Payment Mode',
  'Layer',
  'ATM ID',
  'ATM Location',
  'City',
  'State',
  'Remarks',
]);

/**
 * Build an alternate header row using bank-specific synonyms — to verify the
 * parser maps aliases like "Bene Account" / "Txn Amount" correctly.
 */
const ALTERNATE_HEADERS = Object.freeze([
  'Complaint Number',
  'Complaint Dt',
  'Victim A/C',
  'Victim Bank Name',
  'Bene Account',
  'Bene Bank',
  'Bene Name',
  'Bene IFSC',
  'Txn Date',
  'Txn Amount',
  'Dispute Amount',
  'UTR No',
  'Mode of Payment',
  'Layer No',
  'ATM Id',
  'ATM Loc',
  'City',
  'State',
  'Remark',
]);

/**
 * Build a representative 3-layer NCRP dataset. Used by analyzer + integration
 * tests so behaviour around layer rollups, cashouts, and email generation is
 * predictable.
 */
function buildStandardRows() {
  return [
    STANDARD_HEADERS,
    // Layer 1 — victim → mule1
    [
      'NCRP202612345678', '2024-01-14T00:00:00.000Z',
      'V0001', 'HDFC Bank',
      'M0001', 'ICICI Bank', 'Mule One', 'ICIC0001234',
      '2024-01-15T05:00:00.000Z', 100000, 100000,
      'UTR0001', 'IMPS', 1,
      null, null, 'Mumbai', 'Maharashtra', 'first leg',
    ],
    // Layer 2 — mule1 → mule2
    [
      'NCRP202612345678', '2024-01-14T00:00:00.000Z',
      'M0001', 'ICICI Bank',
      'M0002', 'SBI', 'Mule Two', 'SBIN0009876',
      '2024-01-15T06:00:00.000Z', 90000, 100000,
      'UTR0002', 'NEFT', 2,
      null, null, 'Pune', 'Maharashtra', 'second leg',
    ],
    // Layer 3 — mule2 → mule3 (terminal account)
    [
      'NCRP202612345678', '2024-01-14T00:00:00.000Z',
      'M0002', 'SBI',
      'M0003', 'Axis Bank', 'Mule Three', 'UTIB0005555',
      '2024-01-16T07:00:00.000Z', 80000, 100000,
      'UTR0003', 'IMPS', 3,
      null, null, 'Delhi', 'Delhi', 'third leg',
    ],
    // ATM cashout on the same day funds arrived (creates a same-day cashout
    // event on layer-3 mule3 — covers FR-12).
    [
      'NCRP202612345678', '2024-01-14T00:00:00.000Z',
      'M0002', 'SBI',
      'M0003', 'Axis Bank', 'Mule Three', 'UTIB0005555',
      '2024-01-16T09:00:00.000Z', 25000, 100000,
      'UTR0004', 'ATM', 3,
      'ATM1234', 'NSP Branch', 'Delhi', 'Delhi', 'cashout 1',
    ],
    // Second ATM cashout same day, same ATM.
    [
      'NCRP202612345678', '2024-01-14T00:00:00.000Z',
      'M0002', 'SBI',
      'M0003', 'Axis Bank', 'Mule Three', 'UTIB0005555',
      '2024-01-16T11:00:00.000Z', 20000, 100000,
      'UTR0005', 'ATM', 3,
      'ATM1234', 'NSP Branch', 'Delhi', 'Delhi', 'cashout 2',
    ],
  ];
}

module.exports = {
  makeTestXlsx,
  writeTempXlsx,
  buildStandardRows,
  STANDARD_HEADERS,
  ALTERNATE_HEADERS,
};
