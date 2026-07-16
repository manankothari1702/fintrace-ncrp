/**
 * Bank Statement — Upload page (REAL ingestion).
 *
 * The flow, now wired to the live backend:
 *
 *   1. Drag-and-drop (or browse) PDF / XLS / XLSX / CSV statements. Each file
 *      is POSTed to /api/bank-statement/upload.
 *   2. The BACKEND detects the bank from file content (banner text + IFSC +
 *      header signature — never the filename). Recognised statements are
 *      parsed and persisted in the same request; the card shows the bank,
 *      confidence, and parsed transaction count, and the data appears on the
 *      Transactions page.
 *   3. Unrecognised files come back with their sniffed headers and route into
 *      the manual column-mapping wizard (UI-only this milestone — parsing is
 *      PNB-only for now).
 *
 * Previously-ingested statements are loaded from the backend on mount, so the
 * list survives navigation and app restarts.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import MappingPanel from '../components/MappingPanel.jsx';
import { ACCEPTED_EXTENSIONS } from '../utils/mockData.js';
import {
  listStatements, uploadStatement, saveColumnMapping, suggestFieldForHeader,
} from '../utils/api.js';

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

/** Mask an account number for the card meta line (last 4 kept). */
function maskAccount(acct) {
  const s = acct ? String(acct) : '';
  if (s.length <= 4) return s;
  return `…${s.slice(-4)}`;
}

/** Map a persisted statement row onto the file-card shape. */
function cardFromStatement(s) {
  return {
    id: `stmt-${s.id}`,
    statementId: s.id,
    name: s.original_filename || `${s.bank_name || 'Statement'} ${maskAccount(s.account_number)}`,
    size: null,
    meta: `${s.txn_count} transactions · a/c ${maskAccount(s.account_number)} · ${String(s.source_format || '').toUpperCase()}`,
    status: 'detected',
    bank: s.bank_name,
    confidence: null,
  };
}

let localFileSeq = 0;

