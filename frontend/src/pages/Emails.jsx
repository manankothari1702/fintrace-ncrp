/**
 * Draft Lien Request Emails page.
 *
 * One formal §102 letter per ACTIONABLE bank, shown as an accordion of cards.
 * The letter renders as a proper document (app font, paragraph spacing, a real
 * account table) — NOT a monospace ASCII block — from the backend `letter`
 * model. Copy-to-clipboard still copies the plain-text body (the version that
 * pastes cleanly into any mail client), so what you read matches what you send.
 *
 * Wallet / PA / VPA instruments and masked-account rows are pulled OUT of the
 * letters into two caution-styled non-actionable sections (a wallet can't place
 * a §102 lien; a bank can't act on a masked number) — visible, with amounts, so
 * nothing is dropped. The whole set exports to Word. The tool never sends mail.
 *
 * Loads getEmails(id) → { emails (each with .letter), wallet_instruments,
 * masked_accounts }. The letter date is injected at render/copy/export time
 * (stored body is date-free), so a copied letter is always current.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import Badge from '../components/Badge.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { formatINR } from '../utils/format.js';
import { getEmails, updateEmailStatus, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Letter issue date — UTC, matching the backend formatDate (NCRP timestamps are
// IST wall-clock relabelled UTC; reading the issue date in UTC keeps it
// deterministic and never off-by-one near IST midnight).
function letterDateUTC(d = new Date()) {
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// The full copyable letter text = current date line + the stored (date-free) body.
function letterText(email) {
  return `Date: ${letterDateUTC()}\n\n${email.body}`;
}

// "Rs." money — mirrors the backend emailGenerator.formatMoney so the on-screen
// letter table matches the figures in the plain-text body the bank receives.
function rs(value) {
  const v = Number.isFinite(Number(value)) ? Number(value) : 0;
  const neg = v < 0;
  const [intPart, decPart] = Math.abs(v).toFixed(2).split('.');
  let last3 = intPart.slice(-3);
  const rest = intPart.slice(0, -3);
  if (rest !== '') last3 = `,${last3}`;
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + last3;
  return `${neg ? '-' : ''}Rs. ${grouped}.${decPart}`;
}

// Indian-grouped rupee amount to the paisa, for the app data sections (₹ — the
// same grammar the Lien / other tables use; the formal letter keeps "Rs.").
const money = (v) => formatINR(v, { paise: true });

// Derive a plausible nodal-officer placeholder address from the bank name.
function bankEmailPlaceholder(bank) {
  const slug = bank.toLowerCase().replace(/\s*bank\s*/g, '').replace(/[^a-z]/g, '');
  return `nodal.officer@${slug || 'bank'}.example`;
}

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export default function Emails() {
  const reportId = useActiveReportId();

  const [emails, setEmails] = useState([]);
  const [wallet, setWallet] = useState([]);
  const [masked, setMasked] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Each card owns its collapse state independently (a Set of expanded ids),
  // so collapsing one letter never touches the others.
  const [openIds, setOpenIds] = useState(() => new Set());
  const [copiedId, setCopiedId] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    getEmails(reportId)
      .then((data) => {
        if (cancelled) return;
        const rows = data.emails || [];
        setEmails(rows);
        setWallet(data.wallet_instruments || []);
        setMasked(data.masked_accounts || []);
        // Start with every letter expanded; the officer collapses the ones
        // they've dealt with.
        setOpenIds(new Set(rows.map((r) => r.id)));
      })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [reportId]);

  // Auto-dismiss the success toast.
  useEffect(() => {
    if (!toast) return undefined;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  // Escape collapses all open letters.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') setOpenIds(new Set()); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Toggle one card's collapse state without disturbing the others.
  const toggleOpen = (id) => setOpenIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const copyBody = (email) => {
    navigator.clipboard.writeText(letterText(email))
      .then(() => {
        setCopiedId(email.id);
        setTimeout(() => setCopiedId((cur) => (cur === email.id ? null : cur)), 2000);
      })
      // eslint-disable-next-line no-alert
      .catch(() => alert('Copy failed — select the text and copy manually.'));
  };

  const markSent = async (email) => {
    if (email.status === 'sent') return;
    setSavingId(email.id);
    // Optimistic flip, rolled back if the request fails.
    setEmails((rows) => rows.map((e) => (e.id === email.id ? { ...e, status: 'sent' } : e)));
    try {
      const saved = await updateEmailStatus(reportId, email.id, 'sent');
      setEmails((rows) => rows.map((e) => (e.id === email.id ? { ...e, status: saved.status } : e)));
      setToast(`${email.bank_name} letter marked as sent.`);
    } catch (err) {
      setEmails((rows) => rows.map((e) => (e.id === email.id ? { ...e, status: 'draft' } : e)));
      setToast(friendlyErrorMessage(err) || err.message || 'Could not update the letter status.');
    } finally {
      setSavingId(null);
    }
  };

  const downloadAllAsWord = () => {
    const letterSections = emails.map((e) => letterToWordHtml(e)).join('');
    const walletSection = wallet.length ? sectionToWordHtml(
      'Verify Nodal Entity — Wallet / PA / VPA Instruments',
      `These ${wallet.length} instrument(s) are payment wallets / aggregators / gateways or UPI VPAs, <strong>not bank accounts</strong> — a wallet/PA cannot place a Section 102 lien. Identify the nodal/escrow bank holding these funds before issuing a request; the "Source Ref" is the raw value from the source IFSC cell and is <strong>not</strong> a bank IFSC. Listed here so no instrument is dropped from the trail.`,
      ['#', 'Instrument', 'Entity (as named in source)', 'Source Ref (not an IFSC)', 'Amount'],
      wallet.map((w, i) => [i + 1, w.account_no, w.bank_name, w.source_ref || '—', money(w.amount)]),
      money(wallet.reduce((s, w) => s + Number(w.amount || 0), 0)),
    ) : '';
    const maskedSection = masked.length ? sectionToWordHtml(
      'Unresolvable / Masked Accounts — Non-Actionable',
      `These ${masked.length} account(s) carry a masked or unresolvable account number in the source (e.g. "XXXX", "NA") — a bank cannot action a freeze on an unidentifiable account. Obtain the full account number before issuing the request. Listed here so nothing is dropped.`,
      ['#', 'Account (as in source)', 'Bank', 'IFSC', 'Amount'],
      masked.map((m, i) => [i + 1, m.account_no, m.bank_name, m.ifsc_code || '—', money(m.amount)]),
      money(masked.reduce((s, m) => s + Number(m.amount || 0), 0)),
    ) : '';

    const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'>
      <head><meta charset="utf-8"><title>FinTrace Lien Letters</title></head>
      <body style="font-family:'Times New Roman',serif">
        <h1 style="font-family:Arial">FinTrace — Lien Request Letters</h1>
        ${letterSections}${walletSection}${maskedSection}
      </body></html>`;
    const url = URL.createObjectURL(new Blob([html], { type: 'application/msword' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'lien-request-letters.doc'; a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return <div className="page"><header className="page-header"><h1>Draft Lien Request Emails</h1></header><LoadingSpinner block label="Preparing letters…" /></div>;
  }
  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Draft Lien Request Emails</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load draft emails"
          message={error.code === 'NO_REPORT'
            ? 'No report is selected. Upload a file or pick one from Previous Reports.'
            : friendlyErrorMessage(error)}
        />
        <div style={{ marginTop: 16 }}><Link className="btn btn-primary" to="/upload">← Go to Upload</Link></div>
      </div>
    );
  }

  const nothing = emails.length === 0 && wallet.length === 0 && masked.length === 0;

  return (
    <div className="page">
      {toast && (
        <div
          role="status"
          style={{
            position: 'fixed', top: 20, right: 20, zIndex: 50,
            background: 'var(--accent)', color: 'var(--text-on-solid)', padding: '10px 16px',
            borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
            fontSize: 13, fontWeight: 600,
          }}
        >
          {toast}
        </div>
      )}
      <header className="page-header">
        <h1>Draft Lien Request Emails</h1>
        <p className="subtitle">
          {emails.length} bank{emails.length === 1 ? '' : 's'} · one formal §102 letter each, ready to copy into your email client.
          {(wallet.length > 0 || masked.length > 0) && (
            <> {wallet.length + masked.length} non-actionable instrument(s) (wallet / PA / VPA{masked.length ? ' / masked' : ''}) are listed separately below.</>
          )}
        </p>
      </header>

      <div className="table-toolbar" style={{ marginBottom: 16 }}>
        <span className="spacer" />
        <button type="button" className="btn btn-primary" onClick={downloadAllAsWord} disabled={nothing}>
          ⬇ Download All as Word Document
        </button>
      </div>

      {nothing ? (
        <div className="card card-pad"><div className="empty-state">No draft letters for this report. A lien-request letter is generated automatically for each bank once an account carries a recoverable (lien-eligible) balance — see the Lien Tracker.</div></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {emails.map((email) => {
            const isOpen = openIds.has(email.id);
            const bodyId = `letter-body-${email.id}`;
            const flagged = Array.isArray(email.flagged_accounts) ? email.flagged_accounts : [];
            return (
              <div className="card letter-card" key={email.id}>
                <button
                  type="button"
                  className="letter-head"
                  onClick={() => toggleOpen(email.id)}
                  aria-expanded={isOpen}
                  aria-controls={bodyId}
                  title={isOpen ? 'Collapse this letter' : 'Expand this letter'}
                >
                  <span className="letter-icon" aria-hidden="true">✉️</span>
                  <span className="letter-head-main">
                    <strong className="letter-bank">{email.bank_name}</strong>
                    <span className="letter-meta">{email.account_list.length} account{email.account_list.length === 1 ? '' : 's'}</span>
                    {flagged.length > 0 && (
                      <span className="freeze-flag" title="One or more accounts in this letter could not be confirmed from a valid IFSC — verify the freeze target before dispatch.">⚠ verify bank</span>
                    )}
                  </span>
                  <Badge color={email.status === 'sent' ? 'var(--accent)' : 'var(--text-muted)'}>{email.status}</Badge>
                  <span
                    className="letter-chevron"
                    style={{ transform: isOpen ? 'rotate(0deg)' : 'rotate(-90deg)' }}
                    aria-hidden="true"
                  >▾</span>
                </button>

                {/* Body stays mounted (collapsed via CSS) so the print
                    stylesheet can reveal every letter at once for the case file. */}
                <div id={bodyId} className={`letter-body${isOpen ? '' : ' is-collapsed'}`}>
                  <div className="letter-body-inner">
                    <div className="letter-fields">
                      <span className="letter-field-label">To</span>
                      <span>{bankEmailPlaceholder(email.bank_name)} <em className="letter-field-hint">(placeholder)</em></span>
                    </div>

                    {flagged.length > 0 && (
                      <div className="letter-caveat" role="note">
                        <strong>Reviewer note — verify before dispatch (not part of the letter):</strong>{' '}
                        the bank for account(s) <span className="mono">{flagged.join(', ')}</span> could not be confirmed from a valid IFSC. Confirm the freeze target before sending — see Data Quality.
                      </div>
                    )}

                    {email.letter
                      ? <FormalLetter letter={email.letter} dateStr={letterDateUTC()} />
                      : <pre className="letter-fallback">{letterText(email)}</pre>}

                    <div className="letter-actions">
                      <button type="button" className="btn btn-sm btn-primary" onClick={() => copyBody(email)}>
                        {copiedId === email.id ? '✓ Copied!' : '📋 Copy to Clipboard'}
                      </button>
                      <button type="button" className="btn btn-sm" disabled={email.status === 'sent' || savingId === email.id} onClick={() => markSent(email)}>
                        {email.status === 'sent' ? 'Marked as Sent' : savingId === email.id ? 'Saving…' : 'Mark as Sent'}
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {wallet.length > 0 && (
            <NonActionableSection
              icon="👛"
              title="Verify Nodal Entity — Wallet / PA / VPA Instruments"
              count={wallet.length}
              intro={'These are payment wallets / aggregators / gateways or UPI VPAs — not bank accounts. A wallet/PA cannot place a Section 102 lien. Identify the nodal/escrow bank holding these funds before issuing a request; the "Source Ref" is the raw value from the source IFSC cell and is NOT a bank IFSC.'}
              columns={['#', 'Instrument', 'Entity (as named in source)', 'Source Ref (not an IFSC)', 'Amount']}
              rows={wallet.map((w, i) => [i + 1, w.account_no, w.bank_name, w.source_ref || '—', money(w.amount)])}
              total={money(wallet.reduce((s, w) => s + Number(w.amount || 0), 0))}
              monoCols={[1, 3]}
            />
          )}

          {masked.length > 0 && (
            <NonActionableSection
              icon="🚫"
              title="Unresolvable / Masked Accounts — Non-Actionable"
              count={masked.length}
              intro={'These accounts carry a masked or unresolvable account number in the source (e.g. "XXXX", "NA") — a bank cannot action a freeze on an unidentifiable account. Obtain the full account number before issuing the request.'}
              columns={['#', 'Account (as in source)', 'Bank', 'IFSC', 'Amount']}
              rows={masked.map((m, i) => [i + 1, m.account_no, m.bank_name, m.ifsc_code || '—', money(m.amount)])}
              total={money(masked.reduce((s, m) => s + Number(m.amount || 0), 0))}
              monoCols={[1, 3]}
            />
          )}
        </div>
      )}
    </div>
  );
}

// ─── Formal letter (on-screen) ───────────────────────────────────────────────
//
// Renders the backend `letter` model as a proper document in the app font: a
// dated addressee block, subject/reference, flowing paragraphs, a real account
// table (Account / IFSC / Amount + TOTAL), the numbered requests, the statutory
// closing, and the officer signature block. NOT a monospace ASCII dump.
function FormalLetter({ letter, dateStr }) {
  const o = letter.officer || {};
  return (
    <article className="letter-doc">
      <p className="doc-date">Date: {dateStr}</p>

      <div className="doc-addressee">
        <div>To,</div>
        <div>The Nodal Officer / Principal Officer,</div>
        <div className="doc-bank">{letter.bank_name}</div>
      </div>

      <p className="doc-field"><span className="doc-field-label">Subject:</span> {letter.subject}</p>
      <p className="doc-field"><span className="doc-field-label">Reference:</span> {letter.reference}</p>

      <p className="doc-salutation">{letter.salutation}</p>
      <p className="doc-para">{letter.intro}</p>

      <div className="table-wrap">
        <table className="letter-acct-table">
          <thead>
            <tr>
              <th className="c-sno">S.No</th>
              <th>Account Number</th>
              <th>IFSC Code</th>
              <th className="c-amt">Amount Involved</th>
            </tr>
          </thead>
          <tbody>
            {letter.accounts.map((a) => (
              <tr key={a.sno}>
                <td className="c-sno">{a.sno}</td>
                <td className="mono">{a.account_no || '—'}</td>
                <td className="mono">{a.ifsc_code || '—'}</td>
                <td className="c-amt money-accent">{rs(a.amount)}</td>
              </tr>
            ))}
            <tr className="doc-total">
              <td colSpan={3} className="c-amt">TOTAL</td>
              <td className="c-amt money-accent">{rs(letter.total)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="doc-para">{letter.requests_intro}</p>
      <ol className="doc-requests">
        {letter.requests.map((r, i) => <li key={i}>{r}</li>)}
      </ol>

      <p className="doc-para">{letter.closing}</p>

      <div className="doc-signature">
        <div>{letter.signoff}</div>
        <div className="doc-sig-name">{o.name}</div>
        <div>{o.designation}</div>
        <div>{o.unit}</div>
        <div>{o.police_station}</div>
        <div>Phone: {o.phone} &nbsp;&nbsp; Email: {o.email}</div>
      </div>

      <p className="doc-footer">{letter.footer}</p>
    </article>
  );
}

// ─── Non-actionable section (wallet / masked) ────────────────────────────────
//
// Caution-styled card (amber left rail + tinted header) so it reads clearly as
// "needs extra verification — NOT a ready-to-send letter", distinct from the
// bank-letter cards. Carries instruments pulled OUT of the §102 letters, with
// amounts, so the evidence is never dropped. The last column is the amount
// (right-aligned, money-green); `monoCols` renders identifier columns in mono.
function NonActionableSection({ icon, title, count, intro, columns, rows, total, monoCols = [] }) {
  const mono = new Set(monoCols);
  const lastCol = columns.length - 1;
  return (
    <section className="card nonactionable-section" aria-label={title}>
      <div className="nonactionable-head">
        <span className="nonactionable-icon" aria-hidden="true">{icon}</span>
        <h2 className="nonactionable-title">{title}</h2>
        <span className="nonactionable-count">{count}</span>
      </div>
      <p className="nonactionable-note">{intro}</p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>{columns.map((c, i) => (
              <th key={c} style={i === lastCol ? { textAlign: 'right' } : undefined}>{c}</th>
            ))}</tr>
          </thead>
          <tbody>
            {rows.map((r, ri) => (
              <tr key={ri}>
                {r.map((cell, ci) => (
                  <td
                    key={ci}
                    className={ci === lastCol ? 'money-accent' : undefined}
                    style={{
                      textAlign: ci === lastCol ? 'right' : undefined,
                      fontWeight: ci === lastCol ? 700 : undefined,
                      fontFamily: mono.has(ci) ? 'var(--font-mono)' : undefined,
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
            <tr className="nonactionable-total">
              <td colSpan={lastCol} style={{ textAlign: 'right', fontWeight: 600 }}>Total (excluded from the bank letters above)</td>
              <td className="money-accent" style={{ textAlign: 'right', fontWeight: 700 }}>{total}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  );
}

// ─── Word export helpers (model → formal HTML) ───────────────────────────────

// One formal letter as Word-friendly HTML (real account table, not a <pre>).
// Falls back to the plain-text body if the structured model is absent.
function letterToWordHtml(e) {
  const flagged = Array.isArray(e.flagged_accounts) ? e.flagged_accounts : [];
  const caveat = flagged.length
    ? `<p style="color:#9a3412;font-size:11px"><strong>Reviewer note (verify before dispatch — not part of the letter):</strong> the bank for account(s) ${esc(flagged.join(', '))} could not be confirmed from a valid IFSC. Verify the freeze target before sending.</p>`
    : '';
  const L = e.letter;
  if (!L) {
    return `<h2 style="font-family:Arial">${esc(e.bank_name)}</h2>${caveat}<pre style="font-family:'Courier New';white-space:pre-wrap">${esc(letterText(e))}</pre><hr/>`;
  }
  const o = L.officer || {};
  const rowsHtml = L.accounts.map((a) => `<tr>
      <td align="center">${a.sno}</td>
      <td style="font-family:Consolas,monospace">${esc(a.account_no || '—')}</td>
      <td style="font-family:Consolas,monospace">${esc(a.ifsc_code || '—')}</td>
      <td align="right">${esc(rs(a.amount))}</td></tr>`).join('');
  return `
    <h2 style="font-family:Arial">${esc(L.bank_name)}</h2>
    <p style="font-family:Arial;color:#555"><strong>To:</strong> ${esc(bankEmailPlaceholder(L.bank_name))} <em>(placeholder — confirm the bank's nodal-officer address)</em></p>
    ${caveat}
    <div style="font-family:'Times New Roman',serif;font-size:12pt;line-height:1.5">
      <p align="right">Date: ${esc(letterDateUTC())}</p>
      <p>To,<br/>The Nodal Officer / Principal Officer,<br/><strong>${esc(L.bank_name)}</strong></p>
      <p><strong>Subject:</strong> ${esc(L.subject)}</p>
      <p><strong>Reference:</strong> ${esc(L.reference)}</p>
      <p>${esc(L.salutation)}</p>
      <p>${esc(L.intro)}</p>
      <table border="1" cellspacing="0" cellpadding="5" style="border-collapse:collapse;font-size:11pt">
        <tr style="background:#f0f0f0"><th>S.No</th><th>Account Number</th><th>IFSC Code</th><th>Amount Involved</th></tr>
        ${rowsHtml}
        <tr><td colspan="3" align="right"><strong>TOTAL</strong></td><td align="right"><strong>${esc(rs(L.total))}</strong></td></tr>
      </table>
      <p>${esc(L.requests_intro)}</p>
      <ol>${L.requests.map((r) => `<li>${esc(r)}</li>`).join('')}</ol>
      <p>${esc(L.closing)}</p>
      <p>${esc(L.signoff)}<br/><strong>${esc(o.name)}</strong><br/>${esc(o.designation)}<br/>${esc(o.unit)}<br/>${esc(o.police_station)}<br/>Phone: ${esc(o.phone)} &nbsp;&nbsp; Email: ${esc(o.email)}</p>
      <p style="font-size:9pt;color:#777;border-top:1px solid #ccc;padding-top:6px">${esc(L.footer)}</p>
    </div>
    <hr/>`;
}

// One non-actionable section as a Word table.
function sectionToWordHtml(title, intro, columns, rows, total) {
  const head = columns.map((c) => `<th>${esc(c)}</th>`).join('');
  const body = rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`).join('');
  const totalRow = `<tr><td colspan="${columns.length - 1}" align="right"><strong>Total</strong></td><td><strong>${esc(total)}</strong></td></tr>`;
  return `
    <h1 style="font-family:Arial">${esc(title)}</h1>
    <p style="font-family:Arial">${intro}</p>
    <table border="1" cellspacing="0" cellpadding="4" style="font-family:Arial;border-collapse:collapse">
      <tr style="background:#f0f0f0">${head}</tr>
      ${body}${totalRow}
    </table><hr/>`;
}
