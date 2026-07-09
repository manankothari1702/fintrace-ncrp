/**
 * ModalShell — the shared, portal-based modal shell used by the account modals
 * (User Management, Backups). It reproduces the DetailModal treatment so every
 * modal in the app looks and behaves the same:
 *   • portal to <body> — escapes the top bar's stacking context (z-index:200),
 *     so the scrim/panel always sit above the page instead of being trapped
 *     inside it (the root cause of the earlier "transparent modal");
 *   • an opaque panel (var(--card-bg)) on a dimmed full-viewport scrim;
 *   • Esc-to-close, backdrop-click-to-close, a Tab focus trap, body-scroll lock.
 *
 * It deliberately does NOT absorb DetailModal: that component bakes its table /
 * search / export logic into the same shell and has its own test suite. Both
 * simply share the same scrim/panel tokens (see .modal-overlay / .modal-panel
 * in index.css, matched to .detail-overlay / .detail-modal) so they render
 * identically in light and dark mode.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

export default function ModalShell({
  onClose,
  ariaLabel,
  ariaLabelledby,
  panelClassName = '',
  children,
}) {
  const dialogRef = useRef(null);

  // Lock body scroll and move focus into the dialog while open (mounted).
  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const t = setTimeout(() => { dialogRef.current?.focus(); }, 0);
    return () => {
      clearTimeout(t);
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose?.();
      return;
    }
    if (e.key === 'Tab') {
      const focusables = dialogRef.current
        ? [...dialogRef.current.querySelectorAll(FOCUSABLE)].filter((el) => !el.disabled && el.offsetParent !== null)
        : [];
      if (focusables.length === 0) { e.preventDefault(); return; }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  return createPortal(
    <div
      className="modal-overlay"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div
        className={`modal-panel ${panelClassName}`.trim()}
        role="dialog"
        aria-modal="true"
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledby}
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </div>
    </div>,
    document.body,
  );
}
