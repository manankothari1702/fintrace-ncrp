'use strict';

/**
 * FinTrace NCRP — draft lien-request email generator.
 *
 * Turns the lien worksheet (one row per fraud-linked account) into one formal,
 * RBI/MHA-formatted lien-request letter **per bank** (FR-26), grouping every
 * flagged account at that bank into a single letter. Each letter is a plain-text
 * body + subject the Investigating Officer copy-pastes into their email client —
 * the tool never sends mail (police policy forbids unattended dispatch).
 *
 * Format follows FR-27 / the I4C SOP:
 *   • Subject naming the case acknowledgement number.
 *   • Reference to the NCRP complaint and total disputed amount.
 *   • A tabular list of accounts (A/c no, IFSC, amount).
 *   • A statutory citation block — Section 102 Cr.P.C. read with the IT Act,
 *     2000 (the mandatory C-01 constraint).
 *   • Three explicit requests: place a lien, share KYC, confirm within 24 hours.
 *   • An officer signature block (Investigating Officer, Cyber Crime Cell).
 *
 * The returned objects are shaped for `queries.insertDraftEmail` — `account_list`
 * is an array of account numbers (the query helper JSON-stringifies it).
 *
 * @module backend/src/utils/emailGenerator
 */

// ─── Officer signature defaults ──────────────────────────────────────
//
// This .js build has no `settings`/officer-profile table, so the signature
// block is rendered with fill-in placeholders. A caller that does know the
// officer can override any field via `caseInfo.officer`.

/** @type {Readonly<Record<string,string>>} */
const DEFAULT_OFFICER = Object.freeze({
  name:           '[Investigating Officer Name]',
  designation:    'Investigating Officer',
  unit:           'Cyber Crime Cell',
  police_station: '[Police Station]',
  phone:          '[Contact Number]',
  email:          '[Official Email ID]',
});

// ─── Formatting helpers ──────────────────────────────────────────────

/**
 * Coerce any value to a finite number, defaulting to 0.
 * @param {unknown} v
 * @returns {number}
 */
