'use strict';

/**
 * Counterparty extraction from bank-statement narration — verified against
 * REAL narration strings from the committed PNB fixtures (both formats).
 *
 * The coverage anchor (the milestone's key metric, like 96/96 was for
 * ingestion): of the fixture's 96 transactions —
 *   92 UPI + 1 IMPS + 2 NEFT + 1 INTEREST posting,
 *   95 high confidence, 0 low, 1 none (the interest posting),
 *   name 95, VPA 92, IFSC 2, phone 1, bank code 94.
 * Identical from the Excel and the PDF (whose rejoined line-wraps put stray
 * spaces inside tokens — normalised, not guessed).
 */

const path = require('path');

const {
  extractCounterparty, enrichTransactions, coverageSummary,
} = require('../parsers/bankStatement/counterparty');
const { parsePnbExcel } = require('../parsers/bankStatement/pnbExcel');
const { parsePnbPdf } = require('../parsers/bankStatement/pnbPdf');

const FIXTURES = path.join(__dirname, 'fixtures');

const NULL_FIELDS = {
  counterparty_name: null,
  counterparty_bank_code: null,
  counterparty_ifsc: null,
  counterparty_vpa: null,
  counterparty_phone: null,
};

describe('UPI extractor (real fixture narrations)', () => {
  test('debit with truncated name — captured as-is, never reconstructed', () => {
    expect(extractCounterparty('UPI/DR/360729244657/RAM BAHA/BARB/8004806574@axl/P')).toEqual({
      txn_channel: 'UPI',
      extraction_confidence: 'high',
      counterparty_name: 'RAM BAHA',
      counterparty_bank_code: 'BARB',
      counterparty_ifsc: null,
      counterparty_vpa: '8004806574@axl',
      counterparty_phone: null,
    });
  });

  test('credit with honorific + truncated VPA', () => {
    const r = extractCounterparty('UPI/CR/168797098045/Mrs Lale/IDIB/9631574663-2@yb/');
    expect(r).toMatchObject({
      txn_channel: 'UPI',
      extraction_confidence: 'high',
      counterparty_name: 'Mrs Lale',
      counterparty_bank_code: 'IDIB',
      counterparty_vpa: '9631574663-2@yb', // truncated by the bank; kept verbatim
    });
  });

  test('merchant VPA without @ is still the VPA field, not discarded', () => {
    const r = extractCounterparty('UPI/DR/296944476572/BALAJI T/HDFC/Vyapar.17569292/');
    expect(r.counterparty_vpa).toBe('Vyapar.17569292');
    expect(r.counterparty_name).toBe('BALAJI T');
    expect(r.extraction_confidence).toBe('high');
  });

  test('double-spaced name collapses; phone is NEVER inferred from a VPA local part', () => {
    const r = extractCounterparty('UPI/DR/407538323004/Mr  PRAT/UTIB/gpay-1125954981/');
    expect(r.counterparty_name).toBe('Mr PRAT');
    expect(r.counterparty_phone).toBeNull(); // digits in the VPA stay in the VPA
  });

  test('PDF wrap seam inside the VPA is de-spaced (tokens never contain whitespace)', () => {
    const r = extractCounterparty('UPI/DR/869729329503/Chhotan/YESB/paytm.s267 plo@p/P');
    expect(r.counterparty_vpa).toBe('paytm.s267plo@p');
    expect(r.extraction_confidence).toBe('high');
  });

  test('wallet/PPI issuer codes are captured raw, not mapped to bank names', () => {
    const r = extractCounterparty('UPI/DR/406982438203/Shri vis/AIRP/628Y00890Q@mair/');
    expect(r.counterparty_bank_code).toBe('AIRP');
    expect(r.counterparty_name).toBe('Shri vis');
  });

  test('malformed UPI narration → NULL fields + low confidence, nothing fabricated', () => {
    expect(extractCounterparty('UPI/xx')).toEqual({
      txn_channel: 'UPI', extraction_confidence: 'low', ...NULL_FIELDS,
    });
    // Bad bank code field: keep the valid fields, NULL the invalid one, low.
    const partial = extractCounterparty('UPI/DR/123456789012/SOMEONE/NOT-A-CODE/handle@upi/P');
    expect(partial.extraction_confidence).toBe('low');
    expect(partial.counterparty_name).toBe('SOMEONE');
    expect(partial.counterparty_bank_code).toBeNull();
    expect(partial.counterparty_vpa).toBe('handle@upi');
  });
});

