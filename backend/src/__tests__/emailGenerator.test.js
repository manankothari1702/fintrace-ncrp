'use strict';

/**
 * Unit tests for backend/src/utils/emailGenerator.js.
 *
 * Covers the public `generateDraftEmails` plus the formatting / table
 * builders exported under `_internals`. Aim is to exercise the branches
 * for empty inputs, missing bank names, mixed amount-field aliases, and
 * date / money formatting edge cases.
 */

const {
  generateDraftEmails,
  DEFAULT_OFFICER,
  _internals,
} = require('../utils/emailGenerator');

const {
  formatMoney,
  formatDate,
  buildSubject,
  buildAccountTable,
  sanitizeIdentifier,
} = _internals;

// ─── formatMoney ─────────────────────────────────────────────────────

describe('formatMoney', () => {
  test('renders Indian digit grouping with Rs. prefix', () => {
    expect(formatMoney(123456.5)).toBe('Rs. 1,23,456.50');
  });

  test('negative amount keeps the minus sign in front of Rs.', () => {
    expect(formatMoney(-1000)).toBe('-Rs. 1,000.00');
  });

  test('non-finite input defaults to 0', () => {
    expect(formatMoney('not-a-number')).toBe('Rs. 0.00');
    expect(formatMoney(NaN)).toBe('Rs. 0.00');
    expect(formatMoney(null)).toBe('Rs. 0.00');
  });

  test('large values group correctly (Cr-scale)', () => {
    expect(formatMoney(12500000)).toBe('Rs. 1,25,00,000.00');
  });
});

// ─── formatDate ──────────────────────────────────────────────────────

describe('formatDate', () => {
  test('ISO date → "DD Mon YYYY"', () => {
    expect(formatDate('2024-05-20T10:30:00.000Z')).toBe('20 May 2024');
  });

  test('null/undefined/empty → em dash', () => {
    expect(formatDate(null)).toBe('—');
    expect(formatDate(undefined)).toBe('—');
    expect(formatDate('')).toBe('—');
  });

  test('un-parseable string is returned as-is', () => {
    expect(formatDate('not a date')).toBe('not a date');
  });
});

// ─── buildSubject ────────────────────────────────────────────────────

describe('buildSubject', () => {
  test('formats with ack number', () => {
    expect(buildSubject('NCRP123')).toContain('NCRP123');
  });

  test('falls back to N/A on missing ack', () => {
    expect(buildSubject(null)).toContain('N/A');
  });
});

// ─── buildAccountTable ───────────────────────────────────────────────

describe('buildAccountTable', () => {
  test('emits header, separator, rows, and a TOTAL footer', () => {
    const table = buildAccountTable(
      [{ account_no: 'A1', ifsc_code: 'ICIC0001', amount: 10000 }],
      10000
    );
    expect(table).toMatch(/S\.No/);
    expect(table).toMatch(/Account Number/);
    expect(table).toMatch(/A1/);
    expect(table).toMatch(/ICIC0001/);
    expect(table).toMatch(/TOTAL/);
  });

  test('renders em dash placeholders for missing account / IFSC', () => {
    const table = buildAccountTable(
      [{ account_no: '', ifsc_code: null, amount: 100 }],
      100
    );
    expect(table).toContain('—');
  });
});

// ─── sanitizeIdentifier edge case ────────────────────────────────────

describe('sanitizeIdentifier (extra)', () => {
  test('collapses internal whitespace (control chars stripped first)', () => {
    // The control-char stripper runs before the whitespace collapse, so
    // \t (0x09) is removed, then 3 spaces collapse to one.
    expect(sanitizeIdentifier('A   B\tC')).toBe('A BC');
  });

  test('strips quotes / backticks / ampersand', () => {
    expect(sanitizeIdentifier(`A"B'C&D\`E`)).toBe('ABCDE');
  });
});

// ─── generateDraftEmails ─────────────────────────────────────────────

describe('generateDraftEmails', () => {
  test('groups accounts by bank, producing one email per bank', () => {
    const liens = [
      { account_no: 'A1', bank_name: 'HDFC', ifsc_code: 'HDFC0001', lien_amount: 1000 },
      { account_no: 'A2', bank_name: 'HDFC', ifsc_code: 'HDFC0002', lien_amount: 2000 },
      { account_no: 'B1', bank_name: 'ICICI', ifsc_code: 'ICIC0001', lien_amount: 3000 },
    ];
    const emails = generateDraftEmails(42, liens, {
      ack_no: 'NCRP-A',
      complaint_date: '2024-03-01T00:00:00.000Z',
      total_disputed_amount: 6000,
    });
    expect(emails).toHaveLength(2);
    const banks = emails.map((e) => e.bank_name).sort();
    expect(banks).toEqual(['HDFC', 'ICICI']);

    const hdfc = emails.find((e) => e.bank_name === 'HDFC');
    expect(hdfc.account_list).toEqual(['A1', 'A2']);
    expect(hdfc.status).toBe('draft');
    expect(hdfc.subject).toContain('NCRP-A');
    expect(hdfc.body).toContain('HDFC');
    expect(hdfc.body).toContain('A1');
  });

  test('accounts with no bank name fall under "Unknown Bank"', () => {
    const emails = generateDraftEmails(1, [
      { account_no: 'X1', bank_name: null, ifsc_code: null, lien_amount: 500 },
    ]);
    expect(emails).toHaveLength(1);
    expect(emails[0].bank_name).toBe('Unknown Bank');
  });

  test('empty / non-array input → empty array', () => {
    expect(generateDraftEmails(1, null)).toEqual([]);
    expect(generateDraftEmails(1, [])).toEqual([]);
    expect(generateDraftEmails(1, undefined)).toEqual([]);
  });

  test('reads amount from any of the supported aliases', () => {
    const emails = generateDraftEmails(1, [
      { account_no: 'A', bank_name: 'X', lien_amount: 1 },
      { account_no: 'B', bank_name: 'X', lien_eligible_amount: 2 },
      { account_no: 'C', bank_name: 'X', disputed_amount: 4 },
      { account_no: 'D', bank_name: 'X', recoverableAmount: 8 },
    ]);
    expect(emails).toHaveLength(1);
    // Body should contain the sum (Rs. 15.00) somewhere.
    expect(emails[0].body).toMatch(/Rs\. 15\.00/);
  });

  test('officer signature defaults are present in every body', () => {
    const emails = generateDraftEmails(1, [
      { account_no: 'A', bank_name: 'X', lien_amount: 1 },
    ]);
    expect(emails[0].body).toContain(DEFAULT_OFFICER.designation);
    expect(emails[0].body).toContain(DEFAULT_OFFICER.unit);
  });

  test('caller-supplied officer overrides defaults', () => {
    const emails = generateDraftEmails(1, [
      { account_no: 'A', bank_name: 'X', lien_amount: 1 },
    ], {
      officer: { name: 'Insp. Sharma', phone: '99999' },
    });
    expect(emails[0].body).toContain('Insp. Sharma');
    expect(emails[0].body).toContain('99999');
  });
});