export default function Upload() {
  const inputRef = useRef(null);
  const toastTimer = useRef(null);

  const [files, setFiles] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const showToast = useCallback((message) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  // ── Load previously-ingested statements ───────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    listStatements()
      .then((statements) => {
        if (cancelled) return;
        // MERGE under the current state, never replace: an upload started
        // before this list resolves already has an in-flight card that a
        // plain setFiles(list) would silently wipe.
        setFiles((prev) => {
          const known = new Set(prev.map((f) => f.id));
          return [...prev, ...statements.map(cardFromStatement).filter((c) => !known.has(c.id))];
        });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.message || 'Could not load statements.');
      });
    return () => { cancelled = true; };
  }, []);

  // ── Add files (drop or browse): real upload + backend detection ───────────
  const addFiles = useCallback((fileList) => {
    const picked = Array.from(fileList || []).filter((f) => hasAcceptedExtension(f.name));
    if (picked.length === 0) return;

    for (const f of picked) {
      localFileSeq += 1;
      const cardId = `local-${localFileSeq}`;
      setFiles((prev) => [
        { id: cardId, name: f.name, size: f.size, status: 'uploading' },
        ...prev,
      ]);

      uploadStatement(f)
        .then((res) => {
          if (res.recognized) {
            setFiles((prev) => prev.map((card) => (card.id !== cardId ? card : {
              id: cardId,
              statementId: res.statementId,
              name: f.name,
              size: f.size,
              meta: `${res.txnCount} transactions · a/c ${maskAccount(res.account?.account_number)} · ${String(res.format || '').toUpperCase()}`,
              status: 'detected',
              bank: res.bankName,
              confidence: Math.round((res.confidence || 0) * 100),
            })));
            showToast(`Parsed ${res.txnCount} transactions from ${res.bankName}.`);
          } else {
            setFiles((prev) => prev.map((card) => (card.id !== cardId ? card : {
              id: cardId,
              name: f.name,
              size: f.size,
              status: 'unrecognized',
              detectedHeaders: (res.detectedHeaders || []).map((h) => ({
                header: h,
                suggested: suggestFieldForHeader(h),
              })),
            })));
          }
        })
        .catch((err) => {
          setFiles((prev) => prev.map((card) => (card.id !== cardId ? card : {
            id: cardId,
            name: f.name,
            size: f.size,
            status: 'error',
            error: err.message || 'Upload failed.',
          })));
          showToast(`Upload failed: ${err.message || 'unknown error'}`);
        });
    }
  }, [showToast]);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const toggleMapping = useCallback((id) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  // ── Apply a confirmed mapping (wizard is UI-only this milestone) ──────────
  const applyMapping = useCallback(async (fileId, payload) => {
    await saveColumnMapping(fileId, payload); // stub — no generic ingestion path yet
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, mapped: true } : f)));
    setExpandedId(null);
    showToast('Mapping applied — this file is ready to parse.');
  }, [showToast]);

  const removeFile = useCallback((id) => {
    // Visual-only: clears the card from this session's list. Persisted
    // statements reappear on reload (no delete route this milestone).
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setExpandedId((current) => (current === id ? null : current));
  }, []);

  return (
    <div className="page">
      <header className="page-header">
        <h1>Upload Bank Statements</h1>
        <p className="subtitle">
          Drop bank statement exports (PDF / XLSX / CSV). Recognised banks are detected automatically;
          map the columns yourself for anything we don&apos;t recognise.
        </p>
      </header>

      {/* ── Drop zone ─────────────────────────────────────────────────────── */}
      <div className="card card-pad" style={{ marginBottom: 24 }}>
        <div
          className="dropzone"
          data-dragging={dragging || undefined}
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        >
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPTED_EXTENSIONS.join(',')}
            multiple
            hidden
            onChange={(e) => addFiles(e.target.files)}
          />
          <div className="dz-icon" aria-hidden="true">🏦</div>
          <div>
            <div className="dz-title">Drag &amp; drop bank statements here</div>
            <div className="dz-sub" style={{ marginTop: 4 }}>
              or click to browse — PDF, XLSX, XLS or CSV
            </div>
          </div>
        </div>
      </div>

      {/* ── File list ─────────────────────────────────────────────────────── */}
      <header className="page-header" style={{ marginBottom: 12 }}>
        <h2 style={{ fontSize: 16 }}>Uploaded Files</h2>
        <p className="subtitle">Detection results and column mapping for each statement.</p>
      </header>

      {loadError && (
        <div className="card card-pad empty-state" role="alert">
          Could not load previously uploaded statements: {loadError}
        </div>
      )}

      {!loadError && files.length === 0 ? (
        <div className="card card-pad empty-state">
          No files yet. Drop a bank statement above to see it detected here.
        </div>
      ) : (
        <div className="bs-file-list">
          {files.map((file) => {
            const isUploading = file.status === 'uploading';
            const isDetected = file.status === 'detected';
            const isError = file.status === 'error';
            const isMapped = !!file.mapped;
            const isOpen = expandedId === file.id;
            const canMap = file.status === 'unrecognized' && !isMapped;
            return (
              <div className={`card bs-file-card${isOpen ? ' is-open' : ''}`} key={file.id}>
                <div className="bs-file-row">
                  <span className="bs-file-icon" aria-hidden="true">📄</span>

                  <div className="bs-file-main">
                    <div className="bs-file-name" title={file.name}>{file.name}</div>
                    <div className="bs-file-meta">
                      {file.meta || formatBytes(file.size)}
                      {isError && <span> — {file.error}</span>}
                    </div>
                  </div>

                  <div className="bs-file-status">
                    {isUploading && (
                      <span className="badge">
                        <span className="dot" />
                        Uploading…
                      </span>
                    )}
                    {isDetected && (
                      <>
                        <span className="badge badge-success">
                          <span className="dot" />
                          Detected
                        </span>
                        <span className="bs-detect-meta">
                          {file.bank}
                          {file.confidence !== null && file.confidence !== undefined && (
                            <> · <span className="tabular">{file.confidence}%</span> confidence</>
                          )}
                        </span>
                      </>
                    )}
                    {isError && (
                      <span className="badge bs-chip-warning">
                        <span className="dot" />
                        Failed
                      </span>
                    )}
                    {isMapped && (
                      <span className="badge badge-success">
                        <span className="dot" />
                        Mapping applied
                      </span>
                    )}
                    {canMap && (
                      <>
                        <span className="badge bs-chip-warning">
                          <span className="dot" />
                          Not recognised
                        </span>
                        <button
                          type="button"
                          className={`btn btn-sm${isOpen ? ' bs-map-btn-open' : ''}`}
                          onClick={() => toggleMapping(file.id)}
                          aria-expanded={isOpen}
                        >
                          <span className="bs-map-chevron" data-open={isOpen || undefined} aria-hidden="true">▸</span>
                          Map columns
                        </button>
                      </>
                    )}
                  </div>

                  <button
                    type="button"
                    className="bs-file-remove"
                    onClick={() => removeFile(file.id)}
                    title="Remove file"
                    aria-label={`Remove ${file.name}`}
                  >
                    ✕
                  </button>
                </div>

                {/* Inline mapping wizard — expands within this row, not a modal. */}
                {isOpen && canMap && (
                  <MappingPanel
                    headers={file.detectedHeaders || []}
                    onApply={(payload) => applyMapping(file.id, payload)}
                    onCancel={() => setExpandedId(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      {toast && (
        <div className="bs-toast" role="status">
          <span aria-hidden="true">✓</span> {toast}
        </div>
      )}
    </div>
  );
}
