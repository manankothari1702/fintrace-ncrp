'use strict';

/**
 * Unit tests for the Cash/Exit Excel workbook (Features 4/5 export), which reuses
 * the shared excelGenerator infra. Builds a cash_exit_analysis via analyzeReport
 * on a small fixture, then asserts the workbook's sheets + a flagged instance.
 */

const XLSX = require('xlsx');
const { analyzeReport } = require('../analyzers/analyzer');
const { generateCashExitExcel } = require('../utils/excelGenerator');

let seq = 0;
function exit(account, dateIso, amount, { mode = 'ATM', atm_id = 'ATM1', location = 'Loc', city = 'Metro' } = {}) {
  seq += 1;
  return {
    id: seq, ack_no: 'ACK', victim_account: account, beneficiary_account: account,
    beneficiary_bank: 'BankB', ifsc_code: 'BANK0001234',
    transaction_date: dateIso, transaction_amount: amount, disputed_amount: amount,
    utr_no: `X${seq}`, payment_mode: mode, layer_no: 2, atm_id, atm_location: location, city, state: 'S',
  };
}

async function fixtureCashExit() {
  const rows = [
    { id: 100, ack_no: 'ACK', victim_account: 'V', beneficiary_account: 'A', beneficiary_bank: 'B', ifsc_code: 'BANK0001234', transaction_date: '2024-01-15T00:00:00.000Z', transaction_amount: 100000, disputed_amount: 100000, payment_mode: 'IMPS', layer_no: 1 },
    // ATM rapid: 3 in 20 min, same account
    exit('A', '2024-01-15T01:00:00.000Z', 10000, { atm_id: 'ATMx' }),
    exit('A', '2024-01-15T01:10:00.000Z', 8000, { atm_id: 'ATMx' }),
    exit('A', '2024-01-15T01:20:00.000Z', 9000, { atm_id: 'ATMx' }),
    // POS suspicious: 3 in 30 min at one terminal
    exit('A', '2024-01-15T02:00:00.000Z', 5000, { mode: 'POS', atm_id: 'MID9', location: 'MERCHANT NINE' }),
    exit('A', '2024-01-15T02:15:00.000Z', 5000, { mode: 'POS', atm_id: 'MID9', location: 'MERCHANT NINE' }),
    exit('A', '2024-01-15T02:30:00.000Z', 5000, { mode: 'POS', atm_id: 'MID9', location: 'MERCHANT NINE' }),
  ];
  const a = await analyzeReport(1, rows, []);
  return a.cash_exit_analysis;
}

describe('generateCashExitExcel', () => {
  test('full scope → overview + per-channel + flags + tops sheets, with a flag row', async () => {
    const ce = await fixtureCashExit();
    const wb = XLSX.read(generateCashExitExcel(ce, { scope: 'full', caseRef: 'CASE1' }), { type: 'buffer' });
    expect(wb.SheetNames).toEqual(expect.arrayContaining([
      'Cash-Exit Overview', 'ATM Transactions', 'POS Transactions', 'Behavioural Flags', 'Top Exit Points', 'Top Cities',
    ]));
    const flags = XLSX.utils.sheet_to_json(wb.Sheets['Behavioural Flags'], { header: 1 });
    const rapidRow = flags.find((r) => r[1] === 'Rapid Withdrawals');
    const merchRow = flags.find((r) => r[1] === 'Suspicious Merchants');
    expect(rapidRow).toBeDefined();
    expect(merchRow).toBeDefined();
    expect(String(rapidRow[5])).toMatch(/withdrawals in \d+ min/);
  });

  test('view scope (POS + flag) → one sheet with a "Why flagged" column', async () => {
    const ce = await fixtureCashExit();
    const wb = XLSX.read(
      generateCashExitExcel(ce, { scope: 'view', channel: 'POS', flag: 'suspicious_merchant', caseRef: 'CASE1' }),
      { type: 'buffer' },
    );
    expect(wb.SheetNames).toHaveLength(1);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const header = rows[4];
    expect(header[header.length - 1]).toBe('Why flagged');
    expect(rows.length - 5).toBe(3); // three flagged POS txns
  });
});
