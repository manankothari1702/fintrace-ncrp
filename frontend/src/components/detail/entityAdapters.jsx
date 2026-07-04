/**
 * Per-entity-type presentation adapters for the shared <DetailModal>.
 *
 * Each adapter turns the backend's entity payload (GET /ncrp/:id/entity/:type)
 * into what the modal renders: title/subtitle, summary chips, column
 * definitions (with per-cell renderers), footer totals, and the search
 * placeholder. PRESENTATION ONLY — every figure is read from the payload,
 * which itself reads from the analysis snapshot; nothing is derived here.
 *
 * Column `key`s address raw row fields so useSortableRows sorts on the real
 * values (numbers numerically, dates as ISO strings) rather than on the
 * formatted text.
 */

import Badge from '../Badge.jsx';
import {
  formatINR, formatDate, formatDateTimeUTC, formatNumber,
} from '../../utils/format.js';

// Single-line ellipsis + full value on hover — the app-wide long-text pattern.
const TRUNC = {
  display: 'inline-block', maxWidth: 180, overflow: 'hidden',
  textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom',
};

function trunc(value, maxWidth = 180) {
  if (value === null || value === undefined || value === '') return '—';
  return <span title={String(value)} style={{ ...TRUNC, maxWidth }}>{value}</span>;
}

/** Direction marker: icon + word, never colour alone. */
function DirPill({ dir }) {
  const isIn = dir === 'in';
  return (
    <span
      className={`dir-pill ${isIn ? 'dir-in' : 'dir-out'}`}
      title={isIn ? 'Money INTO this account (it is the beneficiary)' : 'Money OUT of this account (it is the sender)'}
    >
      {isIn ? '↓ IN' : '↑ OUT'}
    </span>
  );
}

/** Push a chip only when the analysis actually carries the value. */
function pushChip(chips, label, value, opts = {}) {
  if (value === null || value === undefined) return;
  chips.push({ label, value: opts.raw ? value : formatINR(value), ...opts });
}

// ─── account ─────────────────────────────────────────────────────────

const ACCOUNT_CHIP_HINTS = {
  received: 'Full inbound transaction legs (gross) — the same figure as the Mule Accounts page’s "Received (gross)".',
  traced: 'Disputed amount actually traced to this account — follows only the fraud money, so it can be far below the gross figure.',
  forwarded: 'Money moved onward to other accounts (excludes cash-outs) — same as the Mule Accounts page’s "Forwarded".',
  cashout: 'Gross ATM/POS/AEPS withdrawals by this account.',
  onhold: 'Funds put on hold by bank action.',
  eligible: 'Received − Forwarded − Cash-out − On Hold, capped at the disputed inflow — the freezable balance, same as the Lien Tracker.',
  sent: 'Money this account sent into the trail (victim-side outflow).',
};

