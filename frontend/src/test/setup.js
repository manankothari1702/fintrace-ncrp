/**
 * Vitest global setup — jsdom polyfills + jest-dom matchers.
 *
 * jsdom has no layout engine, so the browser APIs our chart/virtualization
 * libraries feature-detect must exist as inert stubs:
 *   • ResizeObserver — recharts <ResponsiveContainer> and @tanstack/react-virtual
 *   • matchMedia     — the dark-mode theme bootstrap in utils/theme.js
 *   • scrollTo       — router/scroll-restoration calls on navigation
 * The stubs never fire callbacks; components render their zero-size fallbacks,
 * which is exactly what a smoke test needs (render without crashing).
 */

import '@testing-library/jest-dom/vitest';

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof window.matchMedia === 'undefined') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener() {},        // legacy API — some libs still call it
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return false; },
  });
}

if (typeof window.scrollTo === 'undefined') {
  window.scrollTo = () => {};
}