describe('IMPS extractor', () => {
  test('the real fixture row: ref / phone / truncated name', () => {
    expect(extractCounterparty('IMPS-IN/616526020623/919999999999/DREAMPLU')).toEqual({
      txn_channel: 'IMPS',
      extraction_confidence: 'high',
      counterparty_name: 'DREAMPLU',
      counterparty_bank_code: null,
      counterparty_ifsc: null,
      counterparty_vpa: null,
      counterparty_phone: '919999999999',
    });
  });

  test('the PDF wrap variant ("IMPS- IN/…") extracts identically', () => {
    const r = extractCounterparty('IMPS- IN/616526020623/919999999999/DREAMPLU');
    expect(r.txn_channel).toBe('IMPS');
    expect(r.extraction_confidence).toBe('high');
    expect(r.counterparty_phone).toBe('919999999999');
  });

  test('IMPSIN/ prefix variant (as documented in other PNB exports) is accepted', () => {
    const r = extractCounterparty('IMPSIN/616526020623/919999999999/DREAMPLU');
    expect(r.txn_channel).toBe('IMPS');
    expect(r.counterparty_name).toBe('DREAMPLU');
  });

  test('non-numeric phone field → NULL phone + low confidence', () => {
    const r = extractCounterparty('IMPS-IN/616526020623/not-a-phone/DREAMPLU');
    expect(r.counterparty_phone).toBeNull();
    expect(r.counterparty_name).toBe('DREAMPLU');
    expect(r.extraction_confidence).toBe('low');
  });
});

describe('NEFT extractor — anchored IFSC, never a greedy scan', () => {
  test('the real fixture row: IFSC from the concatenated head, sender name from the tail', () => {
    expect(extractCounterparty(
      'NEFT_IN:04HDFCH01060851299HDFC0000240//HDFCH01060851299/M INTERGRAPH SYSTEMS PVT',
    )).toEqual({
      txn_channel: 'NEFT',
      extraction_confidence: 'high',
      counterparty_name: 'M INTERGRAPH SYSTEMS PVT',
      counterparty_bank_code: 'HDFC', // the IFSC's own first four letters
      counterparty_ifsc: 'HDFC0000240',
      counterparty_vpa: null,
      counterparty_phone: null,
    });
  });

  test('a greedy IFSC scan would fabricate "DFCH0106085" from the head — the anchored check must not', () => {
    // The head "…HDFCH01060851299…" CONTAINS a substring matching the IFSC
    // shape across token boundaries. Prove the extractor only accepts the
    // head-final candidate.
    const r = extractCounterparty('NEFT_IN:04HDFCH01060851299HDFC0000240//HDFCH01060851299/M INTERGRAPH SYSTEMS PVT');
    expect(r.counterparty_ifsc).toBe('HDFC0000240');
    expect(r.counterparty_ifsc).not.toBe('DFCH0106085');
  });

  test('head not ending in an IFSC → NULL IFSC + low confidence (name still captured)', () => {
    const r = extractCounterparty('NEFT_IN:99GARBAGEHEAD1234//SOMEREF/ACME TRADERS');
    expect(r.counterparty_ifsc).toBeNull();
    expect(r.counterparty_bank_code).toBeNull();
    expect(r.counterparty_name).toBe('ACME TRADERS');
    expect(r.extraction_confidence).toBe('low');
  });

  test('the PDF wrap variant (space after //) extracts identically', () => {
    const r = extractCounterparty('NEFT_IN:36HDFCH01045499382HDFC0000240// HDFCH01045499382/M INTERGRAPH SYSTEMS PVT');
    expect(r.counterparty_ifsc).toBe('HDFC0000240');
    expect(r.counterparty_name).toBe('M INTERGRAPH SYSTEMS PVT');
    expect(r.extraction_confidence).toBe('high');
  });

  test('NEFT without the // separator → all NULL + low, never positional guessing', () => {
    expect(extractCounterparty('NEFT_OUT:REF123 TO SOMEONE')).toEqual({
      txn_channel: 'NEFT', extraction_confidence: 'low', ...NULL_FIELDS,
    });
  });

  test('RTGS shares the grammar under its own channel', () => {
    const r = extractCounterparty('RTGS_IN:04SBINR52026070212345SBIN0001234//SBINR52026070212345/BIG CORP LTD');
    expect(r.txn_channel).toBe('RTGS');
    expect(r.counterparty_ifsc).toBe('SBIN0001234');
    expect(r.counterparty_name).toBe('BIG CORP LTD');
  });
});

