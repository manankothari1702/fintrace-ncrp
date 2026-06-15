'use strict';

/**
 * ifscBankResolver.js — FinTrace NCRP
 * -----------------------------------------------------------------------------
 * Authoritative bank-name resolution for NCRP trail accounts.
 *
 * WHY THIS EXISTS
 * The raw NCRP "Bank/FIs" text column is unreliable and, in FinTrace's prior
 * pipeline, the bank name displayed on Section 102 lien letters did not match
 * the account's actual IFSC. Example from case 32712250107145:
 *     account 00000005906495023, IFSC CBIN0282138  -> Central Bank of India
 *     FinTrace letter addressed it to ............... Union Bank of India  (WRONG)
 * A lien letter sent to the wrong bank does not freeze anything.
 *
 * THE RULE
 *  1. If a syntactically valid IFSC is present, the FIRST FOUR CHARACTERS are
 *     authoritative for the bank. Use the IFSC-derived name.
 *  2. If the IFSC-derived name and the raw text disagree, still use the IFSC
 *     name but raise a data-quality flag (IFSC_TEXT_MISMATCH) for the IO.
 *  3. If there is no valid IFSC (wallets / PA / PG ids such as Paytm, Mobikwik,
 *     CRED, PINE LABS), fall back to the raw text — that IS the correct entity
 *     to serve notice on — and flag it (NO_IFSC) so it is reviewed.
 *  4. If the IFSC prefix is unknown to the map, fall back to text and flag
 *     (UNKNOWN_IFSC_PREFIX) so the map can be extended.
 *
 * Pure, dependency-free, synchronous. CommonJS (matches the Node/Express
 * backend). An ESM re-export is provided at the bottom comment if needed.
 */

// -----------------------------------------------------------------------------
// IFSC 4-letter prefix -> canonical bank name.
//
// PROVENANCE: every entry derives from the RBI IFSC directory — the first four
// characters of an IFSC are the RBI-assigned bank code, the single
// authoritative basis for this map. Names use the post-merger consolidated
// naming that NCRP/RBI use today, so the label on the lien letter matches the
// institution that actually holds the account.
//
// THIS MAP FAILS SILENTLY if an entry is wrong (a confident wrong bank name on
// a lien letter, with no flag), so it is pinned entry-for-entry by a
// regression test (ifscBankResolver.test.js "IFSC_BANK_MAP regression
// snapshot"). ANY edit here must update that snapshot deliberately — and only
// with the RBI directory in hand. Unknown prefixes are flagged
// (UNKNOWN_IFSC_PREFIX), never guessed.
// -----------------------------------------------------------------------------
const IFSC_BANK_MAP = {
  // ---- Public sector banks (post-2020 consolidation) ----
  SBIN: 'State Bank of India',
  CBIN: 'Central Bank of India',
  BKID: 'Bank of India',
  UCBA: 'UCO Bank',
  MAHB: 'Bank of Maharashtra',
  IOBA: 'Indian Overseas Bank',
  PSIB: 'Punjab & Sind Bank',
  // Bank of Baroda group (BoB + Vijaya + Dena)
  BARB: 'Bank of Baroda (including Vijaya Bank and Dena Bank)',
  VIJB: 'Bank of Baroda (including Vijaya Bank and Dena Bank)',
  DENA: 'Bank of Baroda (including Vijaya Bank and Dena Bank)',
  // Punjab National Bank group (PNB + OBC + United Bank of India)
  PUNB: 'Punjab National Bank (including Oriental Bank of Commerce and United Bank of India)',
  ORBC: 'Punjab National Bank (including Oriental Bank of Commerce and United Bank of India)',
  UTBI: 'Punjab National Bank (including Oriental Bank of Commerce and United Bank of India)',
  // Union Bank group (Union + Andhra + Corporation)
  UBIN: 'Union Bank of India (including Andhra Bank and Corporation Bank)',
  ANDB: 'Union Bank of India (including Andhra Bank and Corporation Bank)',
  CORP: 'Union Bank of India (including Andhra Bank and Corporation Bank)',
  // Canara group (Canara + Syndicate)
  CNRB: 'Canara Bank',
  SYNB: 'Canara Bank',
  // Indian Bank group (Indian Bank + Allahabad Bank)
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
  JSBP: "Janata Sahakari Bank",

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

  // ---- Private / old-generation banks observed in real NCRP trails ----
  // Each entry below verified 2026-06-12 against the RBI IFSC directory (via
  // the RBI-derived dataset at ifsc.razorpay.com) using a real IFSC observed
  // in a gold case; the sample IFSC is recorded per entry.
  JAKA: 'Jammu and Kashmir Bank',             // verified: JAKA0HIDYAL
  IDFB: 'IDFC FIRST Bank',                    // verified: IDFB0040101
  NTBL: 'Nainital Bank',                      // verified: NTBL0AFZ162

  // ---- Co-operative banks ----
  ABHY: 'Abhyudaya Co-operative Bank',        // verified: ABHY0065016
  TJSB: 'TJSB Sahakari Bank',                 // verified: TJSB0000073
  // RBI directory lists "Bharat Co-operative Bank"; "(Mumbai)" is part of the
  // registered name (Bharat Co-operative Bank (Mumbai) Ltd) and kept for
  // letter clarity. sameBank() strips parentheticals, so comparisons agree.
  BCBM: 'Bharat Co-operative Bank (Mumbai)',  // verified: BCBM0000041
  GSCB: 'Gujarat State Co-operative Bank',    // verified: GSCB0PDC019 (DCCBs route on the apex bank's prefix)
  TSAB: 'Telangana State Co-operative Apex Bank', // verified: TSAB0020040
  KSBK: 'Kerala State Co-operative Bank',     // verified: KSBK0001328

  // ---- Regional rural banks (common in Rajasthan NCRP cases) ----
  // Note: RRBs frequently route on sponsor-bank IFSC prefixes (e.g. INDB/BARB).
  // Where a dedicated RRB prefix exists, add it here. Otherwise the sponsor
  // prefix resolves to the sponsor bank, which is still the correct freeze
  // target operationally.
  RMGB: 'Rajasthan Marudhara Gramin Bank',    // verified: RMGB0000253
  MAHG: 'Maharashtra Gramin Bank',            // verified: MAHG0004307
  PKGB: 'Karnataka Gramin Bank',              // verified: PKGB0010536 (ex Pragathi Krishna Gramin Bank)
  KLGB: 'Kerala Gramin Bank',                 // verified: KLGB0040683

  // Deliberately NOT mapped: PPIW (prepaid-instrument/wallet pseudo-IFSC) and
  // prefixes whose institution could not be verified with certainty (SMNB,
  // UNBA, STCB) — those stay flagged UNKNOWN_IFSC_PREFIX for IO review rather
  // than risking a confidently-wrong name on a lien letter.
};

