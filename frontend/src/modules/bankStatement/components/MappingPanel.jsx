/**
 * Inline column-mapping wizard for a not-recognised statement file — REAL.
 *
 * Rendered IN-FLOW inside the file's own row (never a modal/overlay). The
 * officer maps each server-detected header onto a canonical role; the panel
 * adapts to the direction shape the selection implies:
 *
 *   • split Debit + Credit columns   → direction is which column is filled;
 *   • single Amount + a Type column  → the officer confirms which tokens
 *     mean debit vs credit (defaults DR/CR);
 *   • single Amount, no Type column  → negative amounts are debits.
 *
 * A date-format hint covers ambiguous exports (auto = Indian day-first), a
 * preview of the file's first data rows keeps the mapping honest, and "save
 * as template" (default ON, needs a bank name) makes the layout auto-detect
 * on every future upload. Balance Cr./Dr. suffixes are handled automatically.
 *
 * "Apply mapping" hands the confirmed payload to the parent, which calls
 * POST /bank-statement/apply-mapping; server-side failures surface back here
 * via `applyError`.
 */
import { useMemo, useState } from 'react';

import { CANONICAL_FIELDS, DATE_FORMATS } from '../utils/constants.js';

export default function MappingPanel({
  headers, preview, defaultBankName, applyError, busy, onApply, onCancel,
}) {
  // Seed each dropdown from the server's suggested role.
  const [mapping, setMapping] = useState(() =>
    Object.fromEntries(headers.map((h) => [h.header, h.suggested || 'ignore'])),
  );
  const [saveAsTemplate, setSaveAsTemplate] = useState(true);
  const [bankName, setBankName] = useState(defaultBankName || '');
  const [dateFormat, setDateFormat] = useState('auto');
  const [debitToken, setDebitToken] = useState('DR');
  const [creditToken, setCreditToken] = useState('CR');
  const [localError, setLocalError] = useState(null);

  const setField = (header, field) => {
    setLocalError(null);
    setMapping((m) => ({ ...m, [header]: field }));
  };

  const roles = useMemo(() => Object.values(mapping), [mapping]);
  const has = (role) => roles.includes(role);
  const singleAmount = has('amount');
  const splitAmount = has('debit') || has('credit');
  const typeMapped = has('type');

  /** Same structural rules the backend enforces — fail fast, in place. */
  const validate = () => {
    const nonIgnore = roles.filter((r) => r !== 'ignore');
    const dupes = nonIgnore.filter((r, i) => nonIgnore.indexOf(r) !== i);
    if (dupes.length > 0) return `"${dupes[0]}" is mapped to more than one column.`;
    if (!has('date')) return 'Map one column to Date.';
    if (!singleAmount && !splitAmount) return 'Map Debit/Credit columns, or one Amount column.';
    if (singleAmount && splitAmount) return 'Map EITHER Debit/Credit columns OR a single Amount column — not both.';
    if (typeMapped && !singleAmount) return 'A Type (Dr/Cr) column only applies with a single Amount column.';
    if (saveAsTemplate && bankName.trim() === '') return 'Enter a bank name to save this mapping as a template.';
    if (typeMapped && (debitToken.trim() === '' || creditToken.trim() === '')) {
      return 'Enter the Type column’s debit and credit values.';
    }
    return null;
  };

  const apply = () => {
    const problem = validate();
    if (problem) { setLocalError(problem); return; }
    const options = { dateFormat };
    if (typeMapped) {
      options.debitValues = [debitToken.trim()];
      options.creditValues = [creditToken.trim()];
    }
    onApply({
      mapping: { version: 1, columns: mapping, options },
      bankName: bankName.trim(),
      saveAsTemplate,
    });
  };

  const error = localError || applyError;

  return (
    <div className="bs-mapping">
      <div className="bs-mapping-head">
        <span className="bs-mapping-title">Map columns to canonical fields</span>
        <span className="bs-mapping-sub">
          We couldn&apos;t auto-detect this bank. Confirm how each column maps, then apply.
        </span>
      </div>

      {/* First rows of the actual file, so the mapping is made against reality. */}
      {preview && preview.length > 0 && (
        <div className="bs-map-preview" role="table" aria-label="File preview">
          <table>
            <thead>
              <tr>{headers.map((h) => <th key={h.header}>{h.header}</th>)}</tr>
            </thead>
            <tbody>
              {preview.map((row, i) => (
                // Preview rows are positional file excerpts with no stable id.
                // eslint-disable-next-line react/no-array-index-key
                <tr key={i}>
                  {headers.map((h, c) => <td key={h.header}>{row[c]}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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

      {/* Direction shape — adapts to the roles chosen above. */}
      <div className="bs-map-config">
        {splitAmount && !singleAmount && (
          <p className="bs-map-hint">
            Direction comes from which of the Debit / Credit columns is filled on each row.
          </p>
        )}
        {singleAmount && typeMapped && (
          <div className="bs-map-config-row">
            <span className="bs-map-hint">In the Type column,</span>
            <label>
              debit rows say
              <input
                className="input bs-map-token"
                value={debitToken}
                onChange={(e) => { setLocalError(null); setDebitToken(e.target.value); }}
                aria-label="Type value meaning debit"
              />
            </label>
            <label>
              credit rows say
              <input
                className="input bs-map-token"
                value={creditToken}
                onChange={(e) => { setLocalError(null); setCreditToken(e.target.value); }}
                aria-label="Type value meaning credit"
              />
            </label>
          </div>
        )}
        {singleAmount && !typeMapped && (
          <p className="bs-map-hint">
            No Dr/Cr column mapped — negative amounts will be treated as debits.
          </p>
        )}

        <div className="bs-map-config-row">
          <label>
            Date format
            <select
              className="select"
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value)}
              aria-label="Date format"
            >
              {DATE_FORMATS.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </select>
          </label>
        </div>
      </div>

      <label className="bs-map-template">
        <input
          type="checkbox"
          checked={saveAsTemplate}
          onChange={(e) => { setLocalError(null); setSaveAsTemplate(e.target.checked); }}
        />
        <span>Save as template for future files from this bank</span>
      </label>

      {saveAsTemplate && (
        <div className="bs-map-config-row">
          <label>
            Bank name
            <input
              className="input bs-map-bank"
              value={bankName}
              placeholder="e.g. Maple Urban Co-op Bank"
              onChange={(e) => { setLocalError(null); setBankName(e.target.value); }}
              aria-label="Bank name for the template"
            />
          </label>
        </div>
      )}

      {error && <p className="bs-map-error" role="alert">{error}</p>}

      <div className="bs-map-actions">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={apply}
          disabled={busy}
        >
          {busy ? 'Parsing…' : 'Apply mapping'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}