function num(v) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Format a rupee amount with Indian digit grouping and an ASCII "Rs." prefix
 * (no ₹ glyph — it survives every email client and the PDF's core fonts).
 *
 * @param {unknown} value
 * @returns {string} e.g. 123456.5 → "Rs. 1,23,456.50"
 */
function formatMoney(value) {
  const v = num(value);
  const neg = v < 0;
  const [intPart, decPart] = Math.abs(v).toFixed(2).split('.');
  let last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  if (rest !== '') last3 = ',' + last3;
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
  return `${neg ? '-' : ''}Rs. ${grouped}.${decPart}`;
}

/**
 * Format an ISO instant as a human "DD Mon YYYY" label, in UTC for
 * determinism. Returns an em dash for missing dates.
 *
 * @param {unknown} iso
 * @returns {string}
 */
function formatDate(iso) {
  if (iso === null || iso === undefined || iso === '') return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(d.getUTCDate()).padStart(2, '0')} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Right-pad to a fixed width (no truncation — alignment is best-effort). */
const padR = (s, n) => {
  const str = String(s ?? '');
  return str.length >= n ? str : str + ' '.repeat(n - str.length);
};

/** Left-pad to a fixed width. */
const padL = (s, n) => {
  const str = String(s ?? '');
  return str.length >= n ? str : ' '.repeat(n - str.length) + str;
};

/**
 * Sanitise an identifier that originates from the uploaded Excel before it is
 * embedded into a letter body. The letter is plain text in our pipeline, but
 * many mail clients auto-detect HTML, and some downstream tooling will render
 * the body in a web UI — so we strip anything that could escape into markup
 * or shell out via control characters.
 *
 *   • drop control chars, angle brackets, ampersand, quote, backtick;
 *   • collapse internal whitespace;
 *   • cap length to 64 chars (Indian bank a/c numbers are ≤ 20 digits + IFSC).
 *
 * @param {unknown} v
 * @returns {string}
 */
function sanitizeIdentifier(v) {
  if (v === null || v === undefined) return '';
  const raw = String(v);
  // eslint-disable-next-line no-control-regex
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > 64 ? cleaned.slice(0, 64) : cleaned;
}

// ─── Body builders ───────────────────────────────────────────────────

// Fixed column widths for the monospace account table. The PDF renders this
// body in Courier so the columns line up; in proportional email clients the
// spacing is approximate but still readable.
const COL = Object.freeze({ sno: 5, account: 22, ifsc: 14, amount: 20 });

/**
 * Build the subject line (FR-27 / task spec).
 * @param {string|null} ackNo
 * @returns {string}
 */
function buildSubject(ackNo) {
  return `URGENT: Lien Request on Fraud-linked Accounts - Cyber Crime Case ${ackNo || 'N/A'}`;
}

/**
 * Render the fixed-width account table that lists every flagged account at
 * one bank with its IFSC and the amount involved.
 *
 * @param {Array<{ account_no: string, ifsc_code: string|null, amount: number }>} accounts
 * @param {number} total
 * @returns {string}
 */
function buildAccountTable(accounts, total) {
  const sep =
    `  ${'-'.repeat(COL.sno)}  ${'-'.repeat(COL.account)}  ` +
    `${'-'.repeat(COL.ifsc)}  ${'-'.repeat(COL.amount)}`;

  const header =
    `  ${padR('S.No', COL.sno)}  ${padR('Account Number', COL.account)}  ` +
    `${padR('IFSC Code', COL.ifsc)}  ${padL('Amount Involved', COL.amount)}`;

  const lines = accounts.map((a, i) =>
    `  ${padR(i + 1, COL.sno)}  ${padR(a.account_no || '—', COL.account)}  ` +
    `${padR(a.ifsc_code || '—', COL.ifsc)}  ${padL(formatMoney(a.amount), COL.amount)}`
  );

  const totalLine =
    `  ${padR('', COL.sno)}  ${padR('', COL.account)}  ` +
    `${padR('TOTAL', COL.ifsc)}  ${padL(formatMoney(total), COL.amount)}`;

  return [header, sep, ...lines, sep, totalLine].join('\n');
}

/**
 * Build the full plain-text letter body for one bank.
 *
 * @param {{
 *   bankName: string,
 *   accounts: Array<{ account_no: string, ifsc_code: string|null, amount: number }>,
 *   ackNo: string|null,
 *   complaintDateStr: string,
 *   totalDisputed: number,
 *   officer: Record<string,string>,
 *   letterDateStr: string,
 * }} ctx
 * @returns {string}
 */
function buildBody(ctx) {
  const { bankName, accounts, ackNo, complaintDateStr, totalDisputed, officer, letterDateStr } = ctx;
  const ref = ackNo || 'N/A';
  const n = accounts.length;
  const accountWord = n === 1 ? 'account' : 'accounts';

  return [
    'To,',
    'The Nodal Officer / Principal Officer,',
    bankName,
    '',
    `Date: ${letterDateStr}`,
    '',
    `Subject: ${buildSubject(ackNo)}`,
    '',
    `Reference: NCRP Acknowledgement No. ${ref}, complaint dated ${complaintDateStr}.`,
    '',
    'Respected Sir / Madam,',
    '',
    `    This office is investigating a cyber-financial fraud reported on the`,
    `National Cyber Crime Reporting Portal (NCRP) vide Acknowledgement No. ${ref}.`,
    `Examination of the bank transaction trail has established that the following`,
    `${n} ${accountWord} maintained with ${bankName} received funds that are the`,
    `proceeds of the said offence, aggregating to ${formatMoney(totalDisputed)}:`,
    '',
    buildAccountTable(accounts, totalDisputed),
    '',
    `    In exercise of the powers under Section 102 of the Code of Criminal`,
    `Procedure, 1973 (Cr.P.C.) read with the Information Technology Act, 2000,`,
    `you are hereby requested to take the following action on priority:`,
    '',
    `    1. PLACE A LIEN on / freeze the disputed amount lying in the above`,
    `       ${accountWord} with immediate effect, to prevent further dissipation`,
    `       of the fraud proceeds.`,
    `    2. SHARE the complete KYC documents, account-opening form, registered`,
    `       mobile number, email, and the statement of account from`,
    `       ${complaintDateStr} to date.`,
    `    3. CONFIRM the action taken to this office within 24 (twenty-four) hours`,
    `       of receipt of this communication, quoting the above reference number.`,
    '',
    `    This requisition is issued under Section 102 Cr.P.C. (power to seize`,
    `property suspected to be the proceeds of crime) read with the provisions of`,
    `the Information Technology Act, 2000. Non-compliance may attract action under`,
    `the applicable law. Your prompt cooperation is solicited in the interest of`,
    `investigation and expeditious recovery of the defrauded amount.`,
    '',
    'Yours faithfully,',
    '',
    officer.name,
    officer.designation,
    officer.unit,
    officer.police_station,
    `Phone: ${officer.phone}    Email: ${officer.email}`,
    '',
    '----------------------------------------------------------------------',
    'This is a system-generated draft from FinTrace NCRP | MINT. Verify the',
    'details and obtain the competent authority\'s signature before dispatch.',
  ].join('\n');
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Generate one draft lien-request email per bank from the lien worksheet.
 *
 * Accounts are grouped by `bank_name`; accounts with no bank name fall under
 * "Unknown Bank" so they are never silently dropped. The per-account amount is
 * read from whichever of these fields is present (so both analyzer
 * `lien_calculation` rows and persisted `lien_records` rows work):
 * `lien_amount`, `lien_eligible_amount`, `disputed_amount`, `recoverableAmount`.
 *
 * @param {number} reportId - The owning ncrp_reports id (stamped on each email).
 * @param {ReadonlyArray<Record<string, unknown>>} lienAccounts - Lien worksheet
 *   rows. Each should carry `account_no`, `bank_name`, an IFSC (`ifsc_code` or
 *   `ifsc`), and an amount field as above.
 * @param {{
 *   ack_no?: string|null,
 *   complaint_date?: string|null,
 *   total_disputed_amount?: number|null,
 *   officer?: Partial<typeof DEFAULT_OFFICER>,
 * }} [caseInfo={}] - Case context merged into every letter.
 * @returns {Array<{
 *   report_id: number,
 *   bank_name: string,
 *   subject: string,
 *   body: string,
 *   account_list: string[],
 *   status: 'draft',
 * }>} One email object per bank, sorted by bank name.
 *
 * @example
 *   const emails = generateDraftEmails(7, result.lien_calculation, {
 *     ack_no: 'NCRP202612345678',
 *     complaint_date: '2026-05-20T10:30:00.000Z',
 *   });
 *   //   emails[0].subject → "URGENT: Lien Request ... Case NCRP202612345678"
 */
function generateDraftEmails(reportId, lienAccounts, caseInfo = {}) {
  const officer = { ...DEFAULT_OFFICER, ...(caseInfo.officer || {}) };
  const ackNo = caseInfo.ack_no ? String(caseInfo.ack_no).trim() : null;
  const complaintDateStr = formatDate(caseInfo.complaint_date);
  const letterDateStr = formatDate(new Date().toISOString());

  // Group accounts by bank, preserving first-seen order within each bank.
  // The grouping KEY is the bank name lower-cased (whitespace is already
  // collapsed by sanitizeIdentifier), so pure case/spacing variants of one bank
  // — e.g. "Bank of Baroda (Including …)" and "(including …)" — fold into ONE
  // letter instead of two. Normalisation is deliberately conservative (case +
  // whitespace only): genuinely different names keep their own letter. The
  // first-seen original spelling is kept for display in the letter heading.
  /** @type {Map<string, Array<{ account_no: string, ifsc_code: string|null, amount: number }>>} */
  const byBank = new Map();
  /** @type {Map<string, string>} normalised key → first-seen display name. */
  const bankDisplay = new Map();
  for (const acc of Array.isArray(lienAccounts) ? lienAccounts : []) {
    if (!acc) continue;
    // bank_name comes from the same uploaded Excel cells as account_no — same
    // sanitisation applies (control chars / quotes / brackets stripped).
    const bankName = sanitizeIdentifier(acc.bank_name) || 'Unknown Bank';
    const bankKey = bankName.toLowerCase();
    const amount = num(
      acc.lien_amount ?? acc.lien_eligible_amount ?? acc.disputed_amount ?? acc.recoverableAmount
    );
    if (!byBank.has(bankKey)) { byBank.set(bankKey, []); bankDisplay.set(bankKey, bankName); }
    byBank.get(bankKey).push({
      // Account numbers + IFSC come from untrusted Excel cells. Strip anything
      // that could break monospace alignment, escape into HTML, or smuggle
      // control sequences into a mail-client renderer.
      account_no: sanitizeIdentifier(acc.account_no),
      ifsc_code: sanitizeIdentifier(acc.ifsc_code ?? acc.ifsc) || null,
      amount,
    });
  }

  const emails = [];
  for (const bankKey of [...byBank.keys()].sort()) {
    const accounts = byBank.get(bankKey);
    const bankName = bankDisplay.get(bankKey);
    const totalDisputed = accounts.reduce((s, a) => s + a.amount, 0);
    emails.push({
      report_id: reportId,
      bank_name: bankName,
      subject: buildSubject(ackNo),
      body: buildBody({
        bankName, accounts, ackNo, complaintDateStr, totalDisputed, officer, letterDateStr,
      }),
      account_list: accounts.map((a) => a.account_no),
      status: 'draft',
    });
  }
  return emails;
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  generateDraftEmails,
  DEFAULT_OFFICER,
  // Exposed for unit tests; not part of the stable contract.
  _internals: Object.freeze({
    buildSubject,
    buildBody,
    buildAccountTable,
    formatMoney,
    formatDate,
    sanitizeIdentifier,
  }),
};
