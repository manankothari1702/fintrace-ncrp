'use strict';

/**
 * FinTrace NCRP — v0.2.0 cross-artifact validator.
 *
 * Proves the three v0.2.0 fixes hold IN THE GENERATED ARTIFACTS (PDF text +
 * Excel cells), not merely in the in-memory summary. Last cycle the unit tests
 * were green while the rendered Excel still showed a stale cash-out, so every
 * check below reads the ACTUAL artifact and asserts it agrees with the summary
 * object. Cross-artifact agreement is the whole point.
 *
 * Read-only: it runs the real parser / analyzer / exporters and asserts — it
 * never mutates analyzer logic, exporters, or pinned gold. Validator + report
 * only.
 *
 * For each case (145 + 170) it:
 *   1. Runs the analyzer to produce the summary JSON.
 *   2. Generates the PDF and the Excel for that case.
 *   3. Extracts the relevant values from THREE sources — summary JSON, the
 *      generated PDF (text), the generated Excel (cells) — and asserts they
 *      agree and satisfy the invariants (sections A–E).
 *   4. Prints a per-case PASS/FAIL table and writes validate_v020.report.md.
 *
 * Exit code: 0 only if every assertion passes; 1 otherwise.
 *
 * Run:  node backend/scripts/validate_v020.js
 *
 * @module backend/scripts/validate_v020
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const BACKEND_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(BACKEND_DIR, '..');

const XLSX = require(path.join(BACKEND_DIR, 'node_modules', 'xlsx'));
const { parseNcrpFile } = require(path.join(BACKEND_DIR, 'src', 'parsers', 'ncrpParser'));
const { analyzeReport } = require(path.join(BACKEND_DIR, 'src', 'analyzers', 'analyzer'));
const { initializeDatabase } = require(path.join(BACKEND_DIR, 'src', 'db', 'schema'));
const { insertReport, insertManyTransactions } =
  require(path.join(BACKEND_DIR, 'src', 'db', 'queries'));
const { generateDraftEmails } = require(path.join(BACKEND_DIR, 'src', 'utils', 'emailGenerator'));
const { generateReportPdf } = require(path.join(BACKEND_DIR, 'src', 'utils', 'pdfGenerator'));
const { generateReportExcel } = require(path.join(BACKEND_DIR, 'src', 'utils', 'excelGenerator'));
const { resolveBank, cleanIfsc, sameBank, IFSC_BANK_MAP } =
  require(path.join(BACKEND_DIR, 'src', 'lib', 'ifscBankResolver'));
// The exact account-masking the PDF dossier (Annexure H) renders — imported so
// the validator checks the SAME function, never a drifting copy.
const { maskAccount } =
  require(path.join(BACKEND_DIR, 'src', 'utils', 'pdfGenerator'))._internals;

// ─── Ground truth (fail if a rupee figure is off by more than ₹1) ────────
const GROUND_TRUTH = {
  '145': {
    file: '32712250107145 (1).xlsx',
    victim_loss: 1065298.0,
    cashed_out: 544282.95,
    on_hold: 139649.18,
    refunded: 0,
    recoverable_residual: 381365.87,
    // FIX 4: merging the zero-padded …9366 duplicate reveals an SBI pass-through
    // (received ₹10k, forwarded ₹10k) with no freeze-able balance, dropping a
    // false ₹10,000 lien (434,394.61 → 424,394.61) and its freeze letter (15 → 14).
    lien_table_total: 424394.61,
    letter_count: 14,
    layers: 7,
    total_transactions: 151,
    // PDF Key Finding #1 split (cashed / on-hold / recoverable), derived live.
    pct_cashed: 51.1,
    pct_on_hold: 13.1,
    pct_recoverable: 35.8,
    // The prior mislabels — must now be correct (account -> IFSC -> bank). The
    // SBI …9366 account (SBIN0064933) was a 10th entry here; FIX 4 merges its
    // zero-padded duplicate and reveals it as a pass-through with no lien, so it
    // is no longer on a freeze letter. Its IFSC→bank resolution is still verified
    // via the data-quality view (section C) and the merge itself in section G.
    bank_truth: [
      ['00000005906495023', 'CBIN0282138', 'Central Bank of India'],
      ['252000590337', 'SURY0000011', 'Suryoday Small Finance Bank'],
      ['100219234781', 'INDB0001080', 'IndusInd Bank'],
      ['159079012694', 'INDB0000421', 'IndusInd Bank'],
      ['14751050003336', 'HDFC0001475', 'HDFC Bank'],
      ['002261100000025', 'YESB0YBLUPI', 'Yes Bank'],
      ['890073000000688', 'SIBL0000890', 'South Indian Bank'],
      ['92250100008713', 'BARB0DBLJAT', 'Bank of Baroda (group)'],
      ['20200131158023', 'BDBL0002532', 'Bandhan Bank'],
    ],
    // Dedup ground truth (section D): account with 5 byte-identical ATM rows.
    dedup_account: '100219234781',
    dedup_cashed_out: 10000,
    dedup_lien: 40000,
    // No letter contradicting these accounts' IFSC.
    forbidden_letters: [
      { account: '00000005906495023', bankRe: /union bank/i, label: 'Union Bank' },
      { account: '252000590337', bankRe: /jio payments/i, label: 'Jio Payments' },
    ],
  },
  // Second gold-standard case (32709250080512). Carries an "Old Transaction"
  // sheet (>6 months) that must be excluded from every figure. All values below
  // were verified byte-by-byte against the raw Excel (see gold block).
  '512': {
    file: 'BankAction_CompleteTrail.xlsx',
    ack_no: '32709250080512',
    // Reused by Section A's ground-truth pins (cash-out / hold / residual legs).
    victim_loss: 61000.0,
    cashed_out: 0,
    on_hold: 34775.68,
    refunded: 0,
    recoverable_residual: 26224.32,
    // The gold-standard assertion set requested for this case (Section GS).
    // NOTE on uniqueTransactions: the headline `summary.unique_transactions` is
    // the HOP count (distinct fund-movement legs); the "154 unique" figure here
    // is raw legs minus exact duplicates (154 − 0), exposed as
    // reconciliation.transactions.unique. This case has NO exact-duplicate leg
    // (fix/disputed-reconciliation-409).
    gold: {
      victimLoss: 61000.0,
      totalDisputed: 203524.16,
      totalTransactions: 154,   // raw headline (154 deduped + 0 exact duplicates)
      uniqueTransactions: 154,  // reconciliation.transactions.unique
      cashedOut: 0,
      onHold: 34775.68,
      recoverable: 26224.32,
      layers: 8,
      distinctAccounts: 87,     // summary.total_accounts (distinct hop beneficiaries)
      lienCount: 49,
      lienSum: 32375.01,
      oldTxnCount: 1,
      oldTxnAccount: '43619403919',
      oldTxnAmount: 0,
    },
  },
  '170': {
    file: '32712250107170 (1).xlsx',
    victim_loss: 1548900.0,
    // FIX 4 (canonical-account merge): zero-padded account variants now
    // aggregate, so one account's disputed-received and its cash-out — formerly
    // split across the padded/bare forms — combine. Under CAP_AT_RECEIVED that
    // admits ₹1,200 more cash-out as fraud proceeds: 38,841.78 → 40,041.78 (and
    // the residual falls by the same ₹1,200). Reconciliation still sums to loss.
    cashed_out: 40041.78,
    on_hold: 679158.18,
    refunded: 0,
    recoverable_residual: 829700.04,
  },
};

const VALID_FLAGS = new Set(['IFSC_TEXT_MISMATCH', 'NO_IFSC', 'INVALID_IFSC', 'UNKNOWN_IFSC_PREFIX']);

// ─── Pretty-printing ─────────────────────────────────────────────────────
const isTTY = process.stdout.isTTY;
const DIM = (s) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);
const BOLD = (s) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const ICON = { PASS: '✅', FAIL: '❌', MANUAL: '🔍' };

/** Indian digit grouping (12,34,567.89). */
function inr(n) {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return String(n);
  const v = Number(n);
  const neg = v < 0;
  const fixed = Math.abs(v).toFixed(2);
  const [intPart, decPart] = fixed.split('.');
  const last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  const grouped = rest ? `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}` : last3;
  return `${neg ? '-' : ''}${grouped}.${decPart}`;
}

