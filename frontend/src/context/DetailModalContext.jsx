// @refresh reset

/**
 * DetailModalContext — app-wide access to the row drill-down modal.
 *
 * Any component calls `openDetail({ type, params, label })` (usually through
 * <EntityLink>/<AccountLink>) and the provider fetches the entity payload,
 * resolves the per-type presentation adapter, and renders the ONE shared
 * <DetailModal> above the current page. Opening another entity while the modal
 * is up pushes onto a breadcrumb stack (nested drill, spec §3); ‹ Back pops;
 * Esc/✕/backdrop close everything and return focus to the ORIGINAL trigger.
 *
 * Mounted once in App.jsx inside ReportProvider (it resolves the active report
 * id the same way the pages do).
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import DetailModal from '../components/DetailModal.jsx';
import { ENTITY_ADAPTERS } from '../components/detail/entityAdapters.jsx';
import { getEntityDetail, saveEntityExcel, ApiError } from '../utils/api.js';
import { useActiveReportId } from './ReportContext.jsx';

const DetailModalContext = createContext(null);

export function DetailModalProvider({ children }) {
  const reportId = useActiveReportId();

  // Stack of entity refs: [{ type, params, label }]. Last = currently shown.
  const [stack, setStack] = useState([]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  // The element that opened the FIRST modal — focus returns here on close.
  const triggerRef = useRef(null);

  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState(null);

  const current = stack.length > 0 ? stack[stack.length - 1] : null;
  const currentKey = current ? `${current.type}:${JSON.stringify(current.params)}` : null;

  const openDetail = useCallback((ref) => {
    if (!ref || !ref.type) return;
    if (stackRef.current.length === 0) triggerRef.current = document.activeElement;
    setExportError(null);
    setStack((s) => [...s, ref]);
  }, []);

  const closeDetail = useCallback(() => {
    setStack([]);
    setDetail(null);
    setError(null);
    setExportError(null);
    const trigger = triggerRef.current;
    triggerRef.current = null;
    // Restore after the portal unmounts.
    setTimeout(() => {
      if (trigger && typeof trigger.focus === 'function' && document.contains(trigger)) {
        trigger.focus();
      }
    }, 0);
  }, []);

  const back = useCallback(() => {
    setExportError(null);
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  // Fetch the current entity's payload (re-runs on entity change / Retry).
  useEffect(() => {
    if (!currentKey) return undefined;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetail(null);
    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }
    const ref = stackRef.current[stackRef.current.length - 1];
    getEntityDetail(reportId, ref.type, ref.params)
      .then((d) => { if (!cancelled) setDetail(d); })
      .catch((e) => { if (!cancelled) setError(e); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [currentKey, reportId, reload]);

  const runExport = useCallback(async (search) => {
    const ref = stackRef.current[stackRef.current.length - 1];
    if (!ref || !reportId) return;
    setExporting(true);
    setExportError(null);
    try {
      // Native Save As (Electron) / browser download — same dialog-first flow
      // as the Dashboard's report exports. A cancelled dialog is not an error.
      const idPart = String(ref.label || (ref.params && ref.params.id) || ref.type)
        .replace(/[^\w.-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
      await saveEntityExcel(
        reportId,
        ref.type,
        { ...ref.params, ...(search ? { search } : {}) },
        `FinTrace_Drilldown_${ref.type}_${idPart || 'export'}.xlsx`,
      );
    } catch (e) {
      setExportError(e);
    } finally {
      setExporting(false);
    }
  }, [reportId]);

  const value = useMemo(() => ({ openDetail, closeDetail }), [openDetail, closeDetail]);

  const adapter = current ? ENTITY_ADAPTERS[current.type] : null;
  const breadcrumb = stack.map((ref, i) => ({
    key: `${i}-${ref.type}`,
    label: ref.label || (ref.params && ref.params.id) || ref.type,
  }));

  return (
    <DetailModalContext.Provider value={value}>
      {children}
      {current && adapter && (
        <DetailModal
          key={currentKey}
          open
          onClose={closeDetail}
          onBack={back}
          breadcrumb={breadcrumb}
          icon={adapter.icon}
          titleMono={!!adapter.titleMono}
          title={detail ? adapter.title(detail) : (breadcrumb[breadcrumb.length - 1] || {}).label || ''}
          subtitle={detail ? adapter.subtitle(detail) : null}
          badges={detail && adapter.badges ? adapter.badges(detail) : null}
          chips={detail ? adapter.chips(detail) : []}
          notes={detail && adapter.notes ? adapter.notes(detail) : null}
          columns={adapter.columns({ drill: openDetail })}
          rows={detail ? detail.rows : []}
          searchable={detail ? detail.searchable : []}
          searchPlaceholder={detail ? adapter.searchPlaceholder(detail) : 'Search…'}
          loading={loading}
          error={error}
          onRetry={() => setReload((n) => n + 1)}
          emptyMessage={detail && adapter.emptyMessage ? adapter.emptyMessage(detail) : undefined}
          onExport={runExport}
          exporting={exporting}
          exportError={exportError}
          totals={adapter.totals}
        />
      )}
    </DetailModalContext.Provider>
  );
}

/** Access { openDetail, closeDetail }. Throws outside a DetailModalProvider. */
export function useDetailModal() {
  const ctx = useContext(DetailModalContext);
  if (!ctx) {
    throw new Error('useDetailModal must be used within a <DetailModalProvider>.');
  }
  return ctx;
}
