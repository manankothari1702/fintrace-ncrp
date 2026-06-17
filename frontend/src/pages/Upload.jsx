/**
 * Upload page.
 *
 * Drag/drop an NCRP Excel export, watch upload progress + background analysis,
 * then jump to the dashboard. Below the drop zone is the list of previous
 * reports with per-row actions.
 *
 * Flow:
 *   1. uploadReport(file, setProgress)  → { reportId, rowCount, warnings }
 *   2. pollReportUntilDone(reportId) polls getReport every 2s until
 *      analysis_status is 'complete' | 'error' (max 30 attempts, then timeout).
 *   3. set the active report (sessionStorage-backed) and route to the dashboard.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import StatCard from '../components/StatCard.jsx';
import Badge from '../components/Badge.jsx';
import DataTable from '../components/DataTable.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import { formatCrore, formatINR, formatDate, formatNumber } from '../utils/format.js';
import {
  uploadReport,
  listReports,
  deleteReport,
  openReportPdf,
  pollReportUntilDone,
  friendlyErrorMessage,
  ApiError,
} from '../utils/api.js';
import { useReportContext } from '../context/ReportContext.jsx';

const ACCEPTED_EXTENSIONS = ['.xlsx', '.xls'];
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // mirrors backend MAX_UPLOAD_BYTES

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hasAcceptedExtension(name) {
  const lower = (name || '').toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

// Upload lifecycle states.
const STATUS = {
  IDLE: 'idle',
  UPLOADING: 'uploading',
  ANALYZING: 'analyzing',
  SUCCESS: 'success',
  ERROR: 'error',
};

export default function Upload() {
  const navigate = useNavigate();
  const inputRef = useRef(null);
  const { setReportId } = useReportContext();

  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [status, setStatus] = useState(STATUS.IDLE);
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [error, setError] = useState(null);

  const [reports, setReports] = useState([]);
  const [reportsLoading, setReportsLoading] = useState(true);
  const [reportsError, setReportsError] = useState(null);
  const [deletingId, setDeletingId] = useState(null);

  // Load (and reload) the previous-reports list from the backend.
  const refreshReports = useCallback(async () => {
    setReportsLoading(true);
    setReportsError(null);
    try {
      setReports(await listReports());
    } catch (err) {
      setReportsError(err);
    } finally {
      setReportsLoading(false);
    }
  }, []);

  useEffect(() => { refreshReports(); }, [refreshReports]);

  // ── File selection (drop or browse) ──────────────────────────────────────

  const acceptFile = useCallback((picked) => {
    setError(null);
    if (!picked) return;
    if (!hasAcceptedExtension(picked.name)) {
      setError({ message: 'Only .xlsx or .xls Excel files are accepted.', code: 'INVALID_FILE_TYPE' });
      return;
    }
    if (picked.size > MAX_UPLOAD_BYTES) {
      setError({ message: 'File exceeds the 50 MB limit.', code: 'FILE_TOO_LARGE' });
      return;
    }
    setFile(picked);
    setStatus(STATUS.IDLE);
    setResult(null);
    setWarnings([]);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    acceptFile(e.dataTransfer.files?.[0]);
  }, [acceptFile]);

  // ── Upload + analyze ─────────────────────────────────────────────────────

  const handleUpload = useCallback(async () => {
    if (!file) return;
    setStatus(STATUS.UPLOADING);
    setProgress(0);
    setError(null);
    setWarnings([]);

    try {
      // Stream the file; the 202 response carries the new report id + warnings.
      const uploaded = await uploadReport(file, setProgress);
      setWarnings(uploaded.warnings || []);

      // Background analysis runs server-side; poll until it settles
      // (2s interval, up to 30 attempts → ~60s, then a timeout error).
      setStatus(STATUS.ANALYZING);
      const final = await pollReportUntilDone(uploaded.reportId);
      if (final.analysis_status === 'error') {
        throw new ApiError('Analysis failed for this file. Check the source data and retry.', {
          code: 'ANALYSIS_ERROR',
        });
      }

      setResult({
        reportId: uploaded.reportId,
        filename: uploaded.filename,
        rowCount: uploaded.rowCount,
        total_transactions: final.total_transactions,
        total_disputed_amount: final.total_disputed_amount,
        total_layers: final.total_layers,
      });
      // Persist as the active report (writes sessionStorage 'activeReportId')
      // so every page + sidebar link can resolve it immediately on completion.
      setReportId(uploaded.reportId);
      setStatus(STATUS.SUCCESS);
      refreshReports();
    } catch (err) {
      setError(err);
      setStatus(STATUS.ERROR);
    }
  }, [file, refreshReports]);

  const goToDashboard = useCallback((reportId) => {
    setReportId(reportId);
    navigate(`/dashboard?reportId=${reportId}`);
  }, [navigate, setReportId]);

  const resetUpload = useCallback(() => {
    setFile(null);
    setStatus(STATUS.IDLE);
    setProgress(0);
    setResult(null);
    setWarnings([]);
    setError(null);
  }, []);

  // ── Previous-reports actions ───────────────────────────────────────────────

  const handleDownloadPdf = useCallback(async (reportId) => {
    // The backend generates the dossier on demand. In Electron it is written to
    // the exports folder and opened via the OS handler over IPC (new windows are
    // denied); in a browser it opens the streaming URL in a new tab.
    setReportsError(null);
    try {
      await openReportPdf(reportId);
    } catch (err) {
      setReportsError(err);
    }
  }, []);

  const handleDelete = useCallback(async (reportId) => {
    setReportsError(null);
    setDeletingId(reportId);
    try {
      await deleteReport(reportId);
      await refreshReports();
    } catch (err) {
      setReportsError(err);
    } finally {
      setDeletingId(null);
    }
  }, [refreshReports]);

  const reportColumns = [
    { accessorKey: 'original_filename', header: 'Filename' },
    {
      accessorKey: 'upload_date',
      header: 'Uploaded',
      cell: ({ getValue }) => formatDate(getValue()),
    },
    {
      accessorKey: 'total_transactions',
      header: 'Transactions',
      cell: ({ getValue }) => formatNumber(getValue()),
    },
    {
      accessorKey: 'total_disputed_amount',
      header: 'Disputed Amount',
      cell: ({ getValue }) => formatINR(getValue()),
    },
    {
      accessorKey: 'analysis_status',
      header: 'Status',
      cell: ({ getValue }) => <StatusBadge status={getValue()} />,
    },
    {
      id: 'actions',
      header: 'Actions',
      enableSorting: false,
      cell: ({ row }) => {
        const r = row.original;
        const ready = r.analysis_status === 'complete';
        return (
          <div style={{ display: 'flex', gap: 6 }}>
            <button
              type="button"
              className="btn btn-sm"
              disabled={!ready}
              title={ready ? 'Open dashboard' : 'Available once analysis completes'}
              onClick={() => goToDashboard(r.id)}
            >
              📊 Dashboard
            </button>
            <button type="button" className="btn btn-sm" disabled={!ready} onClick={() => handleDownloadPdf(r.id)}>
              ⬇ PDF
            </button>
            <button
              type="button"
              className="btn btn-sm"
              style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
              disabled={deletingId === r.id}
              onClick={() => handleDelete(r.id)}
            >
              {deletingId === r.id ? 'Deleting…' : '🗑 Delete'}
            </button>
          </div>
        );
      },
    },
  ];

  const busy = status === STATUS.UPLOADING || status === STATUS.ANALYZING;

  return (
    <div className="page">
      <header className="page-header">
        <h1>Upload NCRP Report</h1>
        <p className="subtitle">Drop an NCRP Excel export (.xlsx / .xls) to ingest, analyse, and trace the money.</p>
      </header>

      {/* ── Success state ─────────────────────────────────────────────────── */}
      {status === STATUS.SUCCESS && result ? (
        <div className="card card-pad" style={{ marginBottom: 24 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 22 }}>✅</span>
            <h2 style={{ fontSize: 18 }}>Analysis complete — {result.filename}</h2>
          </div>
          <div className="grid grid-stats" style={{ marginBottom: 16 }}>
            <StatCard title="Transactions" value={formatNumber(result.total_transactions ?? result.rowCount)} icon="📋" color="var(--brand)" />
            <StatCard title="Disputed Amount" value={formatCrore(result.total_disputed_amount)} icon="💸" color="var(--danger)" />
            <StatCard title="Layers in Trail" value={result.total_layers} icon="🔢" color="var(--accent-orange)" />
          </div>

          {warnings.length > 0 && <ParserWarnings warnings={warnings} />}

          <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
            <button type="button" className="btn btn-primary" onClick={() => goToDashboard(result.reportId)}>
              Open Dashboard →
            </button>
            <button type="button" className="btn" onClick={resetUpload}>
              Upload another file
            </button>
          </div>
        </div>
      ) : (
        /* ── Drop zone / upload states ─────────────────────────────────────── */
        <div className="card card-pad" style={{ marginBottom: 24 }}>
          <div
            className="dropzone"
            data-dragging={dragging || undefined}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={handleDrop}
            onClick={() => !busy && inputRef.current?.click()}
            role="button"
            tabIndex={0}
            style={{
              border: `2px dashed ${dragging ? 'var(--brand)' : 'var(--border)'}`,
              background: dragging ? 'var(--brand-light)' : 'transparent',
              borderRadius: 'var(--radius)',
              padding: '40px 24px',
              textAlign: 'center',
              cursor: busy ? 'default' : 'pointer',
              transition: 'background 0.12s ease, border-color 0.12s ease',
            }}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".xlsx,.xls"
              hidden
              onChange={(e) => acceptFile(e.target.files?.[0])}
            />
            <div style={{ fontSize: 36, marginBottom: 8 }}>📤</div>
            {file ? (
              <div>
                <div style={{ fontWeight: 700 }}>{file.name}</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 2 }}>{formatBytes(file.size)}</div>
              </div>
            ) : (
              <div>
                <div style={{ fontWeight: 600 }}>Drag &amp; drop your NCRP file here</div>
                <div style={{ color: 'var(--text-muted)', marginTop: 4 }}>or click to browse — .xlsx / .xls, up to 50 MB</div>
              </div>
            )}
          </div>

          {error && (
            <div style={{ marginTop: 16 }}>
              <ErrorAlert
                error={error}
                title={error.code === 'PARSE_BLOCKED' ? 'Upload blocked — file could not be read safely' : 'Upload could not start'}
                message={friendlyErrorMessage(error)}
              />
              {Array.isArray(error.details?.parseErrors) && error.details.parseErrors.length > 0 && (
                <ParseErrorDetails errors={error.details.parseErrors} />
              )}
            </div>
          )}

          {busy && (
            <div style={{ marginTop: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 6 }}>
                <span>{status === STATUS.UPLOADING ? 'Uploading…' : 'Analysing the trail…'}</span>
                <span>{status === STATUS.UPLOADING ? `${progress}%` : ''}</span>
              </div>
              <div style={{ height: 8, borderRadius: 999, background: 'var(--brand-light)', overflow: 'hidden' }}>
                <div
                  style={{
                    height: '100%',
                    width: status === STATUS.UPLOADING ? `${progress}%` : '100%',
                    background: status === STATUS.UPLOADING ? 'var(--brand)' : 'var(--accent-orange)',
                    transition: 'width 0.2s ease',
                    ...(status === STATUS.ANALYZING ? { animation: 'shimmer 1.3s ease infinite', backgroundSize: '400% 100%' } : {}),
                  }}
                />
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!file || busy}
              onClick={handleUpload}
            >
              {busy ? 'Working…' : 'Upload & Analyze'}
            </button>
            {file && !busy && (
              <button type="button" className="btn" onClick={resetUpload}>Clear</button>
            )}
          </div>
        </div>
      )}

      {/* ── Previous reports ──────────────────────────────────────────────── */}
      <header className="page-header" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16 }}>Previous Reports</h2>
        <p className="subtitle">Earlier uploads and their analysis status.</p>
      </header>
      {reportsError ? (
        <ErrorAlert
          error={reportsError}
          title="Could not load previous reports"
          message={friendlyErrorMessage(reportsError)}
          onRetry={refreshReports}
        />
      ) : (
        <DataTable
          columns={reportColumns}
          data={reports}
          loading={reportsLoading}
          emptyMessage="No reports uploaded yet. Drop an NCRP Excel export above to analyse your first case."
          exportFilename="ncrp-reports.csv"
        />
      )}
    </div>
  );
}