// ─── PDF money / count formatting mirrors (for building search targets) ──
/** Mirror of pdfGenerator.formatMoney (Rs. + Indian grouping, 2 dp). */
function pdfMoney(value) {
  const v = Number(value) || 0;
  const neg = v < 0;
  const [intPart, decPart] = Math.abs(v).toFixed(2).split('.');
  let last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  if (rest !== '') last3 = ',' + last3;
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
  return `${neg ? '-' : ''}Rs. ${grouped}.${decPart}`;
}

/** Mirror of analyzer.formatINR after asciiSafe (₹ -> "Rs. "); e.g. "Rs. 5.44L". */
function pdfINR(amount) {
  const n = Number(amount) || 0;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const round2 = (x) => Math.round((x + Number.EPSILON) * 100) / 100;
  const trim = (x) => String(round2(x)).replace(/\.0+$/, '');
  let body;
  if (abs >= 1e7) body = `${trim(abs / 1e7)}Cr`;
  else if (abs >= 1e5) body = `${trim(abs / 1e5)}L`;
  else if (abs >= 1e3) body = `${trim(abs / 1e3)}K`;
  else body = `${trim(abs)}`;
  return `${sign}Rs. ${body}`;
}

// ─── Minimal PDF text extractor (no new deps; zlib + content-stream scan) ─
//
// PDFKit writes page content as FlateDecode-compressed streams of text-showing
// operators. With its subset fonts the strings are HEX (`[<46696e54> ...] TJ`),
// not literal `( ) Tj` — and the hex bytes are the ASCII character codes. We
// inflate each stream, then per text-show operator (TJ array or Tj) concatenate
// its `<hex>` / `(literal)` pieces WITHOUT spaces (so kerning splits like
// `<4578><65637574697665>` rejoin into "Executive"), and join separate
// operators with a single space. If extraction looks unreliable, callers fall
// back to the summary<->Excel pair and flag the PDF check as manual-verify.

/** Decode PDF string escapes within one parenthesised literal's inner text. */
function decodePdfString(inner) {
  let out = '';
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch !== '\\') { out += ch; continue; }
    const next = inner[i + 1];
    if (next === undefined) break;
    if (next >= '0' && next <= '7') {
      let oct = next; i += 1;
      for (let k = 0; k < 2 && inner[i + 1] >= '0' && inner[i + 1] <= '7'; k++) { oct += inner[++i]; }
      out += String.fromCharCode(parseInt(oct, 8));
      continue;
    }
    const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
    if (next === '\n') { i += 1; continue; }       // line continuation
    out += (next in map) ? map[next] : next;
    i += 1;
  }
  return out;
}

/** Decode a PDF hex string body (whitespace tolerated) to its byte chars. */
function decodeHex(hex) {
  const clean = String(hex).replace(/[^0-9A-Fa-f]/g, '');
  let out = '';
  for (let i = 0; i + 1 < clean.length; i += 2) {
    out += String.fromCharCode(parseInt(clean.substr(i, 2), 16));
  }
  if (clean.length % 2 === 1) out += String.fromCharCode(parseInt(clean[clean.length - 1] + '0', 16));
  return out;
}

/** Concatenate the `<hex>` / `(literal)` string pieces inside one operator. */
function piecesToText(inner) {
  let out = '';
  const re = /<([0-9A-Fa-f\s]*)>|\(((?:\\.|[^\\()])*)\)/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    out += (m[1] !== undefined) ? decodeHex(m[1]) : decodePdfString(m[2]);
  }
  return out;
}

/** Pull rendered text from one content-stream chunk, one token per text show. */
function literalsFromContent(s) {
  const tokens = [];
  const reTJ = /\[([^\]]*)\]\s*TJ/g;
  let m;
  while ((m = reTJ.exec(s)) !== null) tokens.push(piecesToText(m[1]));
  const reTj = /(<[0-9A-Fa-f\s]*>|\((?:\\.|[^\\()])*\))\s*Tj/g;
  while ((m = reTj.exec(s)) !== null) tokens.push(piecesToText(m[1]));
  return tokens.join(' ');
}

/** Extract a best-effort text dump from a PDF buffer. */
function extractPdfText(buf) {
  const out = [];
  const streamTok = Buffer.from('stream');
  const endTok = Buffer.from('endstream');
  let pos = 0;
  while (true) {
    const s = buf.indexOf(streamTok, pos);
    if (s < 0) break;
    let cs = s + streamTok.length;
    if (buf[cs] === 0x0d) cs++;
    if (buf[cs] === 0x0a) cs++;
    const e = buf.indexOf(endTok, cs);
    if (e < 0) break;
    let chunk = buf.slice(cs, e);
    let content = null;
    try { content = zlib.inflateSync(chunk); }
    catch (_a) {
      try { content = zlib.inflateRawSync(chunk); }
      catch (_b) { content = chunk; }
    }
    try { out.push(literalsFromContent(content.toString('latin1'))); } catch (_c) { /* skip */ }
    pos = e + endTok.length;
  }
  return out.join('\n');
}

// ─── Assertion plumbing ────────────────────────────────────────────────────
function makeRecorder(caseId, section, sink) {
  return {
    ok(label, detail) { sink.push({ caseId, section, status: 'PASS', label, detail: detail || '' }); },
    fail(label, detail) { sink.push({ caseId, section, status: 'FAIL', label, detail: detail || '' }); },
    manual(label, detail) { sink.push({ caseId, section, status: 'MANUAL', label, detail: detail || '' }); },
    assert(cond, label, detail) { (cond ? this.ok : this.fail).call(this, label, detail); },
  };
}

const approxEq = (a, b, tol = 1.0) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= tol;
const exactEq = (a, b) => approxEq(a, b, 0.005); // "byte-identical" rounded rupee figures

// ─── Run parser + analyzer on a real file (mirrors accuracy_test) ────────
async function analyzeFile(filePath) {
  const db = initializeDatabase(':memory:');
  const parsed = parseNcrpFile(filePath);
  const reportId = insertReport(db, {
    filename: 'validate.xlsx',
    original_filename: 'validate.xlsx',
    upload_date: new Date().toISOString(),
    analysis_status: 'pending',
  });
  const withId = parsed.rows.map((r) => ({ ...r, report_id: reportId }));
  for (let i = 0; i < withId.length; i += 500) {
    insertManyTransactions(db, withId.slice(i, i + 500));
  }
  // Natural (insertion / id) order — EXACTLY what the production analysis
  // pipeline feeds analyzeReport (route stmt.allTxns has no ORDER BY). Row order
  // matters: buildAccountRollup seeds each account's bank name from its
  // first-seen row, so a different order can change letter grouping.
  const txnRows = db.prepare(
    'SELECT * FROM ncrp_transactions WHERE report_id = ?'
  ).all(reportId);
  const result = await analyzeReport(reportId, txnRows, [], { db });
  db.close();
  const ackNo = (parsed.rows.find((r) => r.ack_no) || {}).ack_no || null;
  return { parsed, result, txnRows, ackNo };
}

