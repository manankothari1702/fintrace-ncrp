/**
 * EntityLink / AccountLink — the clickable identifier that opens the shared
 * row drill-down modal (spec §1: "the primary identifier styled as a link").
 *
 * A real <button> (Enter/Space activate natively, tab-focusable) styled as an
 * accent monospace link. Clicks stop propagating so a link inside an
 * expandable row / clickable card never triggers the parent's own handler —
 * this is what keeps the identifier-click and any future whole-card click
 * (e.g. the planned P0–P3 "go to page" action) cleanly separable.
 */

import { useDetailModal } from '../context/DetailModalContext.jsx';

export default function EntityLink({
  type,
  params,
  label,
  title,
  className,
  children,
}) {
  const { openDetail } = useDetailModal();
  const text = children ?? label ?? (params && params.id) ?? '';
  return (
    <button
      type="button"
      className={`entity-link${className ? ` ${className}` : ''}`}
      title={title || `Open ${type} details`}
      onClick={(e) => {
        e.stopPropagation();
        openDetail({ type, params, label: label ?? (params && params.id) });
      }}
    >
      {text}
    </button>
  );
}

/** Account-number convenience wrapper: renders — for blank/null accounts. */
export function AccountLink({ account, children, ...rest }) {
  const id = account === null || account === undefined ? '' : String(account).trim();
  if (id === '') return '—';
  return (
    <EntityLink
      type="account"
      params={{ id }}
      label={id}
      title={`Open account ${id} details`}
      {...rest}
    >
      {children ?? id}
    </EntityLink>
  );
}
