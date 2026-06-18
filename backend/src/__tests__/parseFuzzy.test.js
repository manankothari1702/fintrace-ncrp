'use strict';

/**
 * Unit tests for the standalone fuzzy resolver (backend/src/parsers/parseFuzzy.js).
 *
 * These exercise the module in ISOLATION — no workbook, no parser, no DB. They
 * pin the court-facing safety contract:
 *   • exact/near-identical input scores 1 (the fuzzy tier degrades smoothly from
 *     the exact + loose tiers it sits behind);
 *   • a high-confidence typo resolves AND carries a confidence >= the 0.85 floor;
 *   • a below-threshold or ambiguous input resolves to null (caller fails loud);
 *   • the resolver's category enum + canonical fields stay in lock-step with the
 *     parser (drift guard).
 */

process.env.NODE_ENV = 'test';

const F = require('../parsers/parseFuzzy');
const { _internals } = require('../parsers/ncrpParser');
const HEADER_SYNONYMS = require('../config/header_synonyms.json');

const {
  diceCoefficient, levenshtein, levenshteinRatio, similarity, normalizeLoose,
  bestMatch, resolveColumnFuzzy, resolveSheetCategoryFuzzy,
  FUZZY_THRESHOLD, AMBIGUITY_MARGIN, SHEET_CATEGORY, COLUMN_TARGETS, SHEET_TARGETS,
} = F;

// ─── normalizeLoose ──────────────────────────────────────────────────

describe('normalizeLoose', () => {
  test('lowercases, trims, collapses whitespace, strips punctuation', () => {
    expect(normalizeLoose('  Transaction  Amount ')).toBe('transactionamount');
    expect(normalizeLoose('Account No./ (Wallet /PG/PA) Id')).toBe('accountnowalletpgpaid');
    expect(normalizeLoose('Layer-No.')).toBe('layerno');
  });

  test('null / undefined / non-string → empty string', () => {
    expect(normalizeLoose(null)).toBe('');
    expect(normalizeLoose(undefined)).toBe('');
    expect(normalizeLoose(123)).toBe('123');
  });

  test('strips a leading BOM', () => {
    expect(normalizeLoose('﻿Amount')).toBe('amount');
  });

  test('preserves Devanagari letters', () => {
    expect(normalizeLoose('विवादित राशि')).toBe('विवादितराशि');
  });
});

// ─── diceCoefficient ─────────────────────────────────────────────────