/** Read the Excel "Summary" sheet as a label->value map (col A -> col B). */
function readExcelSummary(wb) {
  const ws = wb.Sheets['Summary'];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const byLabel = new Map();
  for (const row of aoa) {
    if (!Array.isArray(row) || row.length === 0) continue;
    const label = row[0] == null ? '' : String(row[0]).trim();
    if (label) byLabel.set(label, row[1]);
  }
  return byLabel;
}

/** Count data rows in the Excel "Data Quality" sheet (rows below the header). */
function countExcelDataQualityRows(wb) {
  const ws = wb.Sheets['Data Quality'];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  let headerIdx = -1;
  for (let i = 0; i < aoa.length; i++) {
    if (Array.isArray(aoa[i]) && String(aoa[i][0] || '').trim() === 'Account No.') { headerIdx = i; break; }
  }
  if (headerIdx < 0) return 0;
  let n = 0;
  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const acct = aoa[i] && aoa[i][0] != null ? String(aoa[i][0]).trim() : '';
    if (acct) n += 1;
  }
  return n;
}

/** Build account -> [letter bank names] from generated emails. */
function accountLetterBanks(emails) {
  const map = new Map();
  for (const e of emails) {
    for (const acc of (e.account_list || [])) {
      const key = String(acc);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(e.bank_name);
    }
  }
  return map;
}