// ─── Small presentational helpers ────────────────────────────────────────────

function StatusBadge({ status }) {
  const map = {
    complete: 'var(--accent)',
    processing: 'var(--accent-orange)',
    pending: 'var(--text-muted)',
    error: 'var(--danger)',
  };
  return <Badge color={map[status] || 'var(--text-muted)'}>{status}</Badge>;
}

/**
 * Structured parse errors returned by a PARSE_BLOCKED upload (422). Each entry
 * names the sheet, the required column that could not be identified, and the
 * headers actually found — so the officer can fix the file (or re-export it)
 * instead of being shown wrong figures.
 */
function ParseErrorDetails({ errors }) {
  return (
    <div
      style={{
        marginTop: 10,
        background: '#fdf0f0',
        border: '1px solid #ecc8c8',
        borderLeft: '4px solid var(--danger)',
        borderRadius: 'var(--radius)',
        padding: '12px 16px',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6, color: '#8a1f1f' }}>
        ⛔ No figures were computed — fix these sheets and upload again
      </div>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#7a2424' }}>
        {errors.map((e, i) => (
          <li key={i} style={{ marginBottom: 6 }}>
            {e.code === 'UNKNOWN_CHANNEL_WITH_TRANSACTIONS' ? (
              <>
                <strong>{e.sheet}</strong>: unrecognised sheet that appears to contain
                {' '}{e.dataRows} transaction row(s) — the disbursement channel could not
                be determined. Processing was refused to avoid understating cashed-out
                funds and overstating the lien. Rename the sheet to its NCRP channel
                (e.g. &lsquo;AEPS&rsquo;, &lsquo;Withdrawal through ATM&rsquo;) and retry.
              </>
            ) : (
              <>
                <strong>{e.sheet}</strong>: required column &lsquo;{e.expectedColumn}&rsquo; not found
                {e.dataRows ? ` (${e.dataRows} data rows affected)` : ''}.
              </>
            )}
            {Array.isArray(e.foundHeaders) && e.foundHeaders.length > 0 && (
              <div style={{ opacity: 0.8, marginTop: 2 }}>
                Columns found: {e.foundHeaders.join(', ')}
              </div>
            )}
            {Array.isArray(e.acceptedHeaders) && e.acceptedHeaders.length > 0 && (
              <div style={{ opacity: 0.8, marginTop: 2 }}>
                Accepted header names include: {e.acceptedHeaders.slice(0, 6).join(', ')}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ParserWarnings({ warnings }) {
  return (
    <div
      style={{
        background: '#fff8e6',
        border: '1px solid #f3e0b0',
        borderLeft: '4px solid var(--accent-orange)',
        borderRadius: 'var(--radius)',
        padding: '12px 16px',
      }}
    >
      <div style={{ fontWeight: 700, marginBottom: 6, color: '#8a5a00' }}>
        ⚠️ Parser notes ({warnings.length})
      </div>
      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: '#7a5400' }}>
        {warnings.map((w, i) => {
          // Warnings are either plain strings (parser notes) or structured
          // objects ({ code, message }) such as the changed-source alert.
          const isObj = w && typeof w === 'object';
          const text = isObj ? w.message : w;
          const isSourceChanged = isObj && w.code === 'SOURCE_FILE_CHANGED';
          const isOldTxns = isObj && w.code === 'OLD_TRANSACTIONS_FOUND';
          let style;
          if (isSourceChanged) style = { fontWeight: 700, color: '#8a2a00' };
          else if (isOldTxns) style = { fontWeight: 600 };
          const prefix = isSourceChanged ? '🔑 Source file changed — ' : (isOldTxns ? 'ℹ️ ' : '');
          return (
            <li key={i} style={style}>
              {prefix}{text}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
