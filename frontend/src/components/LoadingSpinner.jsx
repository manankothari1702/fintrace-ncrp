/**
 * Spinner. Inline by default; pass `block` with an optional `label` for a
 * centred full-section loading state.
 *
 * @param {object} props
 * @param {number} [props.size=20] - Diameter in px.
 * @param {boolean} [props.block=false] - Centre in a padded block with label.
 * @param {string} [props.label='Loading…'] - Text shown under the block spinner.
 */
export default function LoadingSpinner({ size = 20, block = false, label = 'Loading…' }) {
  const spinner = (
    <span
      className="spinner"
      style={{ width: size, height: size }}
      role="status"
      aria-label={label}
    />
  );

  if (!block) return spinner;

  return (
    <div className="loading-block">
      <span className="spinner" style={{ width: 32, height: 32 }} role="status" aria-label={label} />
      <span>{label}</span>
    </div>
  );
}