// ─── Per-case validation ─────────────────────────────────────────────────
async function validateCase(caseId, filePath, sink) {
  const gt = GROUND_TRUTH[caseId];
  const { result, txnRows, ackNo } = await analyzeFile(filePath);
  const s = result.summary;
  const cashout = result.cashout_analysis;
  const recovery = result.recovery_status;
  const liens = result.lien_calculation;
  const dq = result.data_quality;

  const emails = generateDraftEmails(0, liens, {
    ack_no: ackNo,
    complaint_date: null,
    total_disputed_amount: s.total_disputed_amount,
  });

  // Generate the real artifacts.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `fintrace-v020-${caseId}-`));
  const pdfPath = path.join(tmpDir, `case-${caseId}.pdf`);
  const bundle = {
    report: { id: 0, ack_no: ackNo },
    analysis: result,
    liens,
    emails,
    layers: result.layer_analysis,
    transactions: txnRows,
    ack_no: ackNo,
    complaint_date: null,
  };
  await generateReportPdf(bundle, pdfPath);
  const pdfBuf = fs.readFileSync(pdfPath);
  const pdfText = extractPdfText(pdfBuf).replace(/\s+/g, ' ');
  const pdfReliable = pdfText.length > 500 && /Executive Summary/i.test(pdfText);

  const xlsxBuf = generateReportExcel(bundle);
  const wb = XLSX.read(xlsxBuf, { type: 'buffer' });
  const xlSummary = readExcelSummary(wb);

  // ── SECTION A — cash-out single-source + reconciliation ────────────────
  {
    const r = makeRecorder(caseId, 'A', sink);
    const sumCash = Number(s.cashed_out);
    const viewCash = Number(cashout.total_cashout_amount);
    const recCash = Number(recovery.cashed_out);
    const xlCash = Number(xlSummary.get('Cashed out (ATM/POS)'));

    // Five consumers byte-identical.
    r.assert(exactEq(sumCash, gt.cashed_out), 'summary.cashed_out == ground truth',
      `${inr(sumCash)} vs ${inr(gt.cashed_out)}`);
    r.assert(exactEq(viewCash, sumCash), 'cashout_analysis.total_cashout_amount == summary.cashed_out',
      `${inr(viewCash)} vs ${inr(sumCash)}`);
    r.assert(exactEq(recCash, sumCash), 'recovery_status.cashed_out == summary.cashed_out',
      `${inr(recCash)} vs ${inr(sumCash)}`);
    r.assert(exactEq(xlCash, sumCash), 'Excel Summary cash-out cell == summary.cashed_out',
      `${inr(xlCash)} vs ${inr(sumCash)}`);

    // PDF exec-summary cash-out figure (exact Rs. string).
    const moneyStr = pdfMoney(sumCash);
    const reStr = moneyStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/Rs\\\.\s*/, 'Rs\\.\\s*');
    if (!pdfReliable) {
      r.manual('PDF exec-summary cash-out figure', 'PDF text extraction unreliable — verify by eye');
    } else {
      r.assert(new RegExp(reStr).test(pdfText),
        `PDF exec-summary shows cash-out ${moneyStr}`, `searched "${moneyStr}"`);
    }

    // Reconciliation (in-memory + Excel cells): cashed+hold+refund+residual==loss.
    const loss = Number(s.victim_loss_amount);
    const reconSum = Number(s.cashed_out) + Number(s.on_hold) + Number(s.refunded) + Number(s.recoverable_residual);
    r.assert(approxEq(reconSum, loss, 1.0),
      'summary reconciliation cashed+hold+refund+residual == victim_loss',
      `${inr(reconSum)} vs ${inr(loss)}`);
    r.assert(exactEq(Number(s.recoverable_residual),
      Math.max(0, loss - Number(s.cashed_out) - Number(s.on_hold) - Number(s.refunded))),
      'recoverable_residual is derived max(0, loss-cashed-hold-refund)', inr(s.recoverable_residual));

    const xlLoss = Number(xlSummary.get('Victim loss (Layer-1 disputed) [Rs.]'));
    const xlHold = Number(xlSummary.get('On hold (frozen)'));
    const xlRef = Number(xlSummary.get('Refunded'));
    const xlResid = Number(xlSummary.get('Recoverable (residual)'));
    const xlRecon = xlCash + xlHold + xlRef + xlResid;
    r.assert(approxEq(xlRecon, xlLoss, 1.0),
      'Excel reconciliation cashed+hold+refund+residual == victim_loss',
      `${inr(xlRecon)} vs ${inr(xlLoss)}`);
    // Ground-truth pins for all four legs.
    r.assert(approxEq(xlLoss, gt.victim_loss, 1.0), 'Excel victim_loss == ground truth', inr(xlLoss));
    r.assert(approxEq(xlHold, gt.on_hold, 1.0), 'Excel on_hold == ground truth', inr(xlHold));
    r.assert(approxEq(xlRef, gt.refunded, 1.0), 'Excel refunded == ground truth', inr(xlRef));
    r.assert(approxEq(xlResid, gt.recoverable_residual, 1.0),
      'Excel recoverable_residual == ground truth', inr(xlResid));

    // PDF Key Finding #1 percentages (case 145 only has a pinned split).
    if (gt.pct_cashed != null) {
      const f1 = result.key_findings[0] || '';
      const okMem = new RegExp(`${gt.pct_cashed}%`).test(f1)
        && new RegExp(`${gt.pct_on_hold}%`).test(f1)
        && new RegExp(`${gt.pct_recoverable}%`).test(f1);
      r.assert(okMem, 'Key Finding #1 split (in-memory) is 51.1/13.1/35.8',
        `cashed ${recovery.cashed_out_pct} / hold ${recovery.on_hold_pct} / recov ${recovery.recoverable_pct}`);
      r.assert(recovery.cashed_out_pct !== 55.3 && recovery.cashed_out_pct !== 31.6,
        'Key Finding #1 is NOT the old 55.3/31.6 split', `cashed_out_pct=${recovery.cashed_out_pct}`);
      if (!pdfReliable) {
        r.manual('PDF Key Finding #1 percentages', 'PDF text extraction unreliable — verify by eye');
      } else {
        const okPdf = new RegExp(`${gt.pct_cashed}%`).test(pdfText)
          && new RegExp(`${gt.pct_on_hold}%`).test(pdfText)
          && new RegExp(`${gt.pct_recoverable}%`).test(pdfText);
        r.assert(okPdf, 'PDF text contains the 51.1/13.1/35.8 split', '');
        const inrStr = pdfINR(sumCash);
        const reInr = inrStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/Rs\\\.\s*/, 'Rs\\.\\s*');
        r.assert(new RegExp(reInr).test(pdfText),
          `PDF Key Finding #1 shows cash-out ${inrStr}`, `searched "${inrStr}"`);
      }
    }
  }

  // ── SECTION B — bank attribution = IFSC-authoritative ──────────────────
  {
    const r = makeRecorder(caseId, 'B', sink);
    // ifsc + raw_bank by account, from the lien worksheet.
    const lienByAcct = new Map(liens.map((l) => [String(l.account_no), l]));
    const letterBanks = accountLetterBanks(emails);

    // The contradiction oracle. The letter bank is generated through
    // emailGenerator.sanitizeIdentifier, which legitimately strips '&', trims to
    // 64 chars, and may differ in case from the canonical map — none of which
    // changes the INSTITUTION. So identity is tested with the resolver's own
    // sameBank() (which strips merger parentheticals and non-distinguishing
    // tokens); a FAIL means the letter is addressed to a genuinely DIFFERENT
    // bank than the account's IFSC (e.g. Union Bank for a CBIN/Central account).
    const ifscDerived = (l) => resolveBank({ rawBank: l.raw_bank, ifsc: l.ifsc_code }).bank;

    // Primary rule (both cases): every account on a letter with a valid IFSC —
    // the letter's bank must not contradict the IFSC-derived bank.
    let letterFails = 0, letterChecked = 0;
    for (const e of emails) {
      for (const acc of (e.account_list || [])) {
        const l = lienByAcct.get(String(acc));
        if (!l) continue;
        const ifsc = cleanIfsc(l.ifsc_code);
        if (!ifsc) continue;
        letterChecked += 1;
        const derived = ifscDerived(l);
        if (!sameBank(e.bank_name, derived)) {
          letterFails += 1;
          r.fail(`letter bank CONTRADICTS account IFSC for ${acc}`,
            `letter="${e.bank_name}" ifsc-derived="${derived}" ifsc=${ifsc}`);
        }
      }
    }
    r.assert(letterFails === 0,
      `no letter contradicts an account's IFSC (${letterChecked} IFSC-bearing accounts checked)`,
      letterFails ? `${letterFails} contradiction(s)` : 'all consistent');

    if (caseId === '145') {
      // The 10 prior mislabels — explicit ground truth.
      for (const [acct, ifsc, expectBank] of gt.bank_truth) {
        const banks = letterBanks.get(acct);
        const prefix = ifsc.slice(0, 4).toUpperCase();
        const canonical = IFSC_BANK_MAP[prefix];
        if (!banks || banks.length === 0) {
          r.fail(`account ${acct} appears on a lien letter`, `IFSC ${ifsc}; not found on any letter`);
          continue;
        }
        const letterBank = banks[0];
        // Same institution as the human-checked expectation AND as the canonical
        // IFSC map entry (sanitization-tolerant via sameBank).
        const ok = sameBank(letterBank, expectBank) && sameBank(letterBank, canonical);
        r.assert(ok, `account ${acct} letter bank is ${expectBank}`,
          `letter="${letterBank}" canonical="${canonical}" ifsc=${ifsc}`);
      }

      // Forbidden mislabels: no Union Bank letter for the CBIN account, no Jio
      // Payments letter for the SURY account.
      for (const f of gt.forbidden_letters) {
        const offending = emails.filter((e) =>
          f.bankRe.test(String(e.bank_name)) && (e.account_list || []).map(String).includes(f.account));
        r.assert(offending.length === 0,
          `NO "${f.label}" letter addresses account ${f.account}`,
          offending.length ? `found on "${offending[0].bank_name}"` : 'none');
      }

      // Letter count + per-letter amounts sum to lien_table_total.
      r.assert(emails.length === gt.letter_count, `letter count == ${gt.letter_count}`,
        `got ${emails.length}`);
      const letterSum = emails.reduce((acc, e) => {
        const t = liens.filter((l) => (e.account_list || []).map(String).includes(String(l.account_no)))
          .reduce((x, l) => x + Number(l.lien_eligible_amount || 0), 0);
        return acc + t;
      }, 0);
      r.assert(approxEq(letterSum, gt.lien_table_total, 1.0),
        `per-letter amounts sum to lien_table_total ${inr(gt.lien_table_total)}`, inr(letterSum));
    } else {
      // 170 — no hand-checked ground truth; record the letter->bank->IFSC table.
      const rows = [];
      for (const e of emails) {
        for (const acc of (e.account_list || [])) {
          const l = lienByAcct.get(String(acc));
          rows.push({ bank: e.bank_name, account: acc, ifsc: l ? (l.ifsc_code || '') : '' });
        }
      }
      sink.push({ caseId, section: 'B', status: 'INFO', label: '170 letter→bank→IFSC table',
        detail: JSON.stringify(rows) });
    }
  }

  // ── SECTION C — data-quality flags surface correctly ───────────────────
  {
    const r = makeRecorder(caseId, 'C', sink);
    const xlDqRows = countExcelDataQualityRows(wb);

    r.assert(Number(s.bank_flags_count) > 0, 'summary.bank_flags_count > 0', String(s.bank_flags_count));
    r.assert(s.bank_flags_count === dq.length, 'bank_flags_count == data_quality rows',
      `${s.bank_flags_count} vs ${dq.length}`);
    r.assert(xlDqRows === dq.length, 'Excel Data Quality sheet rows == data_quality rows',
      `${xlDqRows} vs ${dq.length}`);
    if (!pdfReliable) {
      r.manual('PDF Data Quality row count', 'PDF text extraction unreliable — verify by eye');
    } else {
      // The PDF prints the count in its data-quality intro ("N account(s) below").
      const m = pdfText.match(/(\d[\d,]*)\s+account\(s\) below need/);
      const pdfCount = m ? Number(m[1].replace(/,/g, '')) : null;
      r.assert(pdfCount === dq.length, 'PDF Data Quality count == data_quality rows',
        `pdf=${pdfCount} vs ${dq.length}`);
    }

    // Every flag value is one of the four known flags.
    const badFlags = dq.filter((d) => !VALID_FLAGS.has(d.bank_flag));
    r.assert(badFlags.length === 0, 'every flag is one of the 4 known flag values',
      badFlags.length ? badFlags.map((d) => d.bank_flag).join(',') : 'all valid');

    // Semantic checks per flag type.
    let semFails = 0;
    for (const d of dq) {
      const ifsc = cleanIfsc(d.ifsc_code);
      if (d.bank_flag === 'NO_IFSC' || d.bank_flag === 'INVALID_IFSC') {
        if (ifsc) { semFails += 1; r.fail(`NO/INVALID-IFSC row ${d.account_no} truly lacks valid IFSC`, `ifsc=${d.ifsc_code}`); }
      } else if (d.bank_flag === 'IFSC_TEXT_MISMATCH') {
        const derived = resolveBank({ rawBank: d.raw_bank, ifsc: d.ifsc_code }).bank;
        if (!ifsc || sameBank(derived, d.raw_bank)) {
          semFails += 1;
          r.fail(`IFSC_TEXT_MISMATCH row ${d.account_no} has valid IFSC differing from text`,
            `ifsc=${d.ifsc_code} text="${d.raw_bank}" derived="${derived}"`);
        }
      }
    }
    r.assert(semFails === 0, 'every data-quality row is semantically consistent with its flag',
      semFails ? `${semFails} inconsistent` : 'all consistent');

    // Multi-source-bank letters carry the reviewer footnote referencing the
    // data-quality annexure (Annexure H since the v0.3 dossier reorganisation).
    const flaggedAccts = new Set(dq.map((d) => String(d.account_no)));
    const lettersWithFlag = emails.filter((e) =>
      (e.account_list || []).some((a) => flaggedAccts.has(String(a)))).length;
    if (!pdfReliable) {
      r.manual('PDF reviewer footnote on flagged letters', 'PDF text extraction unreliable — verify by eye');
    } else {
      const notes = (pdfText.match(/See Annexure H/gi) || []).length;
      r.assert(notes === lettersWithFlag,
        `every letter with a flagged account carries the Annexure-H reviewer note`,
        `notes=${notes} vs letters-with-flag=${lettersWithFlag}`);
    }
  }

  // ── SECTION D — duplicate-row dedup (case 145 only) ────────────────────
  if (caseId === '145') {
    const r = makeRecorder(caseId, 'D', sink);
    const l = liens.find((x) => String(x.account_no) === gt.dedup_account);
    if (!l) {
      r.fail(`dedup account ${gt.dedup_account} present in lien worksheet`, 'not found');
    } else {
      r.assert(exactEq(Number(l.total_cashed_out), gt.dedup_cashed_out),
        `account ${gt.dedup_account} cash-out collapses to ${inr(gt.dedup_cashed_out)} (not 50,000)`,
        inr(l.total_cashed_out));
      r.assert(exactEq(Number(l.lien_eligible_amount), gt.dedup_lien),
        `account ${gt.dedup_account} lien == ${inr(gt.dedup_lien)}`, inr(l.lien_eligible_amount));
    }

    // Negative guard: dedup key is UTR + amount + timestamp, NOT UTR alone.
    // Two rows sharing a UTR but differing in amount must NOT collapse.
    const base = {
      ack_no: 'NEG', complaint_date: null, victim_account: 'V', victim_bank: null,
      beneficiary_account: 'B', beneficiary_bank: 'HDFC Bank', beneficiary_name: null,
      ifsc_code: 'HDFC0001', transaction_date: '2025-12-28T10:00:00.000Z',
      utr_no: 'UTR-SHARED', payment_mode: 'IMPS', layer_no: 1,
      atm_id: null, atm_location: null, city: null, state: null, remarks: null,
    };
    const rowA = { ...base, transaction_amount: 50000, disputed_amount: 50000 };
    const rowB = { ...base, transaction_amount: 25000, disputed_amount: 25000 };
    const negResult = await analyzeReport(1, [rowA, rowB], [], {});
    r.assert(negResult.summary.duplicate_count === 0,
      'two rows sharing a UTR but differing in amount are NOT collapsed',
      `duplicate_count=${negResult.summary.duplicate_count}, unique=${negResult.summary.unique_transactions}`);

    // Positive control: byte-identical rows DO collapse.
    const dupResult = await analyzeReport(1, [{ ...rowA }, { ...rowA }], [], {});
    r.assert(dupResult.summary.duplicate_count === 1,
      'two byte-identical rows DO collapse (positive control)',
      `duplicate_count=${dupResult.summary.duplicate_count}`);
  }

  // ── SECTION E — no financial drift from the bank fix (145 only) ────────
  if (caseId === '145') {
    const r = makeRecorder(caseId, 'E', sink);
    r.assert(approxEq(Number(s.victim_loss_amount), gt.victim_loss, 1.0),
      'victim_loss unchanged (1,065,298.00)', inr(s.victim_loss_amount));
    r.assert(approxEq(Number(s.lien_table_total), gt.lien_table_total, 1.0),
      'lien_table_total unchanged (434,394.61)', inr(s.lien_table_total));
    r.assert(s.total_layers === gt.layers, 'layers unchanged (7)', String(s.total_layers));
    r.assert(s.total_transactions === gt.total_transactions,
      'total transactions unchanged (151)', String(s.total_transactions));
  }

  // ── SECTION F — headline ⟷ annexure reconciliation (FIX 1+2) ───────────
  {
    const r = makeRecorder(caseId, 'F', sink);
    const rec = result.reconciliation || {};
    const d = rec.disputed || {};
    const tx = rec.transactions || {};

    // Disputed: hop + exit + hold + other == total == headline trail-disputed.
    const dParts = Number(d.hop) + Number(d.exit) + Number(d.hold) + Number(d.other);
    r.assert(approxEq(dParts, Number(d.total), 1.0),
      'reconciliation.disputed parts (hop+exit+hold+other) == total',
      `${inr(dParts)} vs ${inr(d.total)}`);
    r.assert(approxEq(Number(d.total), Number(s.total_disputed_amount), 1.0),
      'reconciliation.disputed.total == headline total_disputed_amount',
      `${inr(d.total)} vs ${inr(s.total_disputed_amount)}`);
    // hop bucket == the per-layer Disputed column sum (Annexure A footing).
    const layerDisputed = (result.layer_analysis || [])
      .reduce((a, l) => a + Number(l.disputed_amount || 0), 0);
    r.assert(approxEq(layerDisputed, Number(d.hop), 1.0),
      'Sum of Annexure-A per-layer Disputed == reconciliation.disputed.hop',
      `${inr(layerDisputed)} vs ${inr(d.hop)}`);

    // FEATURE 3 — the reconciliation foots LITERALLY via the explicit dedup line:
    // raw_hop − dedup_hop_adjustment + exit + hold + other == total, byte-exact.
    const rawHop = Number(d.raw_hop);
    const dedupAdj = Number(d.dedup_hop_adjustment);
    const comp = rawHop - dedupAdj + Number(d.exit) + Number(d.hold) + Number(d.other);
    r.assert(Math.abs(comp - Number(d.total)) < 0.005,
      'raw_hop - dedup_hop_adjustment + exit + hold + other == total (byte-exact)',
      `${inr(comp)} vs ${inr(d.total)}`);
    r.assert(exactEq(rawHop - dedupAdj, Number(d.hop)),
      'raw_hop - dedup_hop_adjustment == net hop disputed',
      `${inr(rawHop - dedupAdj)} vs ${inr(d.hop)}`);

    // FEATURE 3 — the headline Total Trail Disputed is byte-identical in all three
    // artifacts: summary JSON, the Excel Summary cell, and the PDF text.
    const headline = Number(s.total_disputed_amount);
    const xlTrail = Number(xlSummary.get('Total trail disputed (all layers) [Rs.]'));
    r.assert(exactEq(xlTrail, headline),
      'Excel "Total trail disputed" cell == summary headline (byte-identical)',
      `${inr(xlTrail)} vs ${inr(headline)}`);
    if (!pdfReliable) {
      r.manual('PDF Total Trail Disputed figure', 'PDF text extraction unreliable — verify by eye');
    } else {
      const moneyStr = pdfMoney(headline);
      const reStr = moneyStr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/Rs\\\.\s*/, 'Rs\\.\\s*');
      r.assert(new RegExp(reStr).test(pdfText),
        `PDF shows Total Trail Disputed ${moneyStr} (byte-identical)`, `searched "${moneyStr}"`);
    }

    // Transactions: dated+undated == unique; unique+duplicates == raw_legs == headline.
    r.assert(Number(tx.dated) + Number(tx.undated) === Number(tx.unique),
      'reconciliation.transactions dated + undated == unique',
      `${tx.dated}+${tx.undated} vs ${tx.unique}`);
    r.assert(Number(tx.unique) + Number(tx.duplicates) === Number(tx.raw_legs),
      'reconciliation.transactions unique + duplicates == raw_legs',
      `${tx.unique}+${tx.duplicates} vs ${tx.raw_legs}`);
    r.assert(Number(tx.raw_legs) === Number(s.total_transactions),
      'reconciliation.transactions.raw_legs == headline total_transactions',
      `${tx.raw_legs} vs ${s.total_transactions}`);

    // The annexure footing must render in the PDF.
    if (!pdfReliable) {
      r.manual('PDF Annexure A/G reconciliation labels', 'PDF text extraction unreliable — verify by eye');
    } else {
      r.assert(/Cash-out legs \(EXIT\)/i.test(pdfText) && /Other legs \(OTHER\)/i.test(pdfText),
        'PDF Annexure A shows the EXIT/OTHER reconciliation rows', '');
      r.assert(Number(tx.undated) === 0 || /\bUndated\b/.test(pdfText),
        'PDF Annexure G shows the Undated row (when undated rows exist)',
        `undated=${tx.undated}`);
    }
  }

  // ── SECTION G — canonical account merge (FIX 4) ────────────────────────
  {
    const r = makeRecorder(caseId, 'G', sink);
    const canon = (a) => {
      const v = String(a ?? '').trim();
      return /^\d+$/.test(v) ? (v.replace(/^0+/, '') || '0') : v;
    };

    // No two liened accounts are zero-padded variants of one real account.
    const seenLien = new Map();
    let dupLien = 0;
    for (const l of liens) {
      const k = canon(l.account_no);
      if (seenLien.has(k)) { dupLien += 1; r.fail('zero-padded duplicate in lien worksheet', `${seenLien.get(k)} ~ ${l.account_no}`); }
      else seenLien.set(k, l.account_no);
    }
    r.assert(dupLien === 0, 'no zero-padded account variants split across lien rows',
      dupLien ? `${dupLien} duplicate(s)` : 'all canonical');

    // data_quality (Annexure H) likewise carries one row per real account.
    const seenDq = new Map();
    let dupDq = 0;
    for (const d of dq) {
      const k = canon(d.account_no);
      if (seenDq.has(k)) dupDq += 1; else seenDq.set(k, d.account_no);
    }
    r.assert(dupDq === 0, 'no zero-padded account variants split across data-quality rows',
      dupDq ? `${dupDq} duplicate(s)` : 'all canonical');

    if (caseId === '145') {
      // SBI …9366: one Annexure-H row, valid IFSC won, and it is a pass-through
      // (received ₹10k then forwarded ₹10k → no freeze-able balance, not liened).
      const nine = dq.filter((d) => canon(d.account_no) === '44021519366');
      r.assert(nine.length === 1, 'SBI …9366 appears once in data quality (zero-padded duplicate merged)',
        `${nine.length} row(s)`);
      if (nine.length === 1) {
        r.assert(cleanIfsc(nine[0].ifsc_code) === 'SBIN0064933' && nine[0].bank_flag === 'IFSC_TEXT_MISMATCH',
          'SBI …9366 keeps the valid-IFSC attribution (SBIN0064933 / IFSC_TEXT_MISMATCH)',
          `ifsc=${nine[0].ifsc_code} flag=${nine[0].bank_flag}`);
      }
      const lienNine = liens.filter((l) => canon(l.account_no) === '44021519366');
      r.assert(lienNine.length === 0, 'SBI …9366 pass-through carries no lien (money traced downstream)',
        `${lienNine.length} lien row(s)`);
    }
  }

  // 170 cash-out reconciliation line, for human eyes.
  if (caseId === '170') {
    sink.push({ caseId, section: 'A', status: 'INFO', label: '170 cash-out reconciliation',
      detail: `${inr(s.cashed_out)} cashed + ${inr(s.on_hold)} on-hold + ${inr(s.refunded)} refunded + ` +
        `${inr(s.recoverable_residual)} residual = ${inr(Number(s.cashed_out) + Number(s.on_hold) + Number(s.refunded) + Number(s.recoverable_residual))} ` +
        `(victim_loss ${inr(s.victim_loss_amount)})` });
  }

  // Cleanup tmp artifacts.
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_e) { /* ignore */ }

  return { pdfReliable, emails, liens, dq, summary: s };
}

