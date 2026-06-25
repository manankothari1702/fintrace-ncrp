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

const { partitionInstruments } = require('../lib/instrumentClassifier');

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
 *   • cap length to `maxLen` chars (default 64: Indian bank a/c numbers are
 *     ≤ 20 digits + IFSC). Bank NAMES pass a far larger cap via
 *     {@link sanitizeBankName} — the 64-char cap was truncating long composite
 *     names ("Punjab National Bank (including …United Bank of India)") mid-word
 *     in the addressee and body, which the 64 cap was never meant to do.
 *
 * @param {unknown} v
 * @param {number} [maxLen=64]
 * @returns {string}
 */
function sanitizeIdentifier(v, maxLen = 64) {
  if (v === null || v === undefined) return '';
  const raw = String(v);
  // eslint-disable-next-line no-control-regex
  const cleaned = raw
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/[<>&"'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

/**
 * Sanitise a BANK NAME for a letter heading/body. Same control-char/markup
 * stripping as {@link sanitizeIdentifier}, but with a generous cap (real RBI
 * composite names run to ~85 chars), so the institution name is NEVER truncated
 * mid-word on a Section 102 letter. The cap only guards against pathological
 * input, not legitimate names.
 *
 * @param {unknown} v
 * @returns {string}
 */
function sanitizeBankName(v) {
  return sanitizeIdentifier(v, 200);
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
 * Build the structured letter MODEL for one bank — the SINGLE SOURCE OF TRUTH
 * for both the plain-text body (Copy-to-clipboard / Word-text / PDF) and the
 * on-screen + Word HTML rendering. The dispatched letter and the displayed
 * letter therefore can never diverge in wording or figures (a real risk for a
 * legal document if the prose lived in two places).
 *
 * The model carries NO date — the issue date is injected at render/copy/export
 * time (see {@link composeLetterText} / the frontend), so a stored letter never
 * looks stale. Prose fields are single flowing strings; the renderer / HTML
 * decide line-wrapping.
 *
 * @param {{
 *   bankName: string,
 *   accounts: Array<{ account_no: string, ifsc_code: string|null, amount: number }>,
 *   ackNo: string|null,
 *   complaintDateStr: string,
 *   hasComplaintDate: boolean,
 *   totalDisputed: number,
 *   officer: Record<string,string>,
 * }} ctx
 * @returns {{
 *   bank_name: string, subject: string, reference: string, salutation: string,
 *   intro: string, accounts: Array<{ sno: number, account_no: string, ifsc_code: string|null, amount: number }>,
 *   total: number, requests_intro: string, requests: string[], closing: string,
 *   signoff: string, officer: Record<string,string>, footer: string,
 * }}
 */
function buildLetterModel(ctx) {
  const { bankName, accounts, ackNo, complaintDateStr, hasComplaintDate, totalDisputed, officer } = ctx;
  const ref = ackNo || 'N/A';
  const n = accounts.length;
  const accountWord = n === 1 ? 'account' : 'accounts';

  // The NCRP export does not always carry a complaint date. When it is absent
  // the letter must not read with a bare em dash ("complaint dated —" / "from —
  // to date") — drop the clause and ask for the full statement instead.
  const statementClause = hasComplaintDate
    ? `the statement of account from ${complaintDateStr} to date.`
    : 'the complete statement of account for the affected period.';

  return {
    bank_name: bankName,
    subject: buildSubject(ackNo),
    reference: hasComplaintDate
      ? `NCRP Acknowledgement No. ${ref}, complaint dated ${complaintDateStr}.`
      : `NCRP Acknowledgement No. ${ref}.`,
    salutation: 'Respected Sir / Madam,',
    intro:
      'This office is investigating a cyber-financial fraud reported on the National ' +
      `Cyber Crime Reporting Portal (NCRP) vide Acknowledgement No. ${ref}. Examination ` +
      `of the bank transaction trail has established that the following ${n} ${accountWord} ` +
      `maintained with ${bankName} received funds that are the proceeds of the said ` +
      `offence, aggregating to ${formatMoney(totalDisputed)}:`,
    accounts: accounts.map((a, i) => ({
      sno: i + 1, account_no: a.account_no, ifsc_code: a.ifsc_code, amount: a.amount,
    })),
    total: totalDisputed,
    requests_intro:
      'In exercise of the powers under Section 102 of the Code of Criminal Procedure, ' +
      '1973 (Cr.P.C.) read with the Information Technology Act, 2000, you are hereby ' +
      'requested to take the following action on priority:',
    requests: [
      `PLACE A LIEN on / freeze the disputed amount lying in the above ${accountWord} ` +
        'with immediate effect, to prevent further dissipation of the fraud proceeds.',
      'SHARE the complete KYC documents, account-opening form, registered mobile number, ' +
        `email, and ${statementClause}`,
      'CONFIRM the action taken to this office within 24 (twenty-four) hours of receipt ' +
        'of this communication, quoting the above reference number.',
    ],
    closing:
      'This requisition is issued under Section 102 Cr.P.C. (power to seize property ' +
      'suspected to be the proceeds of crime) read with the provisions of the Information ' +
      'Technology Act, 2000. Non-compliance may attract action under the applicable law. ' +
      'Your prompt cooperation is solicited in the interest of investigation and ' +
      'expeditious recovery of the defrauded amount.',
    signoff: 'Yours faithfully,',
    officer: {
      name: officer.name, designation: officer.designation, unit: officer.unit,
      police_station: officer.police_station, phone: officer.phone, email: officer.email,
    },
    footer:
      'This is a system-generated draft from FinTrace NCRP | MINT. Verify the details ' +
      'and obtain the competent authority\'s signature before dispatch.',
  };
}

/**
 * Render the letter MODEL to the plain-text body (Copy-to-clipboard / Word-text
 * fallback / PDF). Paragraphs are single lines (mail clients soft-wrap them into
 * proper paragraphs); the account table stays a fixed-width ASCII block so it
 * aligns in a monospace view. NO "Date:" line (injected at render time).
 *
 * @param {ReturnType<typeof buildLetterModel>} m
 * @returns {string}
 */
function renderLetterText(m) {
  return [
    'To,',
    'The Nodal Officer / Principal Officer,',
    m.bank_name,
    '',
    `Subject: ${m.subject}`,
    '',
    `Reference: ${m.reference}`,
    '',
    m.salutation,
    '',
    `    ${m.intro}`,
    '',
    buildAccountTable(m.accounts, m.total),
    '',
    `    ${m.requests_intro}`,
    '',
    ...m.requests.map((r, i) => `    ${i + 1}. ${r}`),
    '',
    `    ${m.closing}`,
    '',
    m.signoff,
    '',
    m.officer.name,
    m.officer.designation,
    m.officer.unit,
    m.officer.police_station,
    `Phone: ${m.officer.phone}    Email: ${m.officer.email}`,
    '',
    '----------------------------------------------------------------------',
    m.footer,
  ].join('\n');
}

/**
 * Plain-text letter body for one bank. Thin wrapper kept on the test surface:
 * model → text. The model is the source of truth; this is one of its renderers.
 *
 * @param {Parameters<typeof buildLetterModel>[0]} ctx
 * @returns {string}
 */
function buildBody(ctx) {
  return renderLetterText(buildLetterModel(ctx));
}

/**
 * Prepend the issue date (UTC, deterministic) to a stored letter body. The body
 * itself carries no date, so a copied / Word / PDF letter always bears the date
 * it was produced — never a stale baked-in one.
 *
 * @param {string} body
 * @param {string|Date|null} [isoNow] - Instant to date-stamp with; defaults to now.
 * @returns {string}
 */
function composeLetterText(body, isoNow = null) {
  const dateStr = formatDate(isoNow || new Date().toISOString());
  return `Date: ${dateStr}\n\n${body}`;
}

// ─── Public API ──────────────────────────────────────────────────────

/**
 * Build the full draft-letter artifact set for a report: the per-bank §102
 * letters PLUS the two non-actionable sections that must NEVER be served as a
 * bank freeze notice.
 *
 * The lien worksheet is partitioned (see lib/instrumentClassifier) into:
 *   • `emails` — one §102 letter per distinct bank, over the ACTIONABLE bank
 *     accounts only. Accounts with no bank name fall under "Unknown Bank".
 *     Grouped by the full (un-truncated) bank name, case/space-folded so pure
 *     case variants of one bank collapse into a single letter.
 *   • `wallet_instruments` — wallet / PA / PG / UPI-VPA instruments pulled OUT
 *     of the letters (a wallet can't place a §102 lien). Visible, with amount
 *     and a note; the pseudo-IFSC is exposed as a non-IFSC `source_ref` only.
 *   • `masked_accounts` — real-bank accounts whose number is masked/unresolvable
 *     in the source (a bank can't act on "XXXX"/"NA"). Visible, with amount/note.
 *
 * Every lien row lands in exactly one bucket, so the three buckets' amounts
 * always reconcile to the full lien total — nothing is dropped.
 *
 * The per-account amount is read from whichever field is present (so both
 * analyzer `lien_calculation` rows and persisted `lien_records` rows work):
 * `lien_amount`, `lien_eligible_amount`, `disputed_amount`, `recoverableAmount`.
 *
 * @param {number} reportId - The owning ncrp_reports id (stamped on each email).
 * @param {ReadonlyArray<Record<string, unknown>>} lienAccounts - Lien worksheet rows.
 * @param {{
 *   ack_no?: string|null,
 *   complaint_date?: string|null,
 *   total_disputed_amount?: number|null,
 *   officer?: Partial<typeof DEFAULT_OFFICER>,
 * }} [caseInfo={}] - Case context merged into every letter.
 * @returns {{
 *   emails: Array<{ report_id: number, bank_name: string, subject: string,
 *     body: string, account_list: string[], status: 'draft' }>,
 *   wallet_instruments: Array<{ account_no: string, bank_name: string,
 *     source_ref: string|null, amount: number, note: string }>,
 *   masked_accounts: Array<{ account_no: string, bank_name: string,
 *     ifsc_code: string|null, amount: number, note: string }>,
 * }}
 */
function buildEmailArtifacts(reportId, lienAccounts, caseInfo = {}) {
  const officer = { ...DEFAULT_OFFICER, ...(caseInfo.officer || {}) };
  const ackNo = caseInfo.ack_no ? String(caseInfo.ack_no).trim() : null;
  const hasComplaintDate = caseInfo.complaint_date != null
    && String(caseInfo.complaint_date).trim() !== '';
  const complaintDateStr = formatDate(caseInfo.complaint_date);

  // Partition the worksheet. Only ACTIONABLE bank accounts become letters; the
  // wallet/PA/VPA and masked rows go to their own sections (never a §102 letter).
  const { bank, wallet, masked } = partitionInstruments(lienAccounts);

  // Group actionable accounts by bank. The KEY is the FULL bank name lower-cased
  // (whitespace already collapsed), so pure case variants of one bank — e.g.
  // "Bank of Baroda (Including …)" vs "(including …)" — fold into ONE letter.
  // The name is NOT length-capped (sanitizeBankName), so long composite names
  // print in full in the heading and body.
  /** @type {Map<string, Array<{ account_no: string, ifsc_code: string|null, amount: number }>>} */
  const byBank = new Map();
  /** @type {Map<string, string>} normalised key → first-seen display name. */
  const bankDisplay = new Map();
  for (const acc of bank) {
    const bankName = sanitizeBankName(acc.bank_name) || 'Unknown Bank';
    const bankKey = bankName.toLowerCase();
    const amount = num(
      acc.lien_amount ?? acc.lien_eligible_amount ?? acc.disputed_amount ?? acc.recoverableAmount
    );
    if (!byBank.has(bankKey)) { byBank.set(bankKey, []); bankDisplay.set(bankKey, bankName); }
    byBank.get(bankKey).push({
      // Account numbers + IFSC come from untrusted Excel cells. Strip anything
      // that could break monospace alignment, escape into HTML, or smuggle
      // control sequences into a mail-client renderer (64-char cap is fine here).
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
    // One model per bank → renders BOTH the plain-text body (persisted, for
    // copy/Word-text/PDF) and the structured `letter` the frontend/Word render
    // as a formal HTML document. Same source → on-screen and dispatched agree.
    const letter = buildLetterModel({
      bankName, accounts, ackNo, complaintDateStr, hasComplaintDate, totalDisputed, officer,
    });
    emails.push({
      report_id: reportId,
      bank_name: bankName,
      subject: letter.subject,
      body: renderLetterText(letter),
      account_list: accounts.map((a) => a.account_no),
      status: 'draft',
      letter,
    });
  }

  // Sanitise the section display fields the same way (bank name un-capped,
  // account/ref capped) so nothing untrusted escapes into a renderer.
  const wallet_instruments = wallet.map((w) => ({
    account_no: sanitizeIdentifier(w.account_no),
    bank_name: sanitizeBankName(w.bank_name) || 'Unknown',
    source_ref: sanitizeIdentifier(w.source_ref) || null,
    amount: w.amount,
    note: w.note,
  }));
  const masked_accounts = masked.map((m) => ({
    account_no: sanitizeIdentifier(m.account_no),
    bank_name: sanitizeBankName(m.bank_name) || 'Unknown',
    ifsc_code: sanitizeIdentifier(m.ifsc_code) || null,
    amount: m.amount,
    note: m.note,
  }));

  return { emails, wallet_instruments, masked_accounts };
}

/**
 * Back-compat thin wrapper: just the per-bank §102 letters (actionable banks).
 * Callers that also need the wallet / masked sections use
 * {@link buildEmailArtifacts}.
 *
 * @param {number} reportId
 * @param {ReadonlyArray<Record<string, unknown>>} lienAccounts
 * @param {object} [caseInfo={}]
 * @returns {Array<object>} One email object per actionable bank, sorted by name.
 *
 * @example
 *   const emails = generateDraftEmails(7, result.lien_calculation, {
 *     ack_no: 'NCRP202612345678',
 *   });
 */
function generateDraftEmails(reportId, lienAccounts, caseInfo = {}) {
  return buildEmailArtifacts(reportId, lienAccounts, caseInfo).emails;
}

// ─── Exports ─────────────────────────────────────────────────────────

module.exports = {
  generateDraftEmails,
  buildEmailArtifacts,
  composeLetterText,
  DEFAULT_OFFICER,
  // Exposed for unit tests; not part of the stable contract.
  _internals: Object.freeze({
    buildSubject,
    buildBody,
    buildLetterModel,
    renderLetterText,
    buildAccountTable,
    formatMoney,
    formatDate,
    sanitizeIdentifier,
    sanitizeBankName,
  }),
};
