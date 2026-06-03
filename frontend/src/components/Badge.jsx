/**
 * Status / risk pill. Two ways to colour it:
 *   • <Badge color="var(--danger)">HIGH</Badge>          — explicit colour
 *   • <Badge variant="lien" value="applied" />           — derive from a value
 *
 * The lien / risk variants reuse the same colour grammar as the rest of the
 * app (format.js helpers), so a badge always agrees with the table cell it
 * sits in. A tinted background is derived from the chosen colour via
 * color-mix, falling back gracefully if the value is a CSS variable.
 */

import { memo } from 'react';

import { getLienStatusColor, getMuleRiskColor, getMuleRiskLabel } from '../utils/format';

/**
 * @param {object} props
 * @param {React.ReactNode} [props.children] - Explicit label (overrides derived).
 * @param {string} [props.color] - Explicit CSS colour (overrides variant).
 * @param {'lien'|'risk'|'plain'} [props.variant='plain']
 * @param {string|number} [props.value] - Status string (lien) or score (risk).
 * @param {boolean} [props.dot=true] - Show the leading status dot.
 */
function Badge({ children, color, variant = 'plain', value, dot = true }) {
  let resolvedColor = color;
  let label = children;

  if (!resolvedColor) {
    if (variant === 'lien') {
      resolvedColor = getLienStatusColor(value);
      if (label == null) label = String(value || 'pending');
    } else if (variant === 'risk') {
      resolvedColor = getMuleRiskColor(value);
      if (label == null) label = getMuleRiskLabel(value);
    } else {
      resolvedColor = 'var(--text-muted)';
    }
  }

  const style = {
    color: resolvedColor,
    borderColor: `color-mix(in srgb, ${resolvedColor} 40%, transparent)`,
    background: `color-mix(in srgb, ${resolvedColor} 12%, transparent)`,
  };

  return (
    <span className="badge" style={style}>
      {dot && <span className="dot" />}
      {label}
    </span>
  );
}

export default memo(Badge);
