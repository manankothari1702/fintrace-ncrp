/**
 * Draft Lien Request Emails page.
 *
 * One formal lien-request letter per bank, shown as an accordion of preview
 * cards: subject, a To placeholder, the body in monospace, and Copy / Mark-as-
 * Sent actions. The whole set can be exported as a Word document. The tool
 * never sends mail — the officer copies each letter into their own client.
 *
 * Loads getEmails(id); "Mark as Sent" calls updateEmailStatus optimistically
 * (rolled back on failure). Copy uses the clipboard API.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import Badge from '../components/Badge.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { getEmails, updateEmailStatus, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

// Derive a plausible nodal-officer placeholder address from the bank name.
function bankEmailPlaceholder(bank) {
  const slug = bank.toLowerCase().replace(/\s*bank\s*/g, '').replace(/[^a-z]/g, '');
  return `nodal.officer@${slug || 'bank'}.example`;
}

export default function Emails() {
  const reportId = useActiveReportId();

  const [emails, setEmails] = useState([]);
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
      .then((rows) => {
        if (cancelled) return;
        setEmails(rows);
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
    navigator.clipboard.writeText(email.body)
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
    const sections = emails.map((e) => `
      <h2 style="font-family:Arial">${e.bank_name}</h2>
      <p style="font-family:Arial"><strong>Subject:</strong> ${e.subject}</p>
      <p style="font-family:Arial"><strong>To:</strong> ${bankEmailPlaceholder(e.bank_name)}</p>
      <pre style="font-family:'Courier New';white-space:pre-wrap">${e.body
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
      <hr/>`).join('');
    const html = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'>
      <head><meta charset="utf-8"><title>FinTrace Lien Letters</title></head>
      <body><h1 style="font-family:Arial">FinTrace — Lien Request Letters</h1>${sections}</body></html>`;
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
        <p className="subtitle">{emails.length} bank{emails.length === 1 ? '' : 's'} · one formal letter each, ready to copy into your email client.</p>
      </header>

      <div className="table-toolbar" style={{ marginBottom: 16 }}>
        <span className="spacer" />
        <button type="button" className="btn" onClick={downloadAllAsWord} disabled={emails.length === 0}>
          ⬇ Download All as Word Document
        </button>
      </div>

      {emails.length === 0 ? (
        <div className="card card-pad"><div className="empty-state">No draft letters for this report. A lien-request letter is generated automatically for each bank once an account carries a recoverable (lien-eligible) balance — see the Lien Tracker.</div></div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {emails.map((email) => {
            const isOpen = openIds.has(email.id);
            const bodyId = `letter-body-${email.id}`;
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

                    <pre style={{
                      fontFamily: "'Courier New', ui-monospace, monospace", fontSize: 12.5, lineHeight: 1.55,
                      background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                      padding: 16, whiteSpace: 'pre-wrap', overflowX: 'auto', margin: 0,
                    }}>{email.body}</pre>

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
        </div>
      )}
    </div>
  );
}
