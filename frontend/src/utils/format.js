/**
 * FinTrace NCRP — display formatting helpers.
 *
 * Everything money- and date-shaped that the UI renders passes through here so
 * the Indian conventions (lakh/crore grouping, "15 Jan 2024" dates) are applied
 * consistently. All helpers tolerate null / undefined / NaN and return a dash
 * placeholder rather than throwing, because the backend legitimately emits null
 * for amounts and dates it could not derive.
 */

const DASH = '—';

/** Coerce anything to a finite number, or null if it isn't one. */
function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

const inrGrouping = new Intl.NumberFormat('en-IN', {
  maximumFractionDigits: 0,
});

const inrGroupingPaise = new Intl.NumberFormat('en-IN', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/**
 * Full Indian-grouped rupee amount, e.g. 423500 → "₹4,23,500".
 * Pass `{ paise: true }` to keep two decimal places.
 *
 * @param {number|string|null|undefined} amount
 * @param {{ paise?: boolean }} [opts]
 * @returns {string}
 */
export function formatINR(amount, opts = {}) {
  const n = toNumber(amount);
  if (n === null) return DASH;
  const fmt = opts.paise ? inrGroupingPaise : inrGrouping;
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${fmt.format(Math.abs(n))}`;
}

/**
 * Compact rupee amount with Indian magnitude suffixes for cards and chart
 * labels, e.g. 423500 → "₹4.2L", 12000000 → "₹1.2Cr", 45000 → "₹45K".
 * Mirrors the backend analyzer's formatINR so officer-facing numbers match.
 *
 * @param {number|string|null|undefined} amount
 * @returns {string}
 */
export function formatCrore(amount) {
  const n = toNumber(amount);
  if (n === null) return DASH;
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const trim = (x) => String(Math.round(x * 100) / 100).replace(/\.0+$/, '');
  if (abs >= 1e7) return `${sign}₹${trim(abs / 1e7)}Cr`;
  if (abs >= 1e5) return `${sign}₹${trim(abs / 1e5)}L`;
  if (abs >= 1e3) return `${sign}₹${trim(abs / 1e3)}K`;
  return `${sign}₹${trim(abs)}`;
}

/** Parse a date-ish value to a Date, or null. */
function toDate(dateStr) {
  if (dateStr === null || dateStr === undefined || dateStr === '') return null;
  const d = dateStr instanceof Date ? dateStr : new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d;
}

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/**
 * "15 Jan 2024" — date only.
 *
 * @param {string|Date|null|undefined} dateStr
 * @returns {string}
 */
export function formatDate(dateStr) {
  const d = toDate(dateStr);
  if (!d) return DASH;
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/**
 * "15 Jan 2024, 10:30 AM" — date + 12-hour clock, in the LOCAL zone.
 *
 * Use this for true UTC instants the app generates itself (upload time, action
 * timestamps), where the officer expects their own wall-clock. For NCRP SOURCE
 * timestamps use {@link formatDateTimeUTC} instead — see its note.
 *
 * @param {string|Date|null|undefined} dateStr
 * @returns {string}
 */
export function formatDateTime(dateStr) {
  const d = toDate(dateStr);
  if (!d) return DASH;
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const meridiem = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${formatDate(d)}, ${hours}:${minutes} ${meridiem}`;
}

/**
 * "15 Jan 2024, 10:30 AM" — date + 12-hour clock, read in UTC.
 *
 * NCRP source timestamps (transaction_date, and the analyzer's first/last dates)
 * are stored as the source file's IST wall-clock RELABELLED as UTC — the parser
 * does not shift IST→UTC (see backend ncrpParser.parseDate). So to show the
 * officer the EXACT wall-clock printed in the source file we must read the
 * components in UTC, not the local zone. On an IST machine (the deployment
 * target) the local zone would add +5:30 to every timestamp and roll any source
 * time at/after 18:30 onto the next calendar day — i.e. show the wrong date for
 * the raw evidence table. This formatter is the display half of Transactions
 * audit #1; the analyzer's calendar-day logic was corrected to match.
 *
 * @param {string|Date|null|undefined} dateStr
 * @returns {string}
 */
export function formatDateTimeUTC(dateStr) {
  const d = toDate(dateStr);
  if (!d) return DASH;
  let hours = d.getUTCHours();
  const minutes = String(d.getUTCMinutes()).padStart(2, '0');
  const meridiem = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hours}:${minutes} ${meridiem}`;
}

/** Plain integer with Indian grouping, e.g. 12500 → "12,500". */
export function formatNumber(value) {
  const n = toNumber(value);
  if (n === null) return DASH;
  return inrGrouping.format(n);
}

/** A ratio (0–1) as a percentage, e.g. 0.834 → "83%". */
export function formatPercent(ratio, decimals = 0) {
  const n = toNumber(ratio);
  if (n === null) return DASH;
  return `${(n * 100).toFixed(decimals)}%`;
}

/** Hours as a friendly duration, e.g. 6 → "6h", 1.5 → "1.5h", 30 → "1.3d". */
export function formatHours(hours) {
  const n = toNumber(hours);
  if (n === null) return DASH;
  if (n < 24) return `${Math.round(n * 10) / 10}h`;
  return `${Math.round((n / 24) * 10) / 10}d`;
}

/**
 * Resolve a mule risk score (additive; uncapped, can exceed 100) to a CSS colour from the design tokens.
 * HIGH ≥ 70 → red, MEDIUM ≥ 40 → orange, else green. Matches the backend's
 * RISK_HIGH / RISK_MEDIUM thresholds in analyzer.js.
 *
 * @param {number|string|null|undefined} score
 * @returns {string} A `var(--…)` colour reference.
 */
export function getMuleRiskColor(score) {
  const n = toNumber(score) ?? 0;
  // Theme-aware risk-tier tokens: identical to the grammar colours in light
  // mode, lifted toward white in dark mode so the score number / risk pill /
  // risk stat-cards stay AA-legible on the dark card. Thresholds unchanged.
  if (n >= 70) return 'var(--risk-high)';
  if (n >= 40) return 'var(--risk-medium)';
  return 'var(--risk-low)';
}

/** Risk band label for a score, e.g. 82 → "HIGH". */
export function getMuleRiskLabel(score) {
  const n = toNumber(score) ?? 0;
  if (n >= 70) return 'HIGH';
  if (n >= 40) return 'MEDIUM';
  return 'LOW';
}

/**
 * Resolve a lien_status to a CSS colour.
 *   pending → orange, applied → navy, success → green, rejected → red.
 *
 * @param {string|null|undefined} status
 * @returns {string} A `var(--…)` colour reference.
 */
export function getLienStatusColor(status) {
  switch (String(status || '').toLowerCase()) {
    case 'success':
      return 'var(--accent)';
    case 'applied':
      return 'var(--brand)';
    case 'rejected':
      return 'var(--danger)';
    case 'pending':
    default:
      return 'var(--accent-orange)';
  }
}
