/**
 * useChartTheme — resolve the design tokens recharts needs into CONCRETE colour
 * values, re-resolved whenever the light/dark theme flips.
 *
 * recharts paints SVG `fill`/`stroke`, which don't honour CSS `var()` the way CSS
 * properties do, so charts must be handed real colours. A MutationObserver on
 * <html data-theme> re-runs the resolution on every theme toggle so an open chart
 * recolours live. (Dashboard.jsx carries its own private copy of this logic; this
 * shared hook is used by the Money Flow Sankey without touching that working code.)
 *
 * @returns {{theme:'light'|'dark', text:string, textMuted:string, border:string,
 *   cardBg:string, brand:string, brandText:string, danger:string, dangerText:string,
 *   accent:string, accentOrange:string}}
 */
import { useEffect, useMemo, useState } from 'react';

export function useChartTheme() {
  const [theme, setTheme] = useState(
    () => (typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-theme') : null) || 'light',
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(el.getAttribute('data-theme') || 'light'));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fallback) => (cs.getPropertyValue(n).trim() || fallback);
    return {
      theme,
      text: v('--text', '#1a1a2e'),
      textMuted: v('--text-muted', '#5a6a7a'),
      border: v('--border', '#e0e5ed'),
      cardBg: v('--card-bg', '#ffffff'),
      brand: v('--brand', '#1f3a6e'),
      // Lifted variants for SVG strokes/labels that must stay legible on the dark
      // card: raw --brand is ~1.5:1 and raw --danger ~3:1 in dark, so charts read
      // these (true navy / red in light; lifted toward white in dark — see the
      // --brand-text and --risk-high token notes in index.css).
      brandText: v('--brand-text', '#1f3a6e'),
      danger: v('--danger', '#c62828'),
      dangerText: v('--risk-high', '#c62828'),
      accent: v('--accent', '#2e7d32'),
      accentOrange: v('--accent-orange', '#e65100'),
    };
  }, [theme]);
}