describe('non-counterparty classification — no force-extraction', () => {
  test('the real interest posting → INTEREST, all NULL, confidence none', () => {
    expect(extractCounterparty('4563000100036079:Int.Pd:01-03-2026 to 31-05-2026')).toEqual({
      txn_channel: 'INTEREST', extraction_confidence: 'none', ...NULL_FIELDS,
    });
  });

  test('charges and cash postings classify without a counterparty', () => {
    expect(extractCounterparty('SMS ALERT CHRG FOR Q1').txn_channel).toBe('CHARGE');
    expect(extractCounterparty('CASH DEPOSIT MACHINE').txn_channel).toBe('CASH');
    expect(extractCounterparty('CASH DEPOSIT MACHINE').extraction_confidence).toBe('none');
  });

  test('unknown narration → OTHER, all NULL, none — never a fabricated counterparty', () => {
    for (const junk of ['TOTAL GIBBERISH 123', '', null, undefined, '///////', 'TRF 12345']) {
      expect(extractCounterparty(junk)).toEqual({
        txn_channel: 'OTHER', extraction_confidence: 'none', ...NULL_FIELDS,
      });
    }
  });
});

describe('coverage anchor — the whole PNB fixture, both formats', () => {
  const EXPECTED = {
    total: 96,
    byChannel: { UPI: 92, IMPS: 1, NEFT: 2, INTEREST: 1 },
    byConfidence: { high: 95, low: 0, none: 1 },
    withName: 95,
    withVpa: 92,
    withIfsc: 2,
    withPhone: 1,
    withBankCode: 94,
    nonCounterparty: 1,
  };

  test('Excel: 95/96 extracted at high confidence, 1 non-counterparty, 0 low', () => {
    const parsed = parsePnbExcel(path.join(FIXTURES, 'pnb_statement.xls'));
    const summary = coverageSummary(enrichTransactions(parsed.transactions));
    expect(summary).toEqual(EXPECTED);
  });

  test('PDF: identical coverage despite line-wrap seams (cross-format consistency)', async () => {
    const parsed = await parsePnbPdf(path.join(FIXTURES, 'pnb_statement.pdf'));
    const summary = coverageSummary(enrichTransactions(parsed.transactions));
    expect(summary).toEqual(EXPECTED);
  });

  test('enrichment never mutates the canonical fields (narration untouched)', () => {
    const parsed = parsePnbExcel(path.join(FIXTURES, 'pnb_statement.xls'));
    const enriched = enrichTransactions(parsed.transactions);
    enriched.forEach((t, i) => {
      expect(t.narration).toBe(parsed.transactions[i].narration);
      expect(t.debit_amount).toBe(parsed.transactions[i].debit_amount);
      expect(t.credit_amount).toBe(parsed.transactions[i].credit_amount);
      expect(t.balance).toBe(parsed.transactions[i].balance);
    });
    // Original rows were not decorated in place.
    expect(parsed.transactions[0].txn_channel).toBeUndefined();
  });
});
