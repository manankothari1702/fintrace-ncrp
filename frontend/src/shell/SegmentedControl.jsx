/**
 * Generic segmented control (single-select).
 *
 * Deliberately array-driven and unaware of what it is switching between — it
 * renders whatever `options` it is given, so the same component backs a 2-way
 * toggle today and an N-way one later without a rewrite. Behaves as a
 * radiogroup: one option is always selected, and ←/→ (and Home/End) move the
 * selection for keyboard users.
 *
 * @param {object} props
 * @param {Array<{ id: string, label: string, icon?: React.ReactNode }>} props.options
 * @param {string} props.value              - id of the selected option
 * @param {(id: string) => void} props.onChange
 * @param {string} [props.ariaLabel='View'] - accessible name for the group
 */
export default function SegmentedControl({ options, value, onChange, ariaLabel = 'View' }) {
  const handleKeyDown = (e) => {
    const currentIndex = options.findIndex((o) => o.id === value);
    if (currentIndex < 0) return;

    let nextIndex = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIndex = (currentIndex + 1) % options.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIndex = (currentIndex - 1 + options.length) % options.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = options.length - 1;

    if (nextIndex != null) {
      e.preventDefault();
      onChange(options[nextIndex].id);
    }
  };

  return (
    <div className="seg-control" role="radiogroup" aria-label={ariaLabel} onKeyDown={handleKeyDown}>
      {options.map((opt) => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={active}
            tabIndex={active ? 0 : -1}
            className={`seg-option${active ? ' is-active' : ''}`}
            onClick={() => !active && onChange(opt.id)}
          >
            {opt.icon && <span className="seg-icon" aria-hidden="true">{opt.icon}</span>}
            <span className="seg-label">{opt.label}</span>
          </button>
        );
      })}
    </div>
  );
}
