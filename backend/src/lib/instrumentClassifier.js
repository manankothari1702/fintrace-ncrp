'use strict';

/**
 * instrumentClassifier.js — FinTrace NCRP
 * -----------------------------------------------------------------------------
 * Decide whether a lien-worksheet row is an ACTIONABLE bank account (gets a
 * Section 102 Cr.P.C. freeze letter) or a non-actionable instrument that must
 * NOT be served a bank freeze notice:
 *
 *   • 'wallet' — a wallet / payment-aggregator / payment-gateway / UPI-VPA
 *     instrument (PhonePe, Paytm, Mobikwik, CRED, Ease Buzz, …; a pseudo-IFSC
 *     such as PPIW…/PHONEPE/PAYTM/NA in the IFSC cell; or a UPI VPA like
 *     name@bank). A wallet/PA cannot place a §102 lien — the nodal/escrow bank
 *     holding the funds must first be identified — so these are pulled OUT of
 *     the bank letters into a separate "verify nodal entity" section and their
 *     pseudo-IFSC is NEVER printed as a real bank IFSC.
 *
 *   • 'masked' — a real bank account whose number is masked/unresolvable in the
 *     source (XXXX, partially-X'd, "NA"). A bank cannot act on an unidentifiable
 *     account number, so these move to a separate "non-actionable" section.
 *
 *   • 'bank' — an actionable bank account: it stays in its bank's §102 letter.
 *
 * Precedence is wallet → masked → bank: the ENTITY (wallet/PA/VPA) is decided
 * first, because e.g. a Paytm "NA" row is fundamentally a wallet instrument, not
 * merely a masked bank account. A masked number at a REAL bank (UNITY SFB XXXX,
 * Bank of Baroda XXXXXXXX125989) falls to 'masked'.
 *
 * Re-uses the established wallet classification rather than inventing a new one:
 *   • WALLET_PG_PA_RE  — the analyzer's curated wallet/PA/PG name list (DQ F2).
 *   • isWalletPseudoIfsc — the ifscBankResolver PPIW… pseudo-IFSC test.
 * No new dependencies; pure and synchronous.
 *
 * @module backend/src/lib/instrumentClassifier
 */

const { isWalletPseudoIfsc } = require('./ifscBankResolver');
// Single source of truth for the curated wallet/PA/PG name list (DQ F2). The
// analyzer module is pure (no DB/side effects at load), so importing it here is
// safe and keeps the wallet vocabulary in ONE place. (Exposed under _internals.)
const { _internals: { WALLET_PG_PA_RE } } = require('../analyzers/analyzer');

/** Coerce to a finite number, defaulting to 0. */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** The lien-eligible amount, reading whichever alias the row carries. */
function lienAmountOf(acc) {
  return num(
    acc.lien_amount ?? acc.lien_eligible_amount ?? acc.disputed_amount ?? acc.recoverableAmount
  );
}

const s = (v) => (v == null ? '' : String(v));

/** A UPI VPA (e.g. "9692464349@ybl", "paulsagar1781@oksbi") — not an account. */
function isVpaAccount(account) {
  return /@/.test(s(account));
}

/** A payment-aggregator token jammed into the account cell (FPPI…, PPI…, BillNumber…). */
function isPaTokenAccount(account) {
  return /^(FPPI|PPI|BILLNUMBER)/i.test(s(account).trim());
}

/**
 * The IFSC cell holds a pseudo-IFSC / wallet rail rather than a real bank code:
 * PPIW… (valid shape, wallet PPI), a bare "NA", or a payment-app name (PHONEPE,
 * PAYTM, PINELABS, …) shoved into the IFSC column.
 */
function isPseudoIfsc(ifsc) {
  const raw = s(ifsc).trim();
  if (!raw) return false;
  if (isWalletPseudoIfsc(raw)) return true; // PPIW…
  const u = raw.toUpperCase();
  if (u === 'NA' || u === 'N/A') return true;
  return WALLET_PG_PA_RE.test(raw); // PHONEPE / PAYTM / PINELABS / … as an "IFSC"
}

/**
 * The entity name is a wallet / PA / PG (PhonePe, Paytm, Mobikwik, CRED, …) and
 * NOT a bank. Names containing "bank" (e.g. "Paytm Payments Bank", "Airtel
 * Payments Bank") are real banks and excluded — they remain actionable.
 */
