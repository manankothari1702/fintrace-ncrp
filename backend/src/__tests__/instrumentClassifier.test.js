'use strict';

/**
 * Unit tests for backend/src/lib/instrumentClassifier.js — the wallet / masked /
 * bank partition that decides which lien rows get a Section 102 freeze letter.
 */

const {
  classifyInstrument,
  partitionInstruments,
  lienAmountOf,
  _internals,
} = require('../lib/instrumentClassifier');

const {
  isVpaAccount, isPaTokenAccount, isPseudoIfsc, isWalletEntityName, isMaskedAccount,
} = _internals;

describe('low-level predicates', () => {
  test('UPI VPA accounts are detected by the @ pattern', () => {
    expect(isVpaAccount('9692464349@ybl')).toBe(true);
    expect(isVpaAccount('paulsagar1781@oksbi')).toBe(true);
    expect(isVpaAccount('00000005906495023')).toBe(false);
  });

  test('PA-token accounts (FPPI / PPI / BillNumber)', () => {
    expect(isPaTokenAccount('FPPI31a8fdd06cb5')).toBe(true);
    expect(isPaTokenAccount('BillNumber042000010134')).toBe(true);
    expect(isPaTokenAccount('123456789')).toBe(false);
  });

  test('pseudo-IFSC: PPIW wallet rail, bare NA, app names in the IFSC cell', () => {
    expect(isPseudoIfsc('PPIW0881822')).toBe(true);
    expect(isPseudoIfsc('NA')).toBe(true);
    expect(isPseudoIfsc('PHONEPE')).toBe(true);
    expect(isPseudoIfsc('PAYTM')).toBe(true);
    // A real bank IFSC must NOT be treated as pseudo.
    expect(isPseudoIfsc('PUNB0079320')).toBe(false);
    expect(isPseudoIfsc('SBIN0005477')).toBe(false);
    expect(isPseudoIfsc('')).toBe(false);
  });

  test('wallet entity names exclude anything containing "bank"', () => {
    expect(isWalletEntityName('Paytm')).toBe(true);
    expect(isWalletEntityName('PhonePe')).toBe(true);
    expect(isWalletEntityName('Mobikwik')).toBe(true);
    expect(isWalletEntityName('CRED')).toBe(true);
    expect(isWalletEntityName('Ease Buzz')).toBe(true);
    expect(isWalletEntityName('Razorpay')).toBe(true);
    // Real (payments) banks are NOT wallets even though the brand collides.
    expect(isWalletEntityName('Paytm Payments Bank')).toBe(false);
    expect(isWalletEntityName('Airtel Payments Bank')).toBe(false);
    expect(isWalletEntityName('Slice Small Finance Bank')).toBe(false);
    expect(isWalletEntityName('State Bank of India')).toBe(false);
  });

  test('masked account numbers: empty, placeholders, X-runs', () => {
    expect(isMaskedAccount('XXXX')).toBe(true);
    expect(isMaskedAccount('XXXXXXXX125989')).toBe(true);
    expect(isMaskedAccount('NA')).toBe(true);
    expect(isMaskedAccount('Na')).toBe(true);
    expect(isMaskedAccount('')).toBe(true);
    expect(isMaskedAccount('—')).toBe(true);
    expect(isMaskedAccount('00000005906495023')).toBe(false);
  });
});

