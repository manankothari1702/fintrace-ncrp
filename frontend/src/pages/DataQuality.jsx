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
import { getDataQuality, getDuplicates, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { formatINR } from '../utils/format.js';
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
  const [duplicates, setDuplicates] = useState({ metrics: null, groups: [] });
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

    Promise.all([
      getDataQuality(reportId),
      // Duplicates are best-effort: a report analysed before this feature has no
      // suspected_duplicates section, so a failure here must not blank the page.
      getDuplicates(reportId).catch(() => ({ metrics: null, groups: [] })),
    ])
      .then(([dq, dup]) => {
        if (cancelled) return;
        setRows(Array.isArray(dq) ? dq : []);
        setDuplicates(dup && typeof dup === 'object' ? dup : { metrics: null, groups: [] });
      })
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

      <SuspectedDuplicates data={duplicates} />
    </div>
  );
}

// Duplicate status → display label + colour.
const DUP_META = {
  exact_duplicate: { label: 'Exact duplicate', color: 'var(--danger)' },
  probable_duplicate: { label: 'Probable (pending)', color: 'var(--accent-orange)' },
  primary: { label: 'Primary (kept)', color: 'var(--brand)' },
  unique: { label: 'Unique', color: 'var(--text-muted)' },
};

/**
 * Suspected-duplicate reconciliation + flagged groups. NON-DESTRUCTIVE: every
 * row is retained. Shows the auditable chain raw → deduped (exact only) →
 * probable pending, then each flagged group with row-level provenance.
 */
function SuspectedDuplicates({ data }) {
  const m = data && data.metrics;
  const groups = (data && Array.isArray(data.groups)) ? data.groups : [];

  if (!m) {
    return (
      <div className="card card-pad" style={{ marginTop: 24 }}>
        <h2 style={{ marginTop: 0 }}>Suspected Duplicates</h2>
        <div className="empty-state">
          No duplicate reconciliation available for this report (analysed before
          this feature was added). Re-run the analysis to populate it.
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 24 }}>
      <header className="page-header" style={{ marginBottom: 12 }}>
        <h2 style={{ marginBottom: 4 }}>Suspected Duplicates</h2>
        <p className="subtitle">
          NCRP re-lists the same leg across channel sheets. Every row below is
          {' '}<strong>retained</strong> — nothing is deleted or merged. The figures
          {' '}show the auditable reconciliation; capped recovery, lien and victim-loss
          {' '}totals are unaffected.
        </p>
      </header>

      <div className="grid grid-stats" style={{ marginBottom: 16 }}>
        <StatCard
          title="Transactions (raw)"
          value={m.transaction_count_raw}
          subtitle={`${m.transaction_count_deduped} after removing ${m.exact_duplicate_rows} exact + ${m.probable_duplicate_rows} probable`}
          icon="🧾"
          color="var(--brand)"
        />
        <StatCard
          title="Uncapped trail (raw)"
          value={formatINR(m.uncapped_trail_raw, { paise: true })}
          subtitle="every cash-exit leg, no dedup"
          icon="∑"
          color="var(--text-muted)"
        />
        <StatCard
          title="Uncapped trail (deduped)"
          value={formatINR(m.uncapped_trail_deduped, { paise: true })}
          subtitle={`headline — exact dups removed (−${formatINR(m.exact_duplicate_impact)})`}
          icon="✓"
          color="var(--accent)"
        />
        <StatCard
          title="Probable dups (pending)"
          value={formatINR(m.probable_duplicate_impact, { paise: true })}
          subtitle={`if confirmed → ${formatINR(m.uncapped_trail_if_probable_confirmed, { paise: true })}`}
          icon="⚖️"
          color={m.probable_duplicate_impact > 0 ? 'var(--accent-orange)' : 'var(--accent)'}
        />
      </div>

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <strong>Reconciliation chain.</strong>{' '}
        Raw {formatINR(m.uncapped_trail_raw, { paise: true })}
        {' → '}deduped (exact only) {formatINR(m.uncapped_trail_deduped, { paise: true })}
        {' → '}less {m.probable_duplicate_rows} probable duplicate(s)
        {' '}{formatINR(m.probable_duplicate_impact)}
        {' → '}{formatINR(m.uncapped_trail_if_probable_confirmed, { paise: true })}
        {' '}<span style={{ color: 'var(--text-muted)' }}>(pending investigator confirmation)</span>.
      </div>

      <div className="card card-pad">
        {groups.length === 0 ? (
          <div className="empty-state">
            ✓ No suspected duplicates. Every ledger row is a distinct transaction.
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Group (UTR / account)</th>
                  <th>Row</th>
                  <th>Date-time</th>
                  <th>Amount</th>
                  <th>Disputed</th>
                  <th>Terminal / secondary</th>
                  <th>Classification</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {groups.flatMap((g) => g.members.map((row, idx) => {
                  const meta = DUP_META[row.dup_status === 'unique' && row.role === 'primary'
                    ? 'primary' : row.dup_status] || DUP_META.unique;
                  return (
                    <tr key={`${g.primary_id}-${row.id}-${idx}`}>
                      {idx === 0 ? (
                        <td rowSpan={g.members.length} style={{ verticalAlign: 'top', fontSize: 12 }}>
                          <div style={{ fontFamily: 'monospace' }}>{g.utr}</div>
                          <div style={{ color: 'var(--text-muted)' }}>{g.account}</div>
                          <div style={{ marginTop: 4 }}>
                            <Badge color="var(--danger)">{g.exact_count} exact</Badge>{' '}
                            <Badge color="var(--accent-orange)">{g.probable_count} probable</Badge>
                          </div>
                        </td>
                      ) : null}
                      <td>#{row.id}</td>
                      <td style={{ fontSize: 12 }}>{(row.date || '—').replace('T', ' ').replace(/\.\d+Z?$/, '')}</td>
                      <td>{formatINR(row.amount, { paise: true })}</td>
                      <td>{formatINR(row.disputed, { paise: true })}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{(row.secondary_id || '').replace(/^[TD]:/, '')}</td>
                      <td><Badge color={meta.color}>{meta.label}</Badge></td>
                      <td style={{ maxWidth: 320, color: 'var(--text-muted)', fontSize: 12 }}>{row.reason || (row.role === 'primary' ? 'Kept as the canonical leg.' : '')}</td>
                    </tr>
                  );
                }))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
