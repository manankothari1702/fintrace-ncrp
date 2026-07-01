/**
 * Bank Statement — Upload page.
 *
 * The only fully-built page in this scaffold pass. It demonstrates the intended
 * ingest flow against mock/static data (no real parsing or backend yet):
 *
 *   1. Drag-and-drop (or browse) PDF / XLSX / CSV statements — UI only; the
 *      file bytes are never read in this pass.
 *   2. Each file lands in a list with a detection status chip: green
 *      "detected" (bank + confidence) for recognised files, amber
 *      "not recognised" for the rest.
 *   3. A not-recognised file offers "Map columns", which expands an inline
 *      panel within that row to map its headers onto canonical fields.
 *
 * Every place a real API call belongs is marked with a TODO referencing the
 * stub in ../utils/api.js.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import MappingPanel from '../components/MappingPanel.jsx';
import { ACCEPTED_EXTENSIONS, MOCK_FILES, mockDetect } from '../utils/mockData.js';
// TODO(bank-statement/backend): replace the mock seed + mockDetect with the
// real client — listStatementFiles(), uploadStatement(file), saveColumnMapping().
// import { listStatementFiles, uploadStatement, saveColumnMapping } from '../utils/api.js';

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

let localFileSeq = 0;

export default function Upload() {
  const inputRef = useRef(null);
  const toastTimer = useRef(null);

  // Seed from mock data. TODO(bank-statement/backend): load via
  // listStatementFiles() in an effect once the route exists.
  const [files, setFiles] = useState(MOCK_FILES);
  const [dragging, setDragging] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => () => clearTimeout(toastTimer.current), []);

  const showToast = useCallback((message) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2800);
  }, []);

  // ── Add files (drop or browse) ────────────────────────────────────────────
  const addFiles = useCallback((fileList) => {
    const picked = Array.from(fileList || []).filter((f) => hasAcceptedExtension(f.name));
    if (picked.length === 0) return;

    // TODO(bank-statement/backend): POST each file to uploadStatement(file) and
    // use the server's detection result instead of the local mockDetect().
    const added = picked.map((f) => {
      localFileSeq += 1;
      return {
        id: `local-${localFileSeq}`,
        name: f.name,
        size: f.size,
        ...mockDetect(f.name),
      };
    });
    setFiles((prev) => [...added, ...prev]);
  }, []);

  const handleDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    addFiles(e.dataTransfer.files);
  }, [addFiles]);

  const toggleMapping = useCallback((id) => {
    setExpandedId((current) => (current === id ? null : id));
  }, []);

  // ── Apply a confirmed mapping (no-op in this pass) ──────────────────────────
  const applyMapping = useCallback((fileId, payload) => {
    // TODO(bank-statement/backend): await saveColumnMapping(fileId, payload).
    // For now flip the row to a "mapped" success state and confirm via a toast.
    void payload;
    setFiles((prev) => prev.map((f) => (f.id === fileId ? { ...f, mapped: true } : f)));
    setExpandedId(null);
    showToast('Mapping applied — this file is ready to parse.');
  }, [showToast]);

  const removeFile = useCallback((id) => {
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

      {files.length === 0 ? (
        <div className="card card-pad empty-state">
          No files yet. Drop a bank statement above to see it detected here.
        </div>
      ) : (
        <div className="bs-file-list">
          {files.map((file) => {
            const isDetected = file.status === 'detected';
            const isMapped = !!file.mapped;
            const isOpen = expandedId === file.id;
            const canMap = !isDetected && !isMapped;
            return (
              <div className={`card bs-file-card${isOpen ? ' is-open' : ''}`} key={file.id}>
                <div className="bs-file-row">
                  <span className="bs-file-icon" aria-hidden="true">📄</span>

                  <div className="bs-file-main">
                    <div className="bs-file-name" title={file.name}>{file.name}</div>
                    <div className="bs-file-meta">{formatBytes(file.size)}</div>
                  </div>

                  <div className="bs-file-status">
                    {isDetected && (
                      <>
                        <span className="badge badge-success">
                          <span className="dot" />
                          Detected
                        </span>
                        <span className="bs-detect-meta">
                          {file.bank} · <span className="tabular">{file.confidence}%</span> confidence
                        </span>
                      </>
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
