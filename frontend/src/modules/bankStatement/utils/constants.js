/**
 * Bank Statement module — shared UI constants.
 *
 * (Formerly mockData.js from the scaffold pass; the mock files/detector are
 * gone now that upload, detection and the mapping wizard are all real.)
 */

/** Extensions the drop zone accepts (mirrors the backend allow-list). */
export const ACCEPTED_EXTENSIONS = ['.pdf', '.xlsx', '.xls', '.csv'];

/**
 * Canonical roles a source column can be mapped to in the wizard. Mirrors
 * the backend's genericMapped ROLES. `ignore` drops the column.
 *
 * Direction comes from EITHER split debit+credit columns OR a single
 * amount column (optionally with a Dr/Cr type column) — the wizard
 * explains whichever shape the current selection implies.
 */
export const CANONICAL_FIELDS = [
  { value: 'date', label: 'Date' },
  { value: 'narration', label: 'Narration' },
  { value: 'debit', label: 'Debit' },
  { value: 'credit', label: 'Credit' },
  { value: 'amount', label: 'Amount (single column)' },
  { value: 'type', label: 'Type (Dr/Cr column)' },
  { value: 'balance', label: 'Balance' },
  { value: 'ref_no', label: 'Ref No.' },
  { value: 'ignore', label: 'Ignore' },
];

/** Date-format hints offered when auto-detection could be ambiguous. */
export const DATE_FORMATS = [
  { value: 'auto', label: 'Auto (day-first for ambiguous dates)' },
  { value: 'DMY', label: 'Day / Month / Year' },
  { value: 'MDY', label: 'Month / Day / Year' },
  { value: 'YMD', label: 'Year / Month / Day' },
];
