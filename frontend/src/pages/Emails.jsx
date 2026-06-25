/**
 * Draft Lien Request Emails page.
 *
 * One formal §102 letter per ACTIONABLE bank, shown as an accordion of preview
 * cards: subject, a To placeholder, the body in monospace, and Copy / Mark-as-
 * Sent actions. Wallet / PA / VPA instruments and masked-account rows are pulled
 * OUT of the bank letters into two separate, clearly-labelled non-actionable
 * sections (a wallet can't place a §102 lien; a bank can't act on a masked
 * number) — visible, with amounts, so nothing is dropped. The whole set
 * (letters + both sections) can be exported as a Word document. The tool never
 * sends mail — the officer copies each letter into their own client.
 *
 * Loads getEmails(id) → { emails, wallet_instruments, masked_accounts }.
 * "Mark as Sent" calls updateEmailStatus optimistically (rolled back on
 * failure). Copy uses the clipboard API. The letter date is injected at render/
 * copy/export time (the stored body is date-free), so a copied letter is always
 * current.
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
// IST wall-clock relabelled UTC; the issue date is "today" read in UTC so it is
// deterministic and never off-by-one near IST midnight).
function letterDateUTC(d = new Date()) {
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// The full copyable letter text = current date line + the stored (date-free) body.
function letterText(email) {
  return `Date: ${letterDateUTC()}\n\n${email.body}`;
}

// Indian-grouped rupee amount to the paisa (these non-actionable amounts are
// small; show exact figures so the section totals reconcile to the lien total).
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
    // Lightweight .doc: Word opens HTML with a msword MIME type natively.
    const letterSections = emails.map((e) => {
      const flagged = Array.isArray(e.flagged_accounts) ? e.flagged_accounts : [];
      const caveat = flagged.length
        ? `<p style="font-family:Arial;color:#9a3412;font-size:11px"><strong>Reviewer note (verify before dispatch — not part of the letter):</strong> the bank for account(s) ${esc(flagged.join(', '))} could not be confirmed from a valid IFSC. Verify the freeze target before sending.</p>`
        : '';
      return `
      <h2 style="font-family:Arial">${esc(e.bank_name)}</h2>
      <p style="font-family:Arial"><strong>Subject:</strong> ${esc(e.subject)}</p>
      <p style="font-family:Arial"><strong>To:</strong> ${esc(bankEmailPlaceholder(e.bank_name))} <em>(placeholder — confirm the bank's nodal-officer address)</em></p>
      ${caveat}
      <pre style="font-family:'Courier New';white-space:pre-wrap">${esc(letterText(e))}</pre>
      <hr/>`;
    }).join('');

    const walletSection = wallet.length ? `
      <h1 style="font-family:Arial">Verify Nodal Entity — Wallet / PA / VPA Instruments</h1>
      <p style="font-family:Arial">These ${wallet.length} instrument(s) are payment wallets / aggregators / gateways or UPI VPAs, <strong>not bank accounts</strong> — a wallet/PA cannot place a Section 102 lien. Identify the nodal/escrow bank holding these funds before issuing a request; the "Source Ref" is the raw value from the source IFSC cell and is <strong>not</strong> a bank IFSC. Listed here so no instrument is dropped from the trail.</p>
      <table border="1" cellspacing="0" cellpadding="4" style="font-family:Arial;border-collapse:collapse">
        <tr><th>#</th><th>Instrument</th><th>Entity (as named in source)</th><th>Source Ref (not an IFSC)</th><th>Amount</th></tr>
        ${wallet.map((w, i) => `<tr><td>${i + 1}</td><td>${esc(w.account_no)}</td><td>${esc(w.bank_name)}</td><td>${esc(w.source_ref || '—')}</td><td>${esc(money(w.amount))}</td></tr>`).join('')}
        <tr><td colspan="4" style="text-align:right"><strong>Total</strong></td><td><strong>${esc(money(wallet.reduce((s, w) => s + Number(w.amount || 0), 0)))}</strong></td></tr>
      </table><hr/>` : '';

    const maskedSection = masked.length ? `
      <h1 style="font-family:Arial">Unresolvable / Masked Accounts — Non-Actionable</h1>
      <p style="font-family:Arial">These ${masked.length} account(s) carry a masked or unresolvable account number in the source (e.g. "XXXX", "NA") — a bank cannot action a freeze on an unidentifiable account. Obtain the full account number before issuing the request. Listed here so nothing is dropped.</p>
      <table border="1" cellspacing="0" cellpadding="4" style="font-family:Arial;border-collapse:collapse">
        <tr><th>#</th><th>Account (as in source)</th><th>Bank</th><th>IFSC</th><th>Amount</th></tr>
        ${masked.map((m, i) => `<tr><td>${i + 1}</td><td>${esc(m.account_no)}</td><td>${esc(m.bank_name)}</td><td>${esc(m.ifsc_code || '—')}</td><td>${esc(money(m.amount))}</td></tr>`).join('')}
        <tr><td colspan="4" style="text-align:right"><strong>Total</strong></td><td><strong>${esc(money(masked.reduce((s, m) => s + Number(m.amount || 0), 0)))}</strong></td></tr>
      </table><hr/>` : '';

    const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'>
      <head><meta charset="utf-8"><title>FinTrace Lien Letters</title></head>
      <body><h1 style="font-family:Arial">FinTrace — Lien Request Letters</h1>${letterSections}${walletSection}${maskedSection}</body></html>`;
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
        <button type="button" className="btn" onClick={downloadAllAsWord} disabled={nothing}>
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
                  onClick={() => toggleOpen(email.id)}
                  style={{ width: '100%', display: 'flex', alignItems: 'center', gap: 14, padding: '14px 18px', background: 'transparent', border: 'none', textAlign: 'left', cursor: 'pointer' }}
                  aria-expanded={isOpen}
                  aria-controls={bodyId}
                  title={isOpen ? 'Collapse this letter' : 'Expand this letter'}
                >
                  <span style={{ fontSize: 18 }}>✉️</span>
                  <strong>{email.bank_name}</strong>
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>{email.account_list.length} account(s)</span>
                  {flagged.length > 0 && (
                    <span className="freeze-flag" title="One or more accounts in this letter could not be confirmed from a valid IFSC — verify the freeze target before dispatch.">⚠ verify bank</span>
                  )}
                  <span className="spacer" style={{ flex: 1 }} />
                  <Badge color={email.status === 'sent' ? 'var(--accent)' : 'var(--text-muted)'}>{email.status}</Badge>
                  {/* Single chevron rotated by CSS: pointing down when expanded,
                      left when collapsed. The whole header row is the hit target. */}
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
                    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 12px', margin: '14px 0', fontSize: 13 }}>
                      <span style={{ color: 'var(--text-muted)' }}>Subject</span><span style={{ fontWeight: 600 }}>{email.subject}</span>
                      <span style={{ color: 'var(--text-muted)' }}>To</span><span>{bankEmailPlaceholder(email.bank_name)} <em style={{ color: 'var(--text-muted)' }}>(placeholder)</em></span>
                    </div>

                    {flagged.length > 0 && (
                      <div className="letter-caveat" role="note">
                        <strong>Reviewer note — verify before dispatch (not part of the letter):</strong>{' '}
                        the bank for account(s) <span style={{ fontFamily: 'var(--font-mono)' }}>{flagged.join(', ')}</span> could not be confirmed from a valid IFSC. Confirm the freeze target before sending — see Data Quality.
                      </div>
                    )}

                    <pre style={{
                      fontFamily: "'Courier New', ui-monospace, monospace", fontSize: 12.5, lineHeight: 1.55,
                      background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                      padding: 16, whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0,
                    }}>{letterText(email)}</pre>

                    <div className="letter-actions" style={{ display: 'flex', gap: 10, marginTop: 14 }}>
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

// ─── Non-actionable section (wallet / masked) ────────────────────────────────
//
// A labelled card carrying instruments pulled OUT of the §102 letters: visible,
// with amounts and an instructional note, so the evidence is never dropped. The
// last column is the amount (right-aligned, money-green); `monoCols` renders the
// listed columns in the mono font (account / reference identifiers).
function NonActionableSection({ title, count, intro, columns, rows, total, monoCols = [] }) {
  const mono = new Set(monoCols);
  const lastCol = columns.length - 1;
  return (
    <section className="card card-pad nonactionable-section" aria-label={title}>
      <h2 className="nonactionable-title">{title} <span className="nonactionable-count">{count}</span></h2>
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