describe('classifyInstrument', () => {
  test('actionable bank accounts → "bank"', () => {
    expect(classifyInstrument({ account_no: '0793208100657578', ifsc_code: 'PUNB0079320', bank_name: 'Punjab National Bank' })).toBe('bank');
    // A real bank with NO IFSC but a normal account number is still actionable
    // (verify-the-bank caveat applies separately).
    expect(classifyInstrument({ account_no: '1000020019', ifsc_code: null, bank_name: 'Airtel Payments Bank' })).toBe('bank');
  });

  test('wallet / PA / VPA → "wallet" (entity, VPA, or pseudo-IFSC)', () => {
    expect(classifyInstrument({ account_no: 'NA', ifsc_code: null, bank_name: 'Paytm' })).toBe('wallet');
    expect(classifyInstrument({ account_no: '9692464349@ybl', ifsc_code: null, bank_name: 'Slice Small Finance Bank' })).toBe('wallet');
    expect(classifyInstrument({ account_no: '917877678430', ifsc_code: 'PPIW0881822', bank_name: 'IndusInd Bank' })).toBe('wallet');
    expect(classifyInstrument({ account_no: '00000033129302435', ifsc_code: 'PHONEPE', bank_name: 'Slice Small Finance Bank' })).toBe('wallet');
  });

  test('masked number at a REAL bank → "masked" (not wallet)', () => {
    expect(classifyInstrument({ account_no: 'XXXX', ifsc_code: null, bank_name: 'UNITY SMALL FINANCE BANK' })).toBe('masked');
    expect(classifyInstrument({ account_no: 'XXXXXXXX125989', ifsc_code: 'BARB0BUPGBX', bank_name: 'Bank of Baroda (including Vijaya Bank and Dena Bank)' })).toBe('masked');
  });

  test('precedence: a wallet ENTITY with a masked number → wallet', () => {
    // CRED card reference "XXXX…5026": CRED is a wallet/PA entity, so it is
    // classified wallet (identify the nodal bank), not merely "masked".
    expect(classifyInstrument({ account_no: 'XXXXXXXXXXXX5026', ifsc_code: null, bank_name: 'CRED' })).toBe('wallet');
  });
});

describe('partitionInstruments', () => {
  const rows = [
    { account_no: '0793208100657578', ifsc_code: 'PUNB0079320', bank_name: 'Punjab National Bank', lien_eligible_amount: 3000 },
    { account_no: 'NA', ifsc_code: null, bank_name: 'Paytm', lien_eligible_amount: 6969.2 },
    { account_no: 'XXXX', ifsc_code: null, bank_name: 'UNITY SMALL FINANCE BANK', lien_eligible_amount: 40 },
    { account_no: '9692464349@ybl', ifsc_code: null, bank_name: 'Slice Small Finance Bank', lien_eligible_amount: 122.82 },
  ];

  test('every row lands in exactly one bucket and amounts reconcile', () => {
    const { bank, wallet, masked } = partitionInstruments(rows);
    expect(bank).toHaveLength(1);
    expect(wallet).toHaveLength(2); // Paytm NA + VPA
    expect(masked).toHaveLength(1); // UNITY XXXX
    expect(bank.length + wallet.length + masked.length).toBe(rows.length);

    const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
    const total = sum(bank, (b) => b.lien_eligible_amount)
      + sum(wallet, (w) => w.amount) + sum(masked, (m) => m.amount);
    const full = rows.reduce((s, r) => s + r.lien_eligible_amount, 0);
    expect(Math.round(total * 100)).toBe(Math.round(full * 100));
  });

  test('wallet entries carry the raw IFSC as source_ref, never as a bank IFSC', () => {
    const { wallet } = partitionInstruments([
      { account_no: 'FPPI31a8fdd06cb5', ifsc_code: 'PPIW0884509', bank_name: 'Kotak Mahindra Bank', lien_eligible_amount: 999.81 },
    ]);
    expect(wallet).toHaveLength(1);
    expect(wallet[0].source_ref).toBe('PPIW0884509');
    expect(wallet[0]).not.toHaveProperty('ifsc_code'); // never labelled as IFSC
    expect(wallet[0].note).toMatch(/not a bank account/i);
  });

  test('masked entries keep the (possibly real) IFSC and a "obtain full number" note', () => {
    const { masked } = partitionInstruments([
      { account_no: 'XXXXXX0329', ifsc_code: 'SBIN0005477', bank_name: 'State Bank of India', lien_eligible_amount: 700 },
    ]);
    expect(masked[0].ifsc_code).toBe('SBIN0005477');
    expect(masked[0].note).toMatch(/masked|unresolvable/i);
  });

  test('empty / non-array input → three empty buckets', () => {
    expect(partitionInstruments(null)).toEqual({ bank: [], wallet: [], masked: [] });
    expect(partitionInstruments([])).toEqual({ bank: [], wallet: [], masked: [] });
  });

  test('lienAmountOf reads any supported amount alias', () => {
    expect(lienAmountOf({ lien_amount: 1 })).toBe(1);
    expect(lienAmountOf({ lien_eligible_amount: 2 })).toBe(2);
    expect(lienAmountOf({ disputed_amount: 4 })).toBe(4);
    expect(lienAmountOf({ recoverableAmount: 8 })).toBe(8);
    expect(lienAmountOf({})).toBe(0);
  });
});
