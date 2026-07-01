/**
 * Theme hook for the Bank Statement module.
 *
 * This is a tiny, self-contained reimplementation of the light/dark toggle so
 * the module has ZERO import dependency on any NCRP file (per the isolation
 * rule for this pass). It deliberately reads and writes the SAME
 * `data-theme` attribute on <html> and the SAME `fintrace-theme` localStorage
 * key the rest of the app uses, so the two modules share one theme state: a
 * choice made in either module persists and carries across the mode toggle.
 *
 * There is no coordination problem with the NCRP sidebar's own toggle because
 * only one module is ever mounted at a time — this hook seeds from the live
 * attribute on mount, so it is always in sync with whatever theme is active.
 */
import { useCallback, useState } from 'react';

const STORAGE_KEY = 'fintrace-theme';

export function useBankStatementTheme() {
  const [theme, setThemeState] = useState(
    () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
  );

  const toggle = useCallback(() => {
    setThemeState((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      const root = document.documentElement;
      if (next === 'dark') root.setAttribute('data-theme', 'dark');
      else root.removeAttribute('data-theme');
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (_e) {
        /* storage unavailable — theme still applies for this session */
      }
      return next;
    });
  }, []);

  return [theme, toggle];
}