// Aliases / known-bad text labels that some PA/PG exports emit. Used ONLY for
// normalising the raw text before comparison, never to override a valid IFSC.
const TEXT_ALIASES = {
  'others': null,
  'other': null,
  'na': null,
  '': null,
};

const VALID_IFSC = /^[A-Za-z]{4}0[A-Za-z0-9]{6}$/;

const FLAGS = Object.freeze({
  NONE: null,
  IFSC_TEXT_MISMATCH: 'IFSC_TEXT_MISMATCH',
  NO_IFSC: 'NO_IFSC',
  INVALID_IFSC: 'INVALID_IFSC',
  UNKNOWN_IFSC_PREFIX: 'UNKNOWN_IFSC_PREFIX',
});

/** Normalise a bank name for loose comparison (case/punctuation/suffix tolerant). */
function normaliseBankName(name) {
  if (name == null) return '';
  let s = String(name).toLowerCase().trim();
  if (s in TEXT_ALIASES && TEXT_ALIASES[s] === null) return '';
  // strip merger parentheticals e.g. "(including ...)"
  s = s.replace(/\(.*?\)/g, ' ');
  // drop common, non-distinguishing tokens
  s = s.replace(/\b(bank|of|india|ltd|limited|the|payments|payment|small|finance|co-?operative)\b/g, ' ');
  s = s.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

/** Are two bank names "the same institution" for mismatch detection? */
function sameBank(a, b) {
  const na = normaliseBankName(a);
  const nb = normaliseBankName(b);
  if (!na || !nb) return true; // one side blank/"Others" -> can't contradict
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Extract a clean uppercase IFSC if syntactically valid, else null. */
function cleanIfsc(ifsc) {
  if (ifsc == null) return null;
  const s = String(ifsc).trim().toUpperCase();
  return VALID_IFSC.test(s) ? s : null;
}

/**
 * Resolve the authoritative bank for an account row.
 *
 * @param {object} input
 * @param {string} [input.rawBank]  raw "Bank/FIs" text column value
 * @param {string} [input.ifsc]     raw "Ifsc Code" column value
 * @param {string} [input.account]  account/wallet id (for diagnostics only)
 * @returns {{
 *   bank: string,            // name to print on the lien letter
 *   ifsc: string|null,       // cleaned IFSC (null if absent/invalid)
 *   source: 'IFSC'|'TEXT',   // where the name came from
 *   flag: string|null,       // data-quality flag (see FLAGS), null if clean
 *   rawBank: string,         // original text, preserved for audit
 * }}
 */
function resolveBank(input = {}) {
  const rawBank = input.rawBank == null ? '' : String(input.rawBank).trim();
  const ifsc = cleanIfsc(input.ifsc);

  // No usable IFSC -> wallet / PA / PG. Text is the correct entity to notice.
  if (!ifsc) {
    const hadSomething = input.ifsc != null && String(input.ifsc).trim() !== '';
    return {
      bank: rawBank || 'Unknown',
      ifsc: null,
      source: 'TEXT',
      flag: hadSomething ? FLAGS.INVALID_IFSC : FLAGS.NO_IFSC,
      rawBank,
    };
  }

  const prefix = ifsc.slice(0, 4).toUpperCase();
  const fromIfsc = IFSC_BANK_MAP[prefix];

  // Known prefix -> IFSC is authoritative.
  if (fromIfsc) {
    const mismatch = !sameBank(fromIfsc, rawBank);
    return {
      bank: fromIfsc,
      ifsc,
      source: 'IFSC',
      flag: mismatch ? FLAGS.IFSC_TEXT_MISMATCH : FLAGS.NONE,
      rawBank,
    };
  }

  // Unknown prefix -> keep the text but flag so the map can be extended.
  return {
    bank: rawBank || `Unknown (IFSC ${prefix})`,
    ifsc,
    source: 'TEXT',
    flag: FLAGS.UNKNOWN_IFSC_PREFIX,
    rawBank,
  };
}

/** Convenience: just the resolved name. */
function bankNameFor(rawBank, ifsc) {
  return resolveBank({ rawBank, ifsc }).bank;
}

module.exports = {
  resolveBank,
  bankNameFor,
  normaliseBankName,
  sameBank,
  cleanIfsc,
  IFSC_BANK_MAP,
  FLAGS,
  VALID_IFSC,
};

// ESM consumers:  import pkg from './ifscBankResolver.js'; const { resolveBank } = pkg;