const accountAdapter = {
  icon: '💳',
  titleMono: true,
  title: (d) => d.entity_id,

  subtitle: (d) => {
    const parts = [];
    const s = d.summary || {};
    const c = d.context || {};
    parts.push(`${formatNumber(s.row_count || 0)} ledger row${s.row_count === 1 ? '' : 's'} (raw${s.duplicate_count ? ` · ${formatNumber(s.duplicate_count)} ⧉ duplicate${s.duplicate_count === 1 ? '' : 's'}` : ''})`);
    if (c.bank) parts.push(c.bank);
    if (c.layer_no != null) parts.push(`Layer ${c.layer_no}`);
    if (s.first_seen) {
      parts.push(s.last_seen && s.last_seen !== s.first_seen
        ? `${formatDate(s.first_seen)} – ${formatDate(s.last_seen)}`
        : formatDate(s.first_seen));
    }
    return parts.join(' · ');
  },

  badges: (d) => {
    const c = d.context || {};
    return (
      <>
        {c.mule_score != null && <Badge variant="risk" value={c.mule_score} />}
        {c.aggregator && (
          <span
            className={`aggregator-flag${c.aggregator.severity === 'danger' ? ' danger' : ''}`}
            title={`Aggregator — collected from ${formatNumber(c.aggregator.distinct_senders)} distinct senders (a collection point in the mule ring).`}
          >
            ⚑ Aggregator ·{formatNumber(c.aggregator.distinct_senders)}
          </span>
        )}
        {c.is_victim && <Badge color="var(--brand-text)" dot={false}>Victim account</Badge>}
      </>
    );
  },

  chips: (d) => {
    const s = d.summary || {};
    const chips = [];
    pushChip(chips, 'Sent', s.amount_sent, { hint: ACCOUNT_CHIP_HINTS.sent });
    pushChip(chips, 'Received (gross)', s.total_received, { hint: ACCOUNT_CHIP_HINTS.received });
    pushChip(chips, 'Traced fraud in', s.disputed_received, { tone: 'danger', hint: ACCOUNT_CHIP_HINTS.traced });
    pushChip(chips, 'Forwarded', s.onward_forwarded, { hint: ACCOUNT_CHIP_HINTS.forwarded });
    pushChip(chips, 'Cashed out', s.total_cashout, { tone: 'warn', hint: ACCOUNT_CHIP_HINTS.cashout });
    pushChip(chips, 'On hold', s.total_on_hold, { tone: 'warn', hint: ACCOUNT_CHIP_HINTS.onhold });
    pushChip(chips, 'Lien eligible', s.lien_eligible_amount, { tone: 'good', hint: ACCOUNT_CHIP_HINTS.eligible });
    return chips;
  },

  notes: (d) => (Array.isArray(d.notes) && d.notes.length > 0
    ? { title: 'Why this account was flagged', items: d.notes }
    : null),

  columns: ({ drill }) => [
    {
      key: 'date',
      header: 'Date',
      render: (r) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {r.is_duplicate && (
            <span
              className="dup-flag"
              title="Exact duplicate — this leg is re-listed across NCRP sheets and is EXCLUDED from every total (shown for completeness)."
            >
              ⧉
            </span>
          )}
          {r.same_day && <span title="Withdrawn the same day it was received" style={{ marginRight: 4 }}>⚡</span>}
          {r.date ? formatDateTimeUTC(r.date) : '—'}
        </span>
      ),
    },
    { key: 'direction', header: 'Dir', render: (r) => <DirPill dir={r.direction} /> },
    {
      key: 'counterparty',
      header: 'Counterparty',
      mono: true,
      render: (r) => (r.counterparty
        ? (
          <button
            type="button"
            className="entity-link"
            title={`Open account ${r.counterparty}`}
            onClick={(e) => {
              e.stopPropagation();
              drill({ type: 'account', params: { id: r.counterparty }, label: r.counterparty });
            }}
          >
            {r.counterparty}
          </button>
        )
        : '—'),
    },
    { key: 'counterparty_name', header: 'Name', render: (r) => trunc(r.counterparty_name, 140) },
    { key: 'bank', header: 'Beneficiary Bank', render: (r) => trunc(r.bank, 160) },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatINR(r.amount) },
    { key: 'disputed', header: 'Disputed', align: 'right', render: (r) => formatINR(r.disputed) },
    { key: 'mode', header: 'Mode', render: (r) => r.mode || '—' },
    { key: 'layer', header: 'Layer', render: (r) => (r.layer == null ? '—' : `L${r.layer}`) },
    { key: 'utr', header: 'UTR', mono: true, render: (r) => trunc(r.utr, 130) },
    { key: 'location', header: 'Location', render: (r) => trunc(r.location || r.city, 150) },
  ],

  searchPlaceholder: () => 'Search counterparty, name, bank, IFSC, UTR, mode, location…',

  totals: (visibleRows) => [
    { label: 'Total (shown, gross)', value: formatINR(visibleRows.reduce((s, r) => s + (r.amount || 0), 0)) },
    { label: 'Disputed', value: formatINR(visibleRows.reduce((s, r) => s + (r.disputed || 0), 0)) },
  ],

  emptyMessage: () => 'No transactions recorded for this account in the uploaded file.',
};

// ─── Registry ────────────────────────────────────────────────────────

export const ENTITY_ADAPTERS = {
  account: accountAdapter,
};
