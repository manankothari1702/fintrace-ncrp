/**
 * Theme handling — light (default) / dark.
 *
 * Dark mode is driven entirely by a `data-theme="dark"` attribute on
 * <html> (see the [data-theme='dark'] token block in index.css). The choice
 * persists in localStorage under 'fintrace-theme' so it survives restarts of
 * the air-gapped Electron app.
 *
 * {@link initTheme} runs once at startup (main.jsx) BEFORE React renders, so a
 * saved dark theme applies synchronously and there is no light flash on boot.
 * The {@link useTheme} hook backs the sidebar toggle button.
 */
import { useCallback, useState } from 'react';

const STORAGE_KEY = 'fintrace-theme';

/** Read the persisted theme, or null if none / storage is unavailable. */
export function getStoredTheme() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (_e) {
    return null;
  }
}

/** Reflect `theme` onto <html> — dark sets the attribute, light removes it. */
export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === 'dark') {
    root.setAttribute('data-theme', 'dark');
  } else {
    root.removeAttribute('data-theme');
  }
}

/**
 * Apply the saved theme at boot. Call once from main.jsx before render.
 * @returns {'light'|'dark'} the resolved theme
 */
export function initTheme() {
  const theme = getStoredTheme() === 'dark' ? 'dark' : 'light';
  applyTheme(theme);
  return theme;
}

/** Apply and persist a theme. */
export function setTheme(theme) {
  applyTheme(theme);
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch (_e) {
    /* storage unavailable — theme still applies for this session */
  }
}

/**
 * React hook for the toggle button. Seeds from the attribute already set by
 * initTheme(), so it stays in sync with what is actually on the page.
 * @returns {['light'|'dark', () => void]} [theme, toggle]
 */
export function useTheme() {
  const [theme, setThemeState] = useState(
    () => (document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'),
  );

  const toggle = useCallback(() => {
    setThemeState((current) => {
      const next = current === 'dark' ? 'light' : 'dark';
      setTheme(next);
      return next;
    });
  }, []);

  return [theme, toggle];
}
