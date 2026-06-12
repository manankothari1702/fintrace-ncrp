'use strict';

const {
  resolveBank,
  bankNameFor,
  sameBank,
  cleanIfsc,
  FLAGS,
} = require('../lib/ifscBankResolver');

describe('ifscBankResolver — IFSC is authoritative', () => {
  // Real disputed accounts from case 32712250107145 that the old pipeline mislabelled.
  const realCases = [
    { account: '00000005906495023', ifsc: 'CBIN0282138', rawBank: 'Central Bank of India', expect: 'Central Bank of India' },
    { account: '252000590337',      ifsc: 'SURY0000011', rawBank: 'Suryoday Bank',         expect: 'Suryoday Small Finance Bank' },
    { account: '100219234781',      ifsc: 'INDB0001080', rawBank: 'IndusInd Bank',         expect: 'IndusInd Bank' },
    { account: '159079012694',      ifsc: 'INDB0000421', rawBank: 'IndusInd Bank',         expect: 'IndusInd Bank' },
    { account: '14751050003336',    ifsc: 'HDFC0001475', rawBank: 'HDFC Bank',             expect: 'HDFC Bank' },
    { account: '002261100000025',   ifsc: 'YESB0YBLUPI', rawBank: 'Yes Bank',              expect: 'Yes Bank' },
    { account: '00000044021519366', ifsc: 'SBIN0064933', rawBank: 'State Bank of India',   expect: 'State Bank of India' },
    { account: '890073000000688',   ifsc: 'SIBL0000890', rawBank: 'South Indian Bank',     expect: 'South Indian Bank' },
    { account: '60556696585',       ifsc: 'MAHB0002169', rawBank: 'Bank of Maharashtra',   expect: 'Bank of Maharashtra' },
    { account: '24360110076453',    ifsc: 'UCBA0002436', rawBank: 'UCO Bank',              expect: 'UCO Bank' },
  ];

  test.each(realCases)('$account ($ifsc) -> $expect', ({ ifsc, rawBank, expect: want }) => {
    const r = resolveBank({ ifsc, rawBank });
    expect(r.bank).toBe(want);
    expect(r.source).toBe('IFSC');
    expect(r.flag).toBeNull(); // text and IFSC agree in these rows
  });
});

describe('merged-bank consolidation', () => {
  test('BARB resolves to the Bank of Baroda group label', () => {
    expect(bankNameFor('Bank of Baroda', 'BARB0DBLJAT')).toMatch(/Bank of Baroda/);
  });
  test('BDBL resolves to Bandhan Bank even when text says "Others"', () => {
    const r = resolveBank({ ifsc: 'BDBL0002532', rawBank: 'Others' });
    expect(r.bank).toBe('Bandhan Bank');
    expect(r.flag).toBeNull(); // "Others" is treated as blank, not a contradiction
  });
});

describe('IFSC vs text mismatch is flagged', () => {
  test('valid IFSC overrides a wrong text label and raises IFSC_TEXT_MISMATCH', () => {
    // Simulate the exact old-pipeline error: account is at Central Bank (CBIN)
    // but a bad text field claims Union Bank.
    const r = resolveBank({ ifsc: 'CBIN0282138', rawBank: 'Union Bank of India' });
    expect(r.bank).toBe('Central Bank of India');
    expect(r.source).toBe('IFSC');
    expect(r.flag).toBe(FLAGS.IFSC_TEXT_MISMATCH);
    expect(r.rawBank).toBe('Union Bank of India'); // original preserved for audit
  });
});

describe('wallet / PA / PG accounts (no usable IFSC) fall back to text', () => {
  test('blank IFSC -> NO_IFSC, keeps wallet name', () => {
    const r = resolveBank({ ifsc: '', rawBank: 'Mobikwik' });
    expect(r.bank).toBe('Mobikwik');
    expect(r.source).toBe('TEXT');
    expect(r.flag).toBe(FLAGS.NO_IFSC);
  });
  test('null IFSC, CRED wallet', () => {
    const r = resolveBank({ ifsc: null, rawBank: 'CRED' });
    expect(r.bank).toBe('CRED');
    expect(r.flag).toBe(FLAGS.NO_IFSC);
  });
  test('garbage IFSC -> INVALID_IFSC', () => {
    const r = resolveBank({ ifsc: 'NA', rawBank: 'Paytm' });
    expect(r.bank).toBe('Paytm');
    expect(r.flag).toBe(FLAGS.INVALID_IFSC);
  });
  test('empty everything -> Unknown + NO_IFSC', () => {
    const r = resolveBank({});
    expect(r.bank).toBe('Unknown');
    expect(r.flag).toBe(FLAGS.NO_IFSC);
  });
});

describe('unknown but valid-looking IFSC prefix is flagged, not guessed', () => {
  test('ZZZZ0000001 keeps text and raises UNKNOWN_IFSC_PREFIX', () => {
    const r = resolveBank({ ifsc: 'ZZZZ0000001', rawBank: 'Some Co-op Bank' });
    expect(r.bank).toBe('Some Co-op Bank');
    expect(r.flag).toBe(FLAGS.UNKNOWN_IFSC_PREFIX);
  });
});

describe('helpers', () => {
  test('cleanIfsc validates the 11-char IFSC shape', () => {
    expect(cleanIfsc('cbin0282138')).toBe('CBIN0282138'); // upper-cased
    expect(cleanIfsc('CBIN282138')).toBeNull();            // missing the mandatory 0
    expect(cleanIfsc('  HDFC0001475 ')).toBe('HDFC0001475');
    expect(cleanIfsc(undefined)).toBeNull();
  });
  test('sameBank tolerates suffixes/parentheticals/case', () => {
    expect(sameBank('HDFC Bank', 'HDFC BANK LTD')).toBe(true);
    expect(sameBank('Bank of Baroda (including Vijaya Bank and Dena Bank)', 'Bank of Baroda')).toBe(true);
    expect(sameBank('IndusInd Bank', 'HDFC Bank')).toBe(false);
    expect(sameBank('Central Bank of India', 'Union Bank of India')).toBe(false);
  });
});
