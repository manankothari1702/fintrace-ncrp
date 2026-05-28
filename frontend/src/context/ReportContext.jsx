// @refresh reset

/**
 * ReportContext — shares the active report id across pages.
 *
 * The id is persisted to sessionStorage (key `activeReportId`) so it survives a
 * refresh within the session. Pages resolve the active id with {@link useActiveReportId},
 * which gives the `?reportId=` URL param precedence (deep links / the upload
 * redirect) and falls back to the shared/persisted value, syncing the URL id
 * back into the context so a later page without the query param still finds it.
 *
 * Note: this file intentionally co-exports a component (`ReportProvider`) and
 * hooks (`useReportContext`, `useActiveReportId`). The `// @refresh reset`
 * directive above silences Vite's Fast Refresh warning about mixed exports —
 * splitting the hooks into their own file would be the alternative, but the
 * provider + hook live together by convention and the reset semantics are
 * acceptable for a context whose value is rebuilt from sessionStorage anyway.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { useSearchParams } from 'react-router-dom';

const STORAGE_KEY = 'activeReportId';

const ReportContext = createContext(null);

export function ReportProvider({ children }) {
  const [reportId, setReportIdState] = useState(() => {
    try {
      return sessionStorage.getItem(STORAGE_KEY) || null;
    } catch (_e) {
      return null;
    }
  });

  const setReportId = useCallback((id) => {
    const next = id == null || id === '' ? null : String(id);
    setReportIdState(next);
    try {
      if (next) sessionStorage.setItem(STORAGE_KEY, next);
      else sessionStorage.removeItem(STORAGE_KEY);
    } catch (_e) {
      /* sessionStorage unavailable (private mode); in-memory state still works */
    }
  }, []);

  // `activeReportId` is exposed as an alias of `reportId` for call sites
  // (e.g. Sidebar) that prefer the explicit name.
  const value = useMemo(
    () => ({ reportId, activeReportId: reportId, setReportId }),
    [reportId, setReportId],
  );

  return <ReportContext.Provider value={value}>{children}</ReportContext.Provider>;
}

/** Access the shared { reportId, setReportId }. Throws outside a ReportProvider. */
export function useReportContext() {
  const ctx = useContext(ReportContext);
  if (!ctx) {
    throw new Error('useReportContext must be used within a <ReportProvider>.');
  }
  return ctx;
}

/**
 * Resolve the active report id for a page. The `?reportId=` query param wins
 * (deep links, the post-upload redirect); otherwise the shared/persisted id is
 * used. A URL id is synced back into the context so subsequent navigations keep
 * the selection without needing the query param.
 *
 * @returns {string|null}
 */
export function useActiveReportId() {
  const [searchParams] = useSearchParams();
  const { reportId, setReportId } = useReportContext();
  const urlId = searchParams.get('reportId');

  useEffect(() => {
    if (urlId && urlId !== reportId) setReportId(urlId);
  }, [urlId, reportId, setReportId]);

  return urlId || reportId || null;
}
