/**
 * Lien Tracker page.
 *
 * Total recoverable amount up top, four summary cards, then a worksheet of
 * lien-eligible accounts. Status is an inline dropdown that auto-saves
 * (optimistic, with rollback on failure); rows can be multi-selected for a
 * bulk "Mark All as Applied". A lien-template download is provided.
 *
 * Merges getLiens(id) (status/applied_date/remarks) with the report's
 * analysis_json.lien_calculation (received/forwarded/eligible/layer) by
 * account_no. Status changes call saveLien optimistically with rollback.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import StatCard from '../components/StatCard.jsx';
import Badge from '../components/Badge.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { SkeletonStats, SkeletonTable } from '../components/Skeleton.jsx';
import { formatCrore, formatINR, formatDate, formatPercent } from '../utils/format.js';
import { getLiens, getReport, saveLien, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

const STATUSES = ['pending', 'applied', 'success', 'rejected'];

export default function Lien() {
  const reportId = useActiveReportId();

  const [liens, setLiens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [toast, setToast] = useState(null);

  // Persisted lien rows (status/applied_date/remarks) carry only what the DB
  // stores; the per-account analysis (received/forwarded/eligible/layer) lives
  // in the report's analysis_json. Fetch both and merge by account_no.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    Promise.all([getLiens(reportId), getReport(reportId)])
      .then(([lienRows, report]) => {
        if (cancelled) return;
        const calc = report.analysis_json?.lien_calculation || [];
        const byAccount = new Map(calc.map((c) => [c.account_no, c]));
        setLiens(lienRows.map((l) => {
          const c = byAccount.get(l.account_no) || {};
          return {
            ...l,
            total_received: c.total_received ?? null,
            total_forwarded: c.total_forwarded ?? null,
            lien_eligible_amount: c.lien_eligible_amount ?? l.lien_amount ?? 0,
            layer_no: c.layer_no ?? null,
          };
        }));
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

  // ── Summary ────────────────────────────────────────────────────────────────
  const summary = useMemo(() => {
    let eligible = 0; let applied = 0; let success = 0;
    for (const l of liens) {
      eligible += l.lien_eligible_amount || 0;
      if (l.lien_status === 'applied') applied += l.lien_eligible_amount || 0;
      if (l.lien_status === 'success') success += l.lien_eligible_amount || 0;
    }
    return { eligible, applied, success, recoveryRate: eligible > 0 ? success / eligible : 0 };
  }, [liens]);

  // ── Optimistic inline status update (context pattern #3) ─────────────────────
  const updateStatus = async (lien, newStatus) => {
    if (newStatus === lien.lien_status) return false;
    const prevStatus = lien.lien_status;
    const prevApplied = lien.applied_date;
    setSaveError(null);
    setSavingId(lien.id);
    // Optimistic: reflect the change immediately, stamp applied_date if leaving pending.
    setLiens((rows) => rows.map((r) => (
      r.id === lien.id
        ? { ...r, lien_status: newStatus, applied_date: r.applied_date || (newStatus !== 'pending' ? new Date().toISOString() : null) }
        : r
    )));

    try {
      const saved = await saveLien(reportId, { account_no: lien.account_no, lien_status: newStatus });
      // Reconcile with the server's authoritative status + applied_date.
      setLiens((rows) => rows.map((r) => (
        r.id === lien.id ? { ...r, lien_status: saved.lien_status, applied_date: saved.applied_date } : r
      )));
      setSavingId(null);
      return true;
    } catch (err) {
      // Rollback on failure.
      setLiens((rows) => rows.map((r) => (
        r.id === lien.id ? { ...r, lien_status: prevStatus, applied_date: prevApplied } : r
      )));
      setSaveError(err);
      setSavingId(null);
      return false;
    }
  };

  const handleStatusChange = async (lien, newStatus) => {
    const ok = await updateStatus(lien, newStatus);
    if (ok) setToast(`Lien for ${lien.account_no} set to "${newStatus}".`);
  };

  // ── Bulk select + apply ──────────────────────────────────────────────────────
  const allSelected = liens.length > 0 && selected.size === liens.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(liens.map((l) => l.id)));
  const toggleOne = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const markSelectedApplied = async () => {
    const targets = liens.filter((l) => selected.has(l.id) && l.lien_status !== 'applied');
    let applied = 0;
    for (const t of targets) {
      // eslint-disable-next-line no-await-in-loop
      const ok = await updateStatus(t, 'applied');
      if (ok) applied += 1;
    }
    setSelected(new Set());
    if (applied > 0) setToast(`Marked ${applied} account(s) as applied.`);
  };

  const downloadTemplate = () => {
    // Lien-request worksheet for the bank. Phase 6 may swap CSV for a true .xlsx.
    const header = ['Account No', 'Bank', 'IFSC', 'Layer', 'Total Received', 'Total Forwarded', 'Lien Eligible', 'Status'];
    const rows = liens.map((l) => [l.account_no, l.bank_name, l.ifsc_code, `L${l.layer_no}`, l.total_received, l.total_forwarded, l.lien_eligible_amount, l.lien_status]);
    const csv = [header, ...rows].map((r) => r.map((c) => `"${String(c ?? '')}"`).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    const a = document.createElement('a');
    a.href = url; a.download = 'lien-template.csv'; a.click();
    URL.revokeObjectURL(url);
  };

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Lien Tracker</h1>
          <p className="subtitle">Loading lien worksheet…</p>
        </header>
        <SkeletonStats count={4} />
        <SkeletonTable rows={8} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Lien Tracker</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load liens"
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
            background: 'var(--accent)', color: '#fff', padding: '10px 16px',
            borderRadius: 'var(--radius)', boxShadow: '0 4px 16px rgba(0,0,0,0.18)',
            fontSize: 13, fontWeight: 600,
          }}
        >
          ✓ {toast}
        </div>
      )}
      <header className="page-header">
        <h1>Lien Tracker</h1>
        <p className="subtitle">
          Total lien-eligible: <strong style={{ color: 'var(--accent)', fontSize: 16 }}>{formatINR(summary.eligible)}</strong>
        </p>
      </header>

      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard title="Total Eligible" value={formatCrore(summary.eligible)} icon="💰" color="var(--accent)" />
        <StatCard title="Lien Applied" value={formatCrore(summary.applied)} icon="📨" color="var(--brand)" />
        <StatCard title="Lien Success" value={formatCrore(summary.success)} icon="✅" color="var(--accent)" />
        <StatCard title="Recovery Rate" value={formatPercent(summary.recoveryRate, 1)} subtitle="success ÷ eligible" icon="📈" color="var(--accent-orange)" />
      </div>

      {saveError && (
        <div style={{ marginBottom: 16 }}>
          <ErrorAlert error={saveError} title="Status update failed" onRetry={() => setSaveError(null)} />
        </div>
      )}

      <div className="card card-pad">
        <div className="table-toolbar">
          <button type="button" className="btn btn-sm btn-primary" disabled={selected.size === 0} onClick={markSelectedApplied}>
            Mark All as Applied{selected.size > 0 ? ` (${selected.size})` : ''}
          </button>
          <span className="spacer" />
          <button type="button" className="btn btn-sm" onClick={downloadTemplate}>⬇ Download Lien Template</button>
        </div>

        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                </th>
                <th>Account No.</th>
                <th>Bank</th>
                <th>IFSC</th>
                <th>Layer</th>
                <th style={{ textAlign: 'right' }}>Received</th>
                <th style={{ textAlign: 'right' }}>Forwarded</th>
                <th style={{ textAlign: 'right' }}>Lien Eligible</th>
                <th>Status</th>
                <th>Applied</th>
                <th>Remarks</th>
              </tr>
            </thead>
            <tbody>
              {liens.length === 0 ? (
                <tr><td colSpan={11}><div className="empty-state">No accounts are lien-eligible for this report. Every disputed inflow in this trail was already withdrawn as cash, so there is no remaining balance to place a lien on.</div></td></tr>
              ) : (
                liens.map((l) => (
                  <tr key={l.id}>
                    <td><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} aria-label={`Select ${l.account_no}`} /></td>
                    <td>{l.account_no}</td>
                    <td>{l.bank_name || '—'}</td>
                    <td>{l.ifsc_code || '—'}</td>
                    <td>{l.layer_no == null ? '—' : `L${l.layer_no}`}</td>
                    <td style={{ textAlign: 'right' }}>{formatINR(l.total_received)}</td>
                    <td style={{ textAlign: 'right' }}>{formatINR(l.total_forwarded)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatINR(l.lien_eligible_amount)}</td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <select
                          className="select"
                          value={l.lien_status}
                          disabled={savingId === l.id}
                          onChange={(e) => handleStatusChange(l, e.target.value)}
                          style={{ padding: '4px 6px', fontSize: 12 }}
                        >
                          {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                        </select>
                        {savingId === l.id && <span className="spinner" style={{ width: 12, height: 12 }} />}
                      </div>
                    </td>
                    <td>{formatDate(l.applied_date)}</td>
                    <td style={{ maxWidth: 220, color: 'var(--text-muted)' }}>{l.remarks || '—'}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
