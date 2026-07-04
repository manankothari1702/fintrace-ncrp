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

import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import StatCard from '../components/StatCard.jsx';
import Badge from '../components/Badge.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { AccountLink } from '../components/EntityLink.jsx';
import { SkeletonStats, SkeletonTable } from '../components/Skeleton.jsx';
import { formatCrore, formatINR, formatDate, formatPercent } from '../utils/format.js';
import { getLiens, getReport, saveLien, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';
import { useSortableRows } from '../utils/useSortableRows.js';

const STATUSES = ['pending', 'applied', 'success', 'rejected'];

// Interpretation copy (Batch 2, Area 1). The recoverable-amount definition prints
// the ACTUAL lien formula verified in code (see LienBreakdown / buildAccountRollup):
// lien = min(Received − Forwarded − Cash-out − On Hold, Disputed inflow), floored
// at 0 — not an assumed formula.
const ELIGIBLE_TIP = 'Freezable balance still sitting in the mule accounts: '
  + 'Received − Forwarded − Cash-out − On Hold, capped at each account’s disputed '
  + 'inflow (never below zero). This is the amount a Section 102 lien can target.';
// Recovery-rate band reuses Batch 1’s Recovery Rate thresholds as the source of
// truth (RECOVERY_RATE_AMBER_PCT=25, RECOVERY_RATE_RED_PCT=0 in
// backend/src/lib/thresholds.js) — same numbers, no new thresholds decided here.
const RECOVERY_RATE_AMBER_PCT = 25;
const RECOVERY_TIP = 'Share of the lien-eligible funds actually recovered so far — '
  + 'lien successes ÷ total eligible. Under 25% needs chasing; 0% means nothing '
  + 'has been recovered yet.';

/** Recovery-rate colour band, consistent with the Dashboard Recovery Rate card. */
function recoveryRateColor(ratio) {
  const pct = (Number(ratio) || 0) * 100;
  if (pct <= 0) return 'var(--risk-high)';
  if (pct < RECOVERY_RATE_AMBER_PCT) return 'var(--risk-medium)';
  return 'var(--risk-low)';
}

export default function Lien() {
  const reportId = useActiveReportId();

  const [liens, setLiens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saveError, setSaveError] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [selected, setSelected] = useState(() => new Set());
  const [expanded, setExpanded] = useState(() => new Set());
  const [toast, setToast] = useState(null);

  // Per-row expand toggle: the verbose justification + the full reconciling
  // breakdown live in an expandable detail row (matching the Mules page), so the
  // worksheet itself stays compact and uniform-height.
  const toggleExpand = (id) => setExpanded((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

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
        // Accounts whose bank could NOT be confirmed from a valid IFSC — the exact
        // actionable freeze-target set the Data Quality page flags. A Section 102
        // letter would target an unverified bank, so the row gets a "verify bank"
        // caution. Reused as-is from the analysis snapshot; never recomputed here.
        const freezeTargets = new Set(
          report.analysis_json?.data_quality_summary?.freeze_target_accounts || [],
        );
        setLiens(lienRows.map((l) => {
          const c = byAccount.get(l.account_no) || {};
          return {
            ...l,
            // Full derivation legs (from the analyzer snapshot) so the table
            // reconciles on its face: Received − Forwarded − Cash-out − On Hold
            // = Gross; Lien Eligible = min(Gross, Disputed cap). All read as-is.
            total_received: c.total_received ?? null,
            onward_forwarded: c.onward_forwarded ?? null,
            total_cashed_out: c.total_cashed_out ?? null,
            total_on_hold: c.total_on_hold ?? null,
            total_forwarded: c.total_forwarded ?? null,
            gross_balance: c.gross_balance ?? null,
            disputed_received: c.disputed_received ?? null,
            lien_eligible_amount: c.lien_eligible_amount ?? l.lien_amount ?? 0,
            layer_no: c.layer_no ?? null,
            needs_bank_verify: freezeTargets.has(l.account_no),
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

  // Click-to-sort over the worksheet (default: largest freezable balance first).
  const { sorted, toggle: toggleSort, indicator } = useSortableRows(
    liens, { key: 'lien_eligible_amount', dir: 'desc' },
  );

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
    const header = ['Account No', 'Bank', 'IFSC', 'Layer', 'Received', 'Forwarded', 'Cash-out', 'On Hold', 'Gross Balance', 'Disputed Inflow', 'Lien Eligible', 'Status', 'Bank Verified'];
    const rows = liens.map((l) => [l.account_no, l.bank_name, l.ifsc_code, `L${l.layer_no}`, l.total_received, l.onward_forwarded, l.total_cashed_out, l.total_on_hold, l.gross_balance, l.disputed_received, l.lien_eligible_amount, l.lien_status, l.needs_bank_verify ? 'VERIFY' : 'IFSC-confirmed']);
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
            background: 'var(--accent)', color: 'var(--text-on-solid)', padding: '10px 16px',
            borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
            fontSize: 13, fontWeight: 600,
          }}
        >
          ✓ {toast}
        </div>
      )}
      <header className="page-header">
        <h1>Lien Tracker</h1>
        <p className="subtitle">
          Total lien-eligible: <strong className="money-accent" style={{ fontSize: 16 }}>{formatINR(summary.eligible)}</strong>
        </p>
      </header>

      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard title="Total Eligible" value={formatCrore(summary.eligible)} subtitle="freezable balance" icon="💰" color="var(--accent)" info={ELIGIBLE_TIP} />
        <StatCard title="Lien Applied" value={formatCrore(summary.applied)} icon="📨" color="var(--brand-text)" />
        <StatCard title="Lien Success" value={formatCrore(summary.success)} icon="✅" color="var(--accent)" />
        <StatCard title="Recovery Rate" value={formatPercent(summary.recoveryRate, 1)} subtitle="success ÷ eligible" icon="📈" color={recoveryRateColor(summary.recoveryRate)} info={RECOVERY_TIP} />
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
          <table className="data-table lien-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
                </th>
                <th style={{ width: 28 }} aria-label="Expand" />
                <th className="th-sort" onClick={() => toggleSort('account_no')}>Account No.<span className="sort-ind">{indicator('account_no')}</span></th>
                <th className="th-sort" onClick={() => toggleSort('bank_name')}>Bank<span className="sort-ind">{indicator('bank_name')}</span></th>
                <th className="th-sort" onClick={() => toggleSort('ifsc_code')}>IFSC<span className="sort-ind">{indicator('ifsc_code')}</span></th>
                <th className="th-sort" onClick={() => toggleSort('layer_no')}>Layer<span className="sort-ind">{indicator('layer_no')}</span></th>
                <th className="th-sort" style={{ textAlign: 'right' }} onClick={() => toggleSort('total_received')}>Received<span className="sort-ind">{indicator('total_received')}</span></th>
                <th className="th-sort" style={{ textAlign: 'right' }} title="min(Gross residue, Disputed cap) — the amount placed in the freeze letter. Expand a row for the full derivation." onClick={() => toggleSort('lien_eligible_amount')}>Lien Eligible<span className="sort-ind">{indicator('lien_eligible_amount')}</span></th>
                <th className="th-sort" onClick={() => toggleSort('lien_status')}>Status<span className="sort-ind">{indicator('lien_status')}</span></th>
                <th className="th-sort" onClick={() => toggleSort('applied_date')}>Applied<span className="sort-ind">{indicator('applied_date')}</span></th>
              </tr>
            </thead>
            <tbody>
              {liens.length === 0 ? (
                <tr><td colSpan={10}><div className="empty-state">No accounts are lien-eligible for this report. Every disputed inflow in this trail has left the beneficiary accounts (forwarded onward, withdrawn as cash, or already on hold), so there is no remaining balance to place a lien on.</div></td></tr>
              ) : (
                sorted.map((l) => {
                  const isOpen = expanded.has(l.id);
                  return (
                    <Fragment key={l.id}>
                      <tr className={isOpen ? 'lien-row-open' : undefined}>
                        <td><input type="checkbox" checked={selected.has(l.id)} onChange={() => toggleOne(l.id)} aria-label={`Select ${l.account_no}`} /></td>
                        <td>
                          <button
                            type="button"
                            className={`row-expander${isOpen ? ' is-open' : ''}`}
                            aria-expanded={isOpen}
                            aria-label={isOpen ? 'Hide breakdown' : 'Show breakdown'}
                            title={isOpen ? 'Hide breakdown' : 'Show the recoverable-balance breakdown & justification'}
                            onClick={() => toggleExpand(l.id)}
                          >
                            ▸
                          </button>
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)' }}><AccountLink account={l.account_no} /></td>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                            <span
                              title={l.bank_name || undefined}
                              style={{ display: 'inline-block', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
                            >
                              {l.bank_name || '—'}
                            </span>
                            {l.needs_bank_verify && (
                              <span
                                className="freeze-flag"
                                title="Bank not confirmed from a valid IFSC — verify the freeze target before issuing this lien letter."
                              >
                                ⚠ verify bank
                              </span>
                            )}
                          </div>
                        </td>
                        <td style={{ fontFamily: 'var(--font-mono)' }}>{l.ifsc_code || '—'}</td>
                        <td>{l.layer_no == null ? '—' : `L${l.layer_no}`}</td>
                        <td style={{ textAlign: 'right' }}>{formatINR(l.total_received)}</td>
                        <td className="money-accent" style={{ textAlign: 'right', fontWeight: 700 }}>{formatINR(l.lien_eligible_amount)}</td>
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
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={10} className="expanded-cell">
                            <LienBreakdown lien={l} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Expanded detail: reconciling breakdown + full justification ─────────────

/**
 * The per-row detail panel: the lien-eligible figure derived left-to-right
 * (Received − Forwarded − Cash-out − On Hold = Gross residue, capped at the
 * Disputed inflow), followed by the full plain-language justification note.
 * Pure presentation — every value is read straight from the merged row.
 */
function LienBreakdown({ lien: l }) {
  const capped = l.gross_balance != null && l.disputed_received != null
    && (Number(l.gross_balance) - Number(l.lien_eligible_amount)) > 0.005;

  const Term = ({ op, label, value, final = false }) => (
    <div className="lien-calc-term">
      {op && <span className="lien-calc-op">{op}</span>}
      <span className={`lien-calc-box${final ? ' is-final' : ''}`}>
        <span className="lien-calc-label">{label}</span>
        <span className={`lien-calc-val${final ? ' money-accent' : ''}`}>{formatINR(value)}</span>
      </span>
    </div>
  );

  return (
    <div className="lien-detail">
      <h4 className="lien-detail-title">How the lien-eligible figure is derived</h4>
      <div className="lien-calc">
        <Term label="Received" value={l.total_received} />
        <Term op="−" label="Forwarded" value={l.onward_forwarded} />
        <Term op="−" label="Cash-out" value={l.total_cashed_out} />
        <Term op="−" label="On Hold" value={l.total_on_hold} />
        <Term op="=" label="Gross residue" value={l.gross_balance} />
        <Term op={capped ? 'capped at' : 'within'} label="Disputed inflow" value={l.disputed_received} />
        <Term op="=" label="Lien Eligible" value={l.lien_eligible_amount} final />
      </div>
      {l.remarks && <p className="lien-detail-note">{l.remarks}</p>}
    </div>
  );
}
