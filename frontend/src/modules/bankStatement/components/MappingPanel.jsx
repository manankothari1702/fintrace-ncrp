/**
 * Inline column-mapping wizard for a not-recognised statement file.
 *
 * Rendered IN-FLOW inside the file's own row (never a modal/overlay): the row
 * expands to reveal this panel so the officer keeps the file in context while
 * mapping its columns. Each detected header gets a dropdown onto a canonical
 * field; a checkbox offers to remember the mapping as a template for future
 * files from the same bank.
 *
 * All state is local to the panel until "Apply mapping" — which, in this
 * scaffold pass, is a no-op that hands the confirmed mapping back to the
 * parent so it can show a success state.
 */
import { useState } from 'react';

import { CANONICAL_FIELDS } from '../utils/mockData.js';

export default function MappingPanel({ headers, onApply, onCancel }) {
  // Seed each dropdown from the detector's suggested field.
  const [mapping, setMapping] = useState(() =>
    Object.fromEntries(headers.map((h) => [h.header, h.suggested])),
  );
  const [saveAsTemplate, setSaveAsTemplate] = useState(true);

  const setField = (header, field) => setMapping((m) => ({ ...m, [header]: field }));

  return (
    <div className="bs-mapping">
      <div className="bs-mapping-head">
        <span className="bs-mapping-title">Map columns to canonical fields</span>
        <span className="bs-mapping-sub">
          We couldn&apos;t auto-detect this bank. Confirm how each column maps, then apply.
        </span>
      </div>

      <div className="bs-mapping-rows">
        {headers.map((h) => (
          <div className="bs-map-row" key={h.header}>
            <span className="bs-map-source" title={h.header}>{h.header}</span>
            <span className="bs-map-arrow" aria-hidden="true">→</span>
            <select
              className="select bs-map-select"
              value={mapping[h.header]}
              onChange={(e) => setField(h.header, e.target.value)}
              aria-label={`Map column "${h.header}" to`}
            >
              {CANONICAL_FIELDS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </div>
        ))}
      </div>

      <label className="bs-map-template">
        <input
          type="checkbox"
          checked={saveAsTemplate}
          onChange={(e) => setSaveAsTemplate(e.target.checked)}
        />
        <span>Save as template for future files from this bank</span>
      </label>

      <div className="bs-map-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => onApply({ mapping, saveAsTemplate })}
        >
          Apply mapping
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