function isWalletEntityName(bankName) {
  const name = s(bankName);
  if (!name) return false;
  if (/\bbank\b/i.test(name)) return false; // a (payments) bank, not a wallet
  return WALLET_PG_PA_RE.test(name);
}

/**
 * A masked / unresolvable account number a bank cannot act on: empty, a bare
 * placeholder (—, NA, NULL), or any run of two-or-more X's (the masking glyph).
 */
function isMaskedAccount(account) {
  const a = s(account).trim();
  if (a === '' || a === '—' || a === '-' || a === '.') return true;
  if (/^(N\/?A|NULL|UNDEFINED)$/i.test(a)) return true;
  if (/x{2,}/i.test(a)) return true;
  return false;
}

/**
 * Classify a single lien-worksheet row.
 *
 * @param {{ account_no?: string, ifsc_code?: string, ifsc?: string, bank_name?: string }} acc
 * @returns {'wallet'|'masked'|'bank'}
 */
function classifyInstrument(acc) {
  if (!acc) return 'bank';
  const account = s(acc.account_no).trim();
  const ifsc = acc.ifsc_code != null ? acc.ifsc_code : acc.ifsc;
  const bank = acc.bank_name;
  // 1) Wallet / PA / PG / UPI-VPA — not a freezable bank account.
  if (isVpaAccount(account) || isPaTokenAccount(account) || isPseudoIfsc(ifsc) || isWalletEntityName(bank)) {
    return 'wallet';
  }
  // 2) Masked / unresolvable account number at an otherwise-real bank.
  if (isMaskedAccount(account)) return 'masked';
  // 3) Actionable bank account.
  return 'bank';
}

/**
 * Partition a lien worksheet into the three buckets. The `bank` rows are
 * returned UNCHANGED (so the letter builder groups them exactly as before); the
 * `wallet` / `masked` rows are reshaped into display records carrying the amount
 * and an instructional note. Every input row lands in exactly one bucket, so the
 * three bucket amount-totals always sum to the full lien total (nothing dropped).
 *
 * @param {ReadonlyArray<Record<string, unknown>>} lienAccounts
 * @returns {{ bank: Array<Record<string, unknown>>,
 *   wallet: Array<{ account_no: string, bank_name: string, source_ref: string|null, amount: number, note: string }>,
 *   masked: Array<{ account_no: string, bank_name: string, ifsc_code: string|null, amount: number, note: string }> }}
 */
function partitionInstruments(lienAccounts) {
  const bank = [];
  const wallet = [];
  const masked = [];
  for (const acc of Array.isArray(lienAccounts) ? lienAccounts : []) {
    if (!acc) continue;
    const kind = classifyInstrument(acc);
    if (kind === 'bank') { bank.push(acc); continue; }
    const amount = lienAmountOf(acc);
    if (kind === 'wallet') {
      const ref = s(acc.ifsc_code != null ? acc.ifsc_code : acc.ifsc).trim();
      wallet.push({
        account_no: s(acc.account_no),
        bank_name: s(acc.bank_name) || 'Unknown',
        // The raw IFSC-cell value is preserved as a NON-IFSC reference for the
        // reviewer; it is NEVER labelled or printed as a bank IFSC.
        source_ref: ref || null,
        amount,
        note:
          'Payment instrument (wallet / PA / PG / UPI VPA), not a bank account. ' +
          'Identify the nodal/escrow bank holding these funds before issuing a ' +
          'Section 102 request; do not treat the reference above as a bank IFSC.',
      });
    } else { // masked
      masked.push({
        account_no: s(acc.account_no),
        bank_name: s(acc.bank_name) || 'Unknown',
        ifsc_code: (acc.ifsc_code != null ? s(acc.ifsc_code) : (acc.ifsc != null ? s(acc.ifsc) : null)) || null,
        amount,
        note:
          'Account number masked / unresolvable in source — obtain the full ' +
          'account number from the channel before a freeze can be actioned.',
      });
    }
  }
  wallet.sort((a, b) => b.amount - a.amount);
  masked.sort((a, b) => b.amount - a.amount);
  return { bank, wallet, masked };
}

module.exports = {
  classifyInstrument,
  partitionInstruments,
  lienAmountOf,
  // Exposed for unit tests.
  _internals: Object.freeze({
    isVpaAccount, isPaTokenAccount, isPseudoIfsc, isWalletEntityName, isMaskedAccount,
  }),
};