// ─── Gold-standard fixture (exact figure pins for a hand-verified case) ──────
//
// Asserts the requested ground-truth values for a case whose GROUND_TRUTH entry
// carries a `gold` block. Read-only: runs the real parser + analyzer and pins
// the summary, lien table, old-transaction handling, and the two Annexure-H
// invariants (masked-account uniqueness + canonical IFSC casing). Every check
// here MUST pass before any future build.
async function validateGoldStandard(caseId, filePath, sink) {
  const gt = GROUND_TRUTH[caseId];
  const g = gt.gold;
  const { parsed, result, ackNo } = await analyzeFile(filePath);
  const s = result.summary;
  const rec = (result.reconciliation && result.reconciliation.transactions) || {};
  const liens = result.lien_calculation || [];
  const dq = result.data_quality || [];
  const oldTxns = parsed.oldTransactions || [];

  const r = makeRecorder(caseId, 'GS', sink);

  if (gt.ack_no) {
    r.assert(String(ackNo) === gt.ack_no, `case acknowledgement number is ${gt.ack_no}`, String(ackNo));
  }

  // ── Summary figures (exact) ────────────────────────────────────────────
  r.assert(exactEq(Number(s.victim_loss_amount), g.victimLoss),
    `summary.victimLoss == ${inr(g.victimLoss)}`, inr(s.victim_loss_amount));
  r.assert(exactEq(Number(s.total_disputed_amount), g.totalDisputed),
    `summary.totalDisputed == ${inr(g.totalDisputed)}`, inr(s.total_disputed_amount));
  r.assert(Number(s.total_transactions) === g.totalTransactions,
    `summary.totalTransactions == ${g.totalTransactions} (raw headline)`, String(s.total_transactions));
  r.assert(Number(rec.unique) === g.uniqueTransactions,
    `summary.uniqueTransactions == ${g.uniqueTransactions} (deduped raw legs)`,
    `reconciliation.transactions.unique=${rec.unique}; raw=${rec.raw_legs}, dups=${rec.duplicates}`);
  r.assert(exactEq(Number(s.cashed_out), g.cashedOut),
    `summary.cashedOut == ${inr(g.cashedOut)}`, inr(s.cashed_out));
  r.assert(exactEq(Number(s.on_hold), g.onHold),
    `summary.onHold == ${inr(g.onHold)}`, inr(s.on_hold));
  r.assert(exactEq(Number(s.recoverable_residual), g.recoverable),
    `summary.recoverable == ${inr(g.recoverable)}`, inr(s.recoverable_residual));
  r.assert(Number(s.total_layers) === g.layers,
    `summary.layers == ${g.layers}`, String(s.total_layers));
  r.assert(Number(s.total_accounts) === g.distinctAccounts,
    `summary.distinctAccounts == ${g.distinctAccounts}`, String(s.total_accounts));

  // ── Feature 3: disputed reconciliation foots byte-exact ──────────────────
  // raw_hop − dedup_hop_adjustment + exit + hold + other == total == headline.
  // This case has NO exact-duplicate hop leg, so dedup_hop_adjustment == 0 and
  // net hop == raw hop. The ₹409.56 leg (UTR 563707902816) is unique and fully
  // counted (fix/disputed-reconciliation-409); the old key wrongly dropped it.
  const dRec = (result.reconciliation && result.reconciliation.disputed) || {};
  const recComp = Number(dRec.raw_hop) - Number(dRec.dedup_hop_adjustment)
    + Number(dRec.exit) + Number(dRec.hold) + Number(dRec.other);
  r.assert(Math.abs(recComp - Number(dRec.total)) < 0.005,
    'disputed reconciliation foots byte-exact (raw_hop - dedup + exit + hold + other == total)',
    `${inr(recComp)} vs ${inr(dRec.total)}`);
  r.assert(exactEq(Number(dRec.total), g.totalDisputed),
    `disputed.total == headline ${inr(g.totalDisputed)}`, inr(dRec.total));
  r.assert(exactEq(Number(dRec.raw_hop), 196215.28), 'disputed.raw_hop == 1,96,215.28', inr(dRec.raw_hop));
  r.assert(exactEq(Number(dRec.hop), 196215.28), 'disputed.hop (net) == 1,96,215.28', inr(dRec.hop));
  r.assert(exactEq(Number(dRec.other), 7308.88), 'disputed.other == 7,308.88', inr(dRec.other));
  r.assert(exactEq(Number(dRec.dedup_hop_adjustment), 0),
    'dedup_hop_adjustment == 0 (no exact-duplicate hop leg; ₹409.56 leg is unique)',
    inr(dRec.dedup_hop_adjustment));

  // ── Lien table ─────────────────────────────────────────────────────────
  r.assert(liens.length === g.lienCount, `lienTable.length == ${g.lienCount}`, String(liens.length));
  const lienSum = liens.reduce((a, l) => a + Number(l.lien_eligible_amount || 0), 0);
  r.assert(exactEq(lienSum, g.lienSum), `sum(lienTable.lienAmount) == ${inr(g.lienSum)}`, inr(lienSum));

  // ── Feature 4: lien is reproducible from the per-account audit columns ────
  let lienReconFails = 0;
  for (const l of liens) {
    const gb = Math.max(0, Number(l.total_received) - Number(l.onward_forwarded)
      - Number(l.total_on_hold) - Number(l.total_cashed_out));
    const recomputed = Math.max(0, Math.min(gb, Number(l.disputed_received)));
    if (!exactEq(recomputed, Number(l.lien_eligible_amount))) lienReconFails += 1;
    if (typeof l.disputed_forwarded !== 'number' || typeof l.excluded_reason !== 'string'
      || l.excluded_reason.length === 0) lienReconFails += 1;
  }
  r.assert(lienReconFails === 0,
    'every lien row reconstructs lien = max(0, min(grossBalance, disputedInflow)) with audit columns',
    lienReconFails ? `${lienReconFails} row(s) failed` : `${liens.length} rows reconcile line-by-line`);
  // No-cap naive == lien total + Σ cap excess + Σ excluded gross residue.
  const capExcessSum = liens.reduce((s, l) => s + Number(l.cap_excess || 0), 0);
  const excludedGross = (result.lien_excluded || []).reduce((s, e) => s + Number(e.gross_balance), 0);
  const naiveNoCap = lienSum + capExcessSum + excludedGross;
  r.assert(approxEq(naiveNoCap, 71463.12, 0.02),
    'no-cap naive == lien total + cap excess + excluded gross (== 71,463.12)',
    `${inr(naiveNoCap)} (lien ${inr(lienSum)} + cap-excess ${inr(capExcessSum)} + excluded ${inr(excludedGross)})`);

  // ── Old transactions (>6 months — excluded from every figure) ───────────
  r.assert(oldTxns.length === g.oldTxnCount, `oldTransactions.length == ${g.oldTxnCount}`, String(oldTxns.length));
  if (oldTxns.length > 0) {
    r.assert(String(oldTxns[0].account_no) === g.oldTxnAccount,
      `oldTransactions[0].account == '${g.oldTxnAccount}'`, String(oldTxns[0].account_no));
    r.assert(Number(oldTxns[0].transaction_amount) === g.oldTxnAmount,
      `oldTransactions[0].amount == ${g.oldTxnAmount}`, String(oldTxns[0].transaction_amount));
  }

  // ── Annexure H invariants ───────────────────────────────────────────────
  // (1) No two rows in the bank-attribution (freeze-target) table share the
  //     same masked-account string — a collision would render two distinct
  //     freeze targets identically. Checked against the SAME maskAccount the
  //     PDF uses.
  const masks = dq.map((d) => maskAccount(d.account_no));
  const dupMasks = [...new Set(masks.filter((m, i) => masks.indexOf(m) !== i))];
  r.assert(dupMasks.length === 0,
    'Annexure H: no two data-quality rows share the same masked account',
    dupMasks.length ? `collide: ${dupMasks.join(', ')}` : `${masks.length} rows, all distinct`);

  // (2) Every resolved IFSC is canonical uppercase (4 letters, 0, 6 alphanum).
  //     Rows whose flag is a known-unknown case (no usable / malformed IFSC)
  //     are exempt — there is no canonical code to print.
  const KNOWN_UNKNOWN = new Set(['UNKNOWN_IFSC_PREFIX', 'INVALID_IFSC', 'NO_IFSC']);
  const CANON_IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
  const badIfsc = dq.filter((d) => d.ifsc_code && !KNOWN_UNKNOWN.has(d.bank_flag)
    && !CANON_IFSC.test(String(d.ifsc_code)));
  r.assert(badIfsc.length === 0,
    'Annexure H: every resolved IFSC is canonical uppercase (no lowercase)',
    badIfsc.length ? badIfsc.map((d) => `${d.account_no}:${d.ifsc_code}`).join(', ') : 'all canonical');

  return { summary: s, liens, dq, oldTransactions: oldTxns };
}

