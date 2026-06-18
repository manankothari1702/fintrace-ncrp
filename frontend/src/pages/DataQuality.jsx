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
import { getDataQuality, getReport, friendlyErrorMessage, ApiError } from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

// Parse-warning code → display label + colour for the self-healing audit panel.
const PARSE_WARNING_META = {
  FUZZY_SHEET_MATCH: { label: 'Sheet matched by similarity', color: 'var(--accent-orange)' },
  FUZZY_COLUMN_MATCH: { label: 'Column matched by similarity', color: 'var(--accent-orange)' },
  INFORMATIONAL_COLUMN_MISSING: { label: 'Column missing (degraded)', color: 'var(--text-muted)' },
};

function parseWarningMeta(code) {
  return PARSE_WARNING_META[code] || { label: code || '—', color: 'var(--text-muted)' };
}

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
  const [parseWarnings, setParseWarnings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setParseWarnings([]);

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    getDataQuality(reportId)
      .then((data) => { if (!cancelled) setRows(Array.isArray(data) ? data : []); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });

    // Parser self-healing audit lives on the analysis snapshot. Best-effort:
    // its absence must never block the bank-attribution view above.
    getReport(reportId)
      .then((r) => {
        if (cancelled) return;
        const pw = r && r.analysis_json && Array.isArray(r.analysis_json.parse_warnings)
          ? r.analysis_json.parse_warnings : [];
        setParseWarnings(pw);
      })
      .catch(() => { /* panel simply does not render */ });

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

      {parseWarnings.length > 0 && <ParserWarningsPanel warnings={parseWarnings} />}

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

/**
 * Self-healing parser audit. Lists every sheet/column the parser resolved by
 * similarity (rather than an exact match) and every informational column that
 * was missing — so the officer can confirm the file was interpreted correctly.
 * Financial figures are unaffected; this is an interpretation-provenance panel.
 */
function ParserWarningsPanel({ warnings }) {
  const fuzzy = warnings.filter((w) => w.confidence !== undefined && w.confidence !== null);
  return (
    <div className="card card-pad" style={{ marginBottom: 20, borderLeft: '4px solid var(--accent-orange)' }}>
      <h2 style={{ marginTop: 0, fontSize: 16 }}>
        ⚠️ Parser Warnings ({warnings.length})
      </h2>
      <p className="subtitle" style={{ marginTop: 0 }}>
        The parser could not match {fuzzy.length > 0 ? 'some sheet/column names exactly' : 'every expected column'} and
        {' '}
        {fuzzy.length > 0 ? 'resolved them by similarity' : 'noted the gap'}. Confirm each was interpreted correctly —
        {' '}
        <strong>this affects how the source file was read, not the computed amounts.</strong>
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Sheet</th>
              <th>Source name</th>
              <th>Interpreted as</th>
              <th>Confidence</th>
              <th>Note</th>
            </tr>
          </thead>
          <tbody>
            {warnings.map((w, i) => {
              const meta = parseWarningMeta(w.code);
              return (
                <tr key={`${w.code}-${w.sheet}-${w.matchedTo}-${i}`}>
                  <td><Badge color={meta.color}>{meta.label}</Badge></td>
                  <td>{w.sheet || '—'}</td>
                  <td style={{ color: 'var(--text-muted)' }}>{w.matchedFrom || '—'}</td>
                  <td style={{ fontWeight: 600 }}>{w.matchedTo || '—'}</td>
                  <td>{w.confidence != null ? `${Math.round(w.confidence * 100)}%` : '—'}</td>
                  <td style={{ maxWidth: 360, color: 'var(--text-muted)', fontSize: 12 }}>{w.message}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