describe('diceCoefficient', () => {
  test('identical (after normalisation) → 1', () => {
    expect(diceCoefficient('Transaction Amount', 'transaction  amount')).toBe(1);
    expect(diceCoefficient('', '')).toBe(1);
  });

  test('one side empty, other non-empty → 0', () => {
    expect(diceCoefficient('', 'amount')).toBe(0);
    expect(diceCoefficient('amount', '')).toBe(0);
  });

  test('sub-2-char differing inputs → 0 (no shared bigram possible)', () => {
    expect(diceCoefficient('a', 'b')).toBe(0);
  });

  test('disjoint strings → low score', () => {
    expect(diceCoefficient('atm', 'beneficiary')).toBeLessThan(0.3);
  });

  test('symmetric', () => {
    const a = diceCoefficient('Disputed Amount', 'Disputd Amount');
    const b = diceCoefficient('Disputd Amount', 'Disputed Amount');
    expect(a).toBe(b);
  });

  test('bounded in [0,1]', () => {
    for (const [a, b] of [['x', 'y'], ['abc', 'abc'], ['transaction', 'transcation']]) {
      const s = diceCoefficient(a, b);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  test('rejects a mid-word transposition at the 0.85 floor (Dice alone is conservative)', () => {
    // Documents WHY the combined metric also uses Levenshtein: Dice scores this
    // realistic OCR transposition below the floor on its own.
    expect(diceCoefficient('Transcation Amount', 'Transaction Amount')).toBeLessThan(FUZZY_THRESHOLD);
  });
});

// ─── levenshtein / levenshteinRatio ──────────────────────────────────

describe('levenshtein', () => {
  test('distance basics', () => {
    expect(levenshtein('abc', 'abc')).toBe(0);
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('kitten', 'sitting')).toBe(3);
  });

  test('ratio: equal-after-normalise → 1, empty pair → 1', () => {
    expect(levenshteinRatio('IFSC Code', 'ifsc  code')).toBe(1);
    expect(levenshteinRatio('', '')).toBe(1);
  });

  test('ratio rescues a single transposition above the floor where Dice does not', () => {
    expect(levenshteinRatio('Transcation Amount', 'Transaction Amount'))
      .toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
  });
});

// ─── similarity (max of dice + lev) ──────────────────────────────────

describe('similarity', () => {
  test('is the max of dice and levenshtein-ratio', () => {
    for (const [a, b] of [['Transcation Amount', 'Transaction Amount'], ['Bank Beneficiary', 'Beneficiary Bank']]) {
      expect(similarity(a, b)).toBe(Math.max(diceCoefficient(a, b), levenshteinRatio(a, b)));
    }
  });

  test('reordering is rescued by the Dice component', () => {
    // Lev-ratio is poor on a block move; Dice keeps bigram overlap high.
    expect(levenshteinRatio('Bank Beneficiary', 'Beneficiary Bank')).toBeLessThan(0.6);
    expect(similarity('Bank Beneficiary', 'Beneficiary Bank')).toBeGreaterThan(0.8);
  });

  test('bounded in [0,1] and symmetric', () => {
    expect(similarity('foo', 'bar')).toBeGreaterThanOrEqual(0);
    expect(similarity('foo', 'bar')).toBeLessThanOrEqual(1);
    expect(similarity('a b c', 'c b a')).toBe(similarity('c b a', 'a b c'));
  });
});

// ─── bestMatch (threshold + ambiguity guard) ─────────────────────────

describe('bestMatch', () => {
  const targets = [
    { label: 'transaction amount', value: 'transaction_amount' },
    { label: 'transaction date', value: 'transaction_date' },
    { label: 'disputed amount', value: 'disputed_amount' },
  ];

  test('returns the clear winner with its confidence', () => {
    const m = bestMatch('Dispute Amount', targets);
    expect(m).not.toBeNull();
    expect(m.value).toBe('disputed_amount');
    expect(m.confidence).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
  });

  test('a candidate near two DIFFERENT canonical values is refused (prefix collision)', () => {
    // "transaction amt" sits close to both "transaction amount" and
    // "transaction date" via the shared prefix — the guard refuses to guess.
    expect(bestMatch('Transaction Amt', targets)).toBeNull();
  });

  test('returns null when nothing clears the threshold', () => {
    expect(bestMatch('Completely Unrelated Field', targets)).toBeNull();
  });

  test('empty candidate or empty target list → null', () => {
    expect(bestMatch('', targets)).toBeNull();
    expect(bestMatch('anything', [])).toBeNull();
  });

  test('refuses an ambiguous match: two DIFFERENT values within the margin → null', () => {
    const ambiguous = [
      { label: 'aaaaaaaab', value: 'A' },
      { label: 'aaaaaaaac', value: 'B' },
    ];
    // Equidistant from both (one substitution each) → both clear 0.85 and tie.
    expect(bestMatch('aaaaaaaaa', ambiguous)).toBeNull();
  });

  test('two close targets of the SAME value are NOT ambiguous (resolves)', () => {
    const sameValue = [
      { label: 'aaaaaaaab', value: 'A' },
      { label: 'aaaaaaaac', value: 'A' },
    ];
    const m = bestMatch('aaaaaaaaa', sameValue);
    expect(m).not.toBeNull();
    expect(m.value).toBe('A');
  });

  test('respects a caller-supplied threshold', () => {
    expect(bestMatch('Transaction Amt', targets, { threshold: 0.999 })).toBeNull();
  });
});

// ─── resolveColumnFuzzy ──────────────────────────────────────────────

describe('resolveColumnFuzzy', () => {
  const RESCUED = [
    ['Transcation Amount', 'transaction_amount'],   // transposition (Lev rescue)
    ['Disputd Amount', 'disputed_amount'],           // dropped char
    ['Acount No./(Wallet/PG/PA) Id', 'victim_account'], // typo in long header
    ['IFSC Cod', 'ifsc_code'],                       // truncation
    ['Beneficiary Bank Naem', 'beneficiary_bank'],   // transposition near end
    ['Acknowledgment Numbr', 'ack_no'],              // dropped char
    ['Layr No', 'layer_no'],                         // dropped char (borderline)
  ];

  test.each(RESCUED)('resolves "%s" → %s above the floor', (header, canonical) => {
    const r = resolveColumnFuzzy(header);
    expect(r).not.toBeNull();
    expect(r.canonical).toBe(canonical);
    expect(r.confidence).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
    expect(r.confidence).toBeLessThanOrEqual(1);
  });

  test.each([
    ['Branch Manager'],
    ['Officer Remarks Section XYZ'],
    ['Nominee Name'],
    ['Foobar'],
    [''],
    [null],
  ])('returns null for unrelated / blank header %p', (header) => {
    expect(resolveColumnFuzzy(header)).toBeNull();
  });

  test('every resolution carries a confidence at or above the floor', () => {
    for (const [h] of RESCUED.map((x) => [x[0]])) {
      const r = resolveColumnFuzzy(h);
      if (r) expect(r.confidence).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
    }
  });
});

// ─── resolveSheetCategoryFuzzy ───────────────────────────────────────

describe('resolveSheetCategoryFuzzy', () => {
  test.each([
    ['Money Transfor to', SHEET_CATEGORY.TRANSFER],
    ['Withdrawl Through ATM', SHEET_CATEGORY.ATM],
    ['Withdrawal Through POSS', SHEET_CATEGORY.POS],
    ['Transactns put on hold', SHEET_CATEGORY.HOLD],
    ['Old Transactons', SHEET_CATEGORY.OLD_TRANSACTION],
  ])('resolves sheet "%s" → %s', (name, category) => {
    const r = resolveSheetCategoryFuzzy(name);
    expect(r).not.toBeNull();
    expect(r.category).toBe(category);
    expect(r.confidence).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
  });

  test.each([
    ['Cover Page'],
    ['Summary'],
    ['Notes'],
    ['Annexure'],
    ['Index'],
  ])('returns null for a non-channel sheet name %p (never invents a channel)', (name) => {
    expect(resolveSheetCategoryFuzzy(name)).toBeNull();
  });
});

// ─── Drift guards: stay in lock-step with the parser ─────────────────

describe('consistency with ncrpParser', () => {
  test('SHEET_CATEGORY enum matches the parser exactly', () => {
    expect(SHEET_CATEGORY).toEqual(_internals.SHEET_CATEGORY);
  });

  test('every fuzzy sheet target resolves to a real parser category', () => {
    const valid = new Set(Object.values(_internals.SHEET_CATEGORY));
    for (const t of SHEET_TARGETS) expect(valid.has(t.value)).toBe(true);
  });

  test('every fuzzy column target resolves to a real canonical field', () => {
    const canonical = new Set(_internals.CANONICAL_FIELDS);
    for (const t of COLUMN_TARGETS) expect(canonical.has(t.value)).toBe(true);
  });

  test('column targets are built from the same synonym source the parser uses', () => {
    const synonymKeys = new Set(Object.keys(HEADER_SYNONYMS));
    const targetValues = new Set(COLUMN_TARGETS.map((t) => t.value));
    for (const v of targetValues) expect(synonymKeys.has(v)).toBe(true);
  });
});

// ─── Thresholds are sane constants ───────────────────────────────────

describe('thresholds', () => {
  test('FUZZY_THRESHOLD is the spec floor (0.85)', () => {
    expect(FUZZY_THRESHOLD).toBe(0.85);
  });
  test('AMBIGUITY_MARGIN is a small positive gap', () => {
    expect(AMBIGUITY_MARGIN).toBeGreaterThan(0);
    expect(AMBIGUITY_MARGIN).toBeLessThan(0.5);
  });
});
