/**
 * Data Quality page (FinTrace v0.2.0 — bank attribution).
 *
 * Lists every account whose bank could not be silently confirmed from a clean
 * IFSC: the lien letter uses the IFSC-authoritative name, and the source-file
 * text is shown here so the investigating officer can verify the freeze target
 * before dispatch. The financial amounts are unaffected — only the bank
 * attribution is flagged.
 *
 * Data comes from the analysis snapshot via getDataQuality(id). Each row's
 * `bank_flag` drives a coloured pill + a plain-language reviewer message.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import StatCard from '../components/StatCard.jsx';
import Badge from '../components/Badge.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { SkeletonStats, SkeletonTable } from '../components/Skeleton.jsx';
import { getDataQuality, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

// Flag → display label + colour. Mismatches are the most actionable (the letter
// bank differs from the source text), so they get the warning colour.
const FLAG_META = {
  IFSC_TEXT_MISMATCH: { label: 'IFSC vs text', color: 'var(--accent-orange)' },
  UNKNOWN_IFSC_PREFIX: { label: 'Unknown prefix', color: 'var(--accent-orange)' },
  INVALID_IFSC: { label: 'Invalid IFSC', color: 'var(--text-muted)' },
  NO_IFSC: { label: 'No IFSC (wallet/PA/PG)', color: 'var(--text-muted)' },
};

function flagMeta(flag) {
  return FLAG_META[flag] || { label: flag || '—', color: 'var(--text-muted)' };
}

export default function DataQuality() {
  const reportId = useActiveReportId();

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    getDataQuality(reportId)
      .then((data) => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [reportId]);

  // Order for review priority: actionable freeze-targets first (a lien letter
  // is about to go to an unconfirmed bank), then other actionable rows, then
  // informational (auto-corrected / expected) rows. Rows from reports analysed
  // before the severity model carry no `severity` and keep their server order.
  const sortedRows = useMemo(() => {
    const rank = (r) => {
      if (r.severity === undefined) return 1;
      if (r.severity === 'actionable') return r.freeze_target ? 0 : 1;
      return 2;
    };
    return [...rows].sort((a, b) => rank(a) - rank(b));
  }, [rows]);

  const counts = useMemo(() => {
    const c = {
      total: rows.length, mismatch: 0, noIfsc: 0, unknown: 0,
      actionable: 0, freezeTargets: 0, hasSeverity: rows.some((r) => r.severity !== undefined),
    };
    for (const r of rows) {
      if (r.bank_flag === 'IFSC_TEXT_MISMATCH') c.mismatch += 1;
      else if (r.bank_flag === 'NO_IFSC' || r.bank_flag === 'INVALID_IFSC') c.noIfsc += 1;
      else if (r.bank_flag === 'UNKNOWN_IFSC_PREFIX') c.unknown += 1;
      if (r.severity === 'actionable') {
        c.actionable += 1;
        if (r.freeze_target) c.freezeTargets += 1;
      }
    }
    return c;
  }, [rows]);

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Data Quality</h1>
          <p className="subtitle">Loading bank-attribution review…</p>
        </header>
        <SkeletonStats count={3} />
        <SkeletonTable rows={8} />
      </div>
    );
  }
  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Data Quality</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load data quality"
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
      <header className="page-header">
        <h1>Data Quality — Bank Attribution</h1>
        <p className="subtitle">
          The bank on every lien letter is derived from the account&apos;s IFSC (authoritative).
          {' '}
          The accounts below differed from the source-file text or had no usable IFSC —
          {' '}
          <strong>verify the freeze target before dispatch.</strong> Amounts are unaffected.
        </p>
      </header>

      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        {counts.hasSeverity ? (
          <>
            <StatCard
              title="Freeze targets to verify"
              value={counts.freezeTargets}
              subtitle="lien-table accounts, unconfirmed bank"
              icon="⛔"
              color={counts.freezeTargets > 0 ? 'var(--danger)' : 'var(--accent)'}
            />
            <StatCard
              title="Actionable flags"
              value={counts.actionable}
              subtitle="need bank verification"
              icon="🔎"
              color={counts.actionable > 0 ? 'var(--accent-orange)' : 'var(--accent)'}
            />
            <StatCard title="Auto-corrected from IFSC" value={counts.mismatch} subtitle="source text disagreed (resolved)" icon="✓" color="var(--brand)" />
          </>
        ) : (
          <>
            <StatCard title="Accounts to verify" value={counts.total} icon="🔎" color="var(--accent-orange)" />
            <StatCard title="IFSC vs text mismatch" value={counts.mismatch} subtitle="letter uses the IFSC bank" icon="⚠️" color="var(--accent-orange)" />
            <StatCard title="Wallet / no IFSC" value={counts.noIfsc} subtitle="confirm nodal entity" icon="👛" color="var(--brand)" />
          </>
        )}
      </div>

      <div className="card card-pad">
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Account No.</th>
                <th>Resolved Bank (on letter)</th>
                <th>IFSC</th>
                <th>Source-file Text</th>
                <th>Flag</th>
                <th>Reviewer Note</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <div className="empty-state">
                      ✓ No bank-attribution issues. Every account resolved cleanly from a valid
                      IFSC that agreed with the source file — no manual verification needed.
                    </div>
                  </td>
                </tr>
              ) : (
                sortedRows.map((r) => {
                  const meta = flagMeta(r.bank_flag);
                  return (
                    <tr key={r.account_no}>
                      <td>
                        {r.account_no}
                        {r.severity === 'actionable' && r.freeze_target && (
                          <div><Badge color="var(--danger)">Freeze target</Badge></div>
                        )}
                      </td>
                      <td style={{ fontWeight: 600 }}>{r.bank || '—'}</td>
                      <td>{r.ifsc_code || '—'}</td>
                      <td style={{ color: 'var(--text-muted)' }}>{r.raw_bank || '(blank)'}</td>
                      <td>
                        <Badge color={r.severity === 'informational' ? 'var(--text-muted)' : meta.color}>
                          {meta.label}
                        </Badge>
                        {r.severity === 'informational' && (
                          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>resolved / expected</div>
                        )}
                      </td>
                      <td style={{ maxWidth: 360, color: 'var(--text-muted)', fontSize: 12 }}>{r.message}</td>
                    </tr>
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