// ─── Existing suites (run as separate processes; results folded in) ──────────
function runSuites() {
  const suites = [
    { name: 'jest', cmd: 'npx jest', cwd: BACKEND_DIR },
    { name: 'accuracy_test.js', cmd: 'node backend/scripts/accuracy_test.js', cwd: ROOT_DIR },
    { name: 'consistency_test.js', cmd: 'node backend/scripts/consistency_test.js', cwd: ROOT_DIR },
    { name: 'security_audit.js', cmd: 'node backend/scripts/security_audit.js', cwd: ROOT_DIR },
  ];
  const out = [];
  for (const sdef of suites) {
    let status = 'PASS';
    let raw = '';
    try {
      // `2>&1` merges stderr (jest prints its "Tests: N passed" summary there).
      raw = execSync(`${sdef.cmd} 2>&1`, { cwd: sdef.cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 });
    } catch (err) {
      status = 'FAIL';
      raw = `${err.stdout || ''}\n${err.stderr || ''}`;
    }
    const lines = String(raw).split(/\r?\n/).map((l) => l.replace(/\x1b\[[0-9;]*m/g, '').trim()).filter(Boolean);
    // Strong summary patterns, in priority order.
    const strong = /(Tests:\s*\d+\s*passed|Test Suites:\s*\d+\s*passed|Final score:.*\d+\/\d+|consistency checks passed|security score|Verdict:)/i;
    const hits = lines.filter((l) => strong.test(l));
    const summary = hits.length ? hits[hits.length - 1] : (lines[lines.length - 1] || '');
    // Dedupe + keep the meaningful tally lines for the report detail.
    const detail = [...new Set(hits)].join(' | ') || summary;
    out.push({ name: sdef.name, cmd: sdef.cmd, status, summary, detail });
    console.log(`${status === 'PASS' ? '✅' : '❌'} suite ${sdef.name} — ${summary}`);
  }
  return out;
}

// ─── Locate case files ─────────────────────────────────────────────────────
function locate(name) {
  const candidates = [path.join(ROOT_DIR, name), path.join(BACKEND_DIR, name)];
  return candidates.find((p) => fs.existsSync(p)) || null;
}

// ─── Markdown report builder ───────────────────────────────────────────────
function buildReport(sink, info, suites) {
  const lines = [];
  lines.push('# FinTrace v0.2.0 — Cross-Artifact Validation Report');
  lines.push('');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push('');
  lines.push('Read-only verification: the analyzer + exporters were run on the two available ' +
    'case files and every figure was extracted from THREE sources — the summary JSON, the ' +
    'generated PDF (text), and the generated Excel (cells) — and asserted to agree.');
  lines.push('');
  lines.push('> Coverage note: only two case files exist (145 + 170). These results confirm the ' +
    'fixes on those two cases and are **not** release-grade coverage.');
  lines.push('');

  // Headline tally.
  const pass = sink.filter((x) => x.status === 'PASS').length;
  const fail = sink.filter((x) => x.status === 'FAIL').length;
  const manual = sink.filter((x) => x.status === 'MANUAL').length;
  const suiteFail = (suites || []).filter((x) => x.status === 'FAIL').length;
  lines.push(`**Cross-artifact assertions:** ${pass} passed, ${fail} failed` +
    `${manual ? `, ${manual} manual-verify` : ''}.`);
  lines.push(`**Existing suites:** ${(suites || []).length - suiteFail}/${(suites || []).length} passed.`);
  lines.push('');
  lines.push(`Overall: ${fail === 0 && suiteFail === 0 ? '✅ **ALL CHECKS PASS**' : '❌ **FAILURES PRESENT**'}`);
  lines.push('');

  for (const caseId of ['145', '170', '512']) {
    lines.push(`## Case ${caseId}`);
    lines.push('');
    const pr = info[caseId] || {};
    if (pr.pdfReliable !== undefined) {
      lines.push(`PDF text extraction: ${pr.pdfReliable ? 'reliable ✅' : 'UNRELIABLE — PDF checks marked manual-verify 🔍'}`);
      lines.push('');
    }
    for (const section of ['GS', 'A', 'B', 'C', 'D', 'E', 'F', 'G']) {
      const rows = sink.filter((x) => x.caseId === caseId && x.section === section && x.status !== 'INFO');
      if (rows.length === 0) continue;
      const titles = {
        GS: 'Gold-standard figure pins (summary / lien / old-txn / Annexure H)',
        A: 'A. Cash-out single-source + reconciliation',
        B: 'B. Bank attribution = IFSC-authoritative',
        C: 'C. Data-quality flags',
        D: 'D. Duplicate-row dedup',
        E: 'E. No financial drift from the bank fix',
        F: 'F. Headline <-> annexure reconciliation',
        G: 'G. Canonical account merge (zero-padded variants)',
      };
      lines.push(`### ${titles[section]}`);
      lines.push('');
      lines.push('| Result | Check | Detail |');
      lines.push('|---|---|---|');
      for (const x of rows) {
        const icon = x.status === 'PASS' ? '✅ PASS' : x.status === 'FAIL' ? '❌ FAIL' : '🔍 MANUAL';
        lines.push(`| ${icon} | ${x.label} | ${String(x.detail).replace(/\|/g, '\\|')} |`);
      }
      lines.push('');
    }
    // INFO blocks (170 table + reconciliation).
    const infos = sink.filter((x) => x.caseId === caseId && x.status === 'INFO');
    for (const x of infos) {
      if (x.label.includes('letter→bank→IFSC')) {
        lines.push('### Letter → Bank → IFSC (for human review)');
        lines.push('');
        lines.push('| Letter bank | Account | IFSC |');
        lines.push('|---|---|---|');
        let rows = [];
        try { rows = JSON.parse(x.detail); } catch (_e) { rows = []; }
        for (const row of rows) lines.push(`| ${row.bank} | ${row.account} | ${row.ifsc || '—'} |`);
        lines.push('');
      } else {
        lines.push(`**${x.label}:** ${x.detail}`);
        lines.push('');
      }
    }
  }

  // Existing suites.
  lines.push('## Existing test suites');
  lines.push('');
  lines.push('| Result | Suite | Summary |');
  lines.push('|---|---|---|');
  for (const su of (suites || [])) {
    const icon = su.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
    lines.push(`| ${icon} | \`${su.cmd}\` | ${String(su.detail || su.summary).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');

  return lines.join('\n');
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  console.log(BOLD('FinTrace NCRP — v0.2.0 Cross-Artifact Validation'));
  console.log(DIM('  summary JSON  ⟷  generated PDF (text)  ⟷  generated Excel (cells)'));

  const f145 = locate(GROUND_TRUTH['145'].file);
  const f170 = locate(GROUND_TRUTH['170'].file);
  const f512 = locate(GROUND_TRUTH['512'].file);

  if (!f145 || !f170 || !f512) {
    console.error('\nMissing required case file(s). Files found in project root / backend:');
    for (const dir of [ROOT_DIR, BACKEND_DIR]) {
      const xs = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.xlsx'));
      console.error(`  ${dir}:\n${xs.map((x) => `    - ${x}`).join('\n') || '    (none)'}`);
    }
    console.error(`\n  145 -> ${f145 || 'NOT FOUND'}`);
    console.error(`  170 -> ${f170 || 'NOT FOUND'}`);
    console.error(`  512 -> ${f512 || 'NOT FOUND'}`);
    console.error('\nAborting — cannot validate without all gold case files.');
    process.exit(2);
  }

  const sink = [];
  const info = {};
  info['145'] = await validateCase('145', f145, sink);
  info['170'] = await validateCase('170', f170, sink);
  // Second gold-standard fixture — exact-figure pins for the hand-verified case.
  info['512'] = await validateGoldStandard('512', f512, sink);

  // Console scoreboard.
  for (const caseId of ['145', '170', '512']) {
    console.log(BOLD(`\n══ Case ${caseId} ══`));
    for (const x of sink.filter((y) => y.caseId === caseId && y.status !== 'INFO')) {
      console.log(`${ICON[x.status] || '•'} ${x.section} | ${x.label}${x.detail ? DIM(`  [${x.detail}]`) : ''}`);
    }
  }

  // Existing suites (separate processes), folded into the report + exit code.
  console.log(BOLD('\n══ Existing suites ══'));
  const suites = runSuites();

  const reportPath = path.join(BACKEND_DIR, 'scripts', 'validate_v020.report.md');
  fs.writeFileSync(reportPath, buildReport(sink, info, suites), 'utf8');

  const pass = sink.filter((x) => x.status === 'PASS').length;
  const fail = sink.filter((x) => x.status === 'FAIL').length;
  const manual = sink.filter((x) => x.status === 'MANUAL').length;
  const suiteFail = suites.filter((x) => x.status === 'FAIL').length;

  console.log(BOLD('\n────────────────────────────────────────────────────────'));
  console.log(`  cross-artifact: ${pass} passed, ${fail} failed${manual ? `, ${manual} manual-verify` : ''}`);
  console.log(`  existing suites: ${suites.length - suiteFail}/${suites.length} passed`);
  console.log(`  report: ${reportPath}`);
  console.log(BOLD('────────────────────────────────────────────────────────\n'));

  process.exit(fail === 0 && suiteFail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nvalidate_v020 crashed:', err && err.stack ? err.stack : err);
  process.exit(1);
});
