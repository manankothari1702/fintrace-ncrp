'use strict';

const {
  resolveBank,
  bankNameFor,
  sameBank,
  cleanIfsc,
  FLAGS,
  IFSC_BANK_MAP,
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

describe('IFSC_BANK_MAP regression snapshot', () => {
  // The map fails SILENTLY if an entry is wrong: a confident wrong bank name
  // lands on a Section 102 lien letter with no flag. This snapshot pins EVERY
  // prefix to its expected bank so any accidental edit — a flipped prefix, a
  // pasted-over name, a deleted group entry — fails loudly here. Editing the
  // map is allowed ONLY together with a deliberate update to this snapshot,
  // verified against the RBI IFSC directory (the authoritative source for the
  // 4-letter bank code; see provenance comments in lib/ifscBankResolver.js).
  const EXPECTED_MAP = {
    // ---- Public sector banks (post-2020 consolidation) ----
    SBIN: 'State Bank of India',
    CBIN: 'Central Bank of India',
    BKID: 'Bank of India',
    UCBA: 'UCO Bank',
    MAHB: 'Bank of Maharashtra',
    IOBA: 'Indian Overseas Bank',
    PSIB: 'Punjab & Sind Bank',
    BARB: 'Bank of Baroda (including Vijaya Bank and Dena Bank)',
    VIJB: 'Bank of Baroda (including Vijaya Bank and Dena Bank)',
    DENA: 'Bank of Baroda (including Vijaya Bank and Dena Bank)',
    PUNB: 'Punjab National Bank (including Oriental Bank of Commerce and United Bank of India)',
    ORBC: 'Punjab National Bank (including Oriental Bank of Commerce and United Bank of India)',
    UTBI: 'Punjab National Bank (including Oriental Bank of Commerce and United Bank of India)',
    UBIN: 'Union Bank of India (including Andhra Bank and Corporation Bank)',
    ANDB: 'Union Bank of India (including Andhra Bank and Corporation Bank)',
    CORP: 'Union Bank of India (including Andhra Bank and Corporation Bank)',
    CNRB: 'Canara Bank',
    SYNB: 'Canara Bank',
    IDIB: 'Indian Bank',
    ALLA: 'Indian Bank',
    // ---- Private sector banks ----
    HDFC: 'HDFC Bank',
    ICIC: 'ICICI Bank',
    UTIB: 'Axis Bank',
    KKBK: 'Kotak Mahindra Bank',
    INDB: 'IndusInd Bank',
    YESB: 'Yes Bank',
    IBKL: 'IDBI Bank',
    FDRL: 'Federal Bank',
    SIBL: 'South Indian Bank',
    KVBL: 'Karur Vysya Bank',
    CIUB: 'City Union Bank',
    TMBL: 'Tamilnad Mercantile Bank',
    DLXB: 'Dhanlaxmi Bank',
    KARB: 'Karnataka Bank',
    RATN: 'RBL Bank',
    BDBL: 'Bandhan Bank',
    CSBK: 'CSB Bank',
    NKGS: 'NKGSB Co-operative Bank',
    JSBP: 'Janata Sahakari Bank',
    // ---- Small finance banks ----
    SURY: 'Suryoday Small Finance Bank',
    ESFB: 'Equitas Small Finance Bank',
    UJVN: 'Ujjivan Small Finance Bank',
    AUBL: 'AU Small Finance Bank',
    JSFB: 'Jana Small Finance Bank',
    FINF: 'Fincare Small Finance Bank',
    UTKS: 'Utkarsh Small Finance Bank',
    ESMF: 'ESAF Small Finance Bank',
    NESF: 'North East Small Finance Bank',
    // ---- Payments banks ----
    PYTM: 'Paytm Payments Bank',
    AIRP: 'Airtel Payments Bank',
    FINO: 'Fino Payments Bank',
    IPOS: 'India Post Payments Bank',
    NSPB: 'NSDL Payments Bank',
    JIOP: 'Jio Payments Bank',
    // ---- Foreign banks ----
    SCBL: 'Standard Chartered Bank',
    CITI: 'Citibank',
    HSBC: 'HSBC Bank',
    DEUT: 'Deutsche Bank',
    DBSS: 'DBS Bank India',
    // ---- Verified 2026-06-12 against the RBI-derived IFSC dataset ----
    JAKA: 'Jammu and Kashmir Bank',
    IDFB: 'IDFC FIRST Bank',
    NTBL: 'Nainital Bank',
    ABHY: 'Abhyudaya Co-operative Bank',
    TJSB: 'TJSB Sahakari Bank',
    BCBM: 'Bharat Co-operative Bank (Mumbai)',
    GSCB: 'Gujarat State Co-operative Bank',
    TSAB: 'Telangana State Co-operative Apex Bank',
    KSBK: 'Kerala State Co-operative Bank',
    RMGB: 'Rajasthan Marudhara Gramin Bank',
    MAHG: 'Maharashtra Gramin Bank',
    PKGB: 'Karnataka Gramin Bank',
    KLGB: 'Kerala Gramin Bank',
  };

  test('every prefix maps to exactly its expected bank (no additions, removals, or flips)', () => {
    expect(IFSC_BANK_MAP).toEqual(EXPECTED_MAP);
  });

  test('every prefix is a valid 4-letter RBI bank code in uppercase', () => {
    for (const prefix of Object.keys(IFSC_BANK_MAP)) {
      expect(prefix).toMatch(/^[A-Z]{4}$/);
    }
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
