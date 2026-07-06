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

// ─── atm / merchant (exit terminal) ──────────────────────────────────

/** Columns shared by the terminal and flag-card drills (cash-exit legs). */
function terminalColumns({ drill }, { withTerminal = false, withWhy = false } = {}) {
  const cols = [
    {
      key: 'date',
      header: 'Date',
      render: (r) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {r.same_day && <span title="Withdrawn the same day it was received" style={{ marginRight: 4 }}>⚡</span>}
          {r.date ? formatDateTimeUTC(r.date) : '—'}
        </span>
      ),
    },
    { key: 'channel', header: 'Channel' },
    {
      key: 'account',
      header: 'Account',
      mono: true,
      render: (r) => (r.account
        ? (
          <button
            type="button"
            className="entity-link"
            title={`Open account ${r.account}`}
            onClick={(e) => {
              e.stopPropagation();
              drill({ type: 'account', params: { id: r.account }, label: r.account });
            }}
          >
            {r.account}
          </button>
        )
        : '—'),
    },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatINR(r.amount) },
    { key: 'disputed', header: 'Disputed', align: 'right', render: (r) => formatINR(r.disputed) },
  ];
  if (withTerminal) {
    cols.push({ key: 'atm_id', header: 'ATM/Terminal', mono: true, render: (r) => r.atm_id || '—' });
  }
  cols.push(
    { key: 'location', header: 'Location', render: (r) => trunc(r.location, 170) },
    { key: 'city', header: 'City', render: (r) => r.city || '—' },
    { key: 'state', header: 'State', render: (r) => r.state || '—' },
  );
  if (withWhy) {
    cols.push({
      key: 'why',
      header: 'Why flagged',
      render: (r) => <span className="why-flag">{r.why || '—'}</span>,
    });
  }
  return cols;
}

function terminalSubtitle(d) {
  const parts = [];
  const s = d.summary || {};
  const c = d.context || {};
  parts.push(`${formatNumber(s.row_count || 0)} cash-exit leg${s.row_count === 1 ? '' : 's'}`);
  if (c.channels && c.channels.length) parts.push(c.channels.join(' + '));
  if (c.location) parts.push(c.location);
  if (s.first_seen) {
    parts.push(s.last_seen && s.last_seen !== s.first_seen
      ? `${formatDate(s.first_seen)} – ${formatDate(s.last_seen)}`
      : formatDate(s.first_seen));
  }
  return parts.join(' · ');
}

const TERMINAL_CHIP_HINTS = {
  amount: 'Gross legs at this terminal — the same per-terminal figure as the Top ATMs/merchants table and the Dashboard cashout locations.',
  disputed: 'Traced fraud portion of those legs.',
};

function makeTerminalAdapter({ icon, amountLabel }) {
  return {
    icon,
    titleMono: true,
    title: (d) => (d.context && d.context.is_unknown_bucket ? 'No terminal id' : d.entity_id),
    subtitle: terminalSubtitle,
    badges: (d) => (d.context && d.context.is_unknown_bucket
      ? <Badge color="var(--text-muted)" dot={false}>Legs without a terminal id in the source file</Badge>
      : null),
    chips: (d) => {
      const s = d.summary || {};
      const chips = [];
      pushChip(chips, amountLabel, s.total_amount, { tone: 'warn', hint: TERMINAL_CHIP_HINTS.amount });
      pushChip(chips, 'Disputed', s.total_disputed, { tone: 'danger', hint: TERMINAL_CHIP_HINTS.disputed });
      pushChip(chips, 'Transactions', s.txn_count, { raw: true, value: formatNumber(s.txn_count) });
      pushChip(chips, 'Unique accounts', s.unique_accounts, { raw: true, value: formatNumber(s.unique_accounts) });
      return chips;
    },
    notes: () => null,
    columns: (ctx) => terminalColumns(ctx),
    searchPlaceholder: () => 'Search account, channel, location, city, state…',
    totals: (visibleRows) => [
      { label: 'Total (shown)', value: formatINR(visibleRows.reduce((s, r) => s + (r.amount || 0), 0)) },
      { label: 'Disputed', value: formatINR(visibleRows.reduce((s, r) => s + (r.disputed || 0), 0)) },
    ],
    emptyMessage: () => 'No cash-exit legs recorded at this terminal in the uploaded file.',
  };
}

// ─── cashflag (behavioural flag card → pre-filtered set) ─────────────

const cashflagAdapter = {
  icon: '⚑',
  titleMono: false,
  title: (d) => (d.context && d.context.flag_label) || d.entity_id,
  subtitle: (d) => {
    const s = d.summary || {};
    const c = d.context || {};
    const parts = [`${c.channel || ''} channel`.trim()];
    parts.push(`${formatNumber(s.instance_count || 0)} flagged instance${s.instance_count === 1 ? '' : 's'}`);
    parts.push(`${formatNumber(s.flagged_txn_count || 0)} transaction${s.flagged_txn_count === 1 ? '' : 's'}`);
    if (s.first_seen) {
      parts.push(s.last_seen && s.last_seen !== s.first_seen
        ? `${formatDate(s.first_seen)} – ${formatDate(s.last_seen)}`
        : formatDate(s.first_seen));
    }
    return parts.join(' · ');
  },
  badges: (d) => (d.context && d.context.channel
    ? <Badge color="var(--risk-high)">{d.context.channel}</Badge>
    : null),
  chips: (d) => {
    const s = d.summary || {};
    const chips = [];
    pushChip(chips, 'Instances', s.instance_count, { tone: 'danger', raw: true, value: formatNumber(s.instance_count) });
    pushChip(chips, 'Flagged txns', s.flagged_txn_count, { raw: true, value: formatNumber(s.flagged_txn_count) });
    pushChip(chips, 'Total amount', s.total_amount, {
      tone: 'warn',
      hint: 'Sum of the flagged instances’ amounts, as computed by the behavioural-flag analysis.',
    });
    pushChip(chips, 'Accounts', s.unique_accounts, { raw: true, value: formatNumber(s.unique_accounts) });
    return chips;
  },
  notes: (d) => (Array.isArray(d.notes) && d.notes.length > 0
    ? { title: 'Why these were flagged', items: d.notes }
    : null),
  columns: (ctx) => terminalColumns(ctx, { withTerminal: true, withWhy: true }),
  searchPlaceholder: () => 'Search account, terminal, location, why flagged…',
  totals: (visibleRows) => [
    { label: 'Total (shown)', value: formatINR(visibleRows.reduce((s, r) => s + (r.amount || 0), 0)) },
    { label: 'Disputed', value: formatINR(visibleRows.reduce((s, r) => s + (r.disputed || 0), 0)) },
  ],
  emptyMessage: () => 'No instances of this behavioural flag in the uploaded file.',
};

// ─── shared cell helpers (Phase C) ───────────────────────────────────

/** Clickable account cell — the identifier-as-doorway pattern. */
function accountCell(drill, value) {
  if (!value) return '—';
  return (
    <button
      type="button"
      className="entity-link"
      title={`Open account ${value}`}
      onClick={(e) => {
        e.stopPropagation();
        drill({ type: 'account', params: { id: value }, label: value });
      }}
    >
      {value}
    </button>
  );
}

const moneyTotals = (label = 'Total (shown)') => (visibleRows) => [
  { label, value: formatINR(visibleRows.reduce((s, r) => s + (r.amount || 0), 0)) },
  { label: 'Disputed', value: formatINR(visibleRows.reduce((s, r) => s + (r.disputed || 0), 0)) },
];

// ─── layer ───────────────────────────────────────────────────────────

const layerAdapter = {
  icon: '📚',
  titleMono: false,
  title: (d) => `Layer ${d.entity_id}`,
  subtitle: (d) => {
    const s = d.summary || {};
    const c = d.context || {};
    const parts = [];
    if (s.txn_count != null) parts.push(`${formatNumber(s.txn_count)} hop transaction${s.txn_count === 1 ? '' : 's'}`);
    if (s.bank_count != null) parts.push(`${formatNumber(s.bank_count)} bank${s.bank_count === 1 ? '' : 's'}`);
    if (c.fan_out_ratio != null) parts.push(`fan-out ${c.fan_out_ratio}${c.fan_out_high ? ' (high)' : ''}`);
    if (c.avg_forward_time_hours != null) parts.push(`avg forward ${c.avg_forward_time_hours}h`);
    return parts.join(' · ');
  },
  badges: (d) => (d.context && d.context.fan_out_high
    ? <Badge color="var(--risk-high)">High fan-out</Badge>
    : null),
  chips: (d) => {
    const s = d.summary || {};
    const chips = [];
    pushChip(chips, 'Amount (gross)', s.total_amount, {
      tone: 'warn',
      hint: 'Gross hop amounts arriving at this layer — the same figure as the Layers page.',
    });
    pushChip(chips, 'Disputed', s.total_disputed, { tone: 'danger' });
    pushChip(chips, 'Accounts at hop', s.account_count, { raw: true, value: formatNumber(s.account_count) });
    pushChip(chips, 'Cash-out legs', s.cashout_count, { raw: true, value: formatNumber(s.cashout_count) });
    return chips;
  },
  notes: (d) => (Array.isArray(d.notes) && d.notes.length > 0
    ? { title: 'About this list', items: d.notes }
    : null),
  columns: ({ drill }) => [
    { key: 'account_no', header: 'Account', mono: true, render: (r) => accountCell(drill, r.account_no) },
    { key: 'bank_name', header: 'Bank', render: (r) => trunc(r.bank_name, 180) },
    { key: 'total_received', header: 'Received (gross)', align: 'right', render: (r) => formatINR(r.total_received) },
    { key: 'disputed_received', header: 'Traced fraud in', align: 'right', render: (r) => formatINR(r.disputed_received) },
    { key: 'total_cashout', header: 'Cashed out', align: 'right', render: (r) => formatINR(r.total_cashout) },
    { key: 'mule_score', header: 'Risk', render: (r) => (r.mule_score != null ? <Badge variant="risk" value={r.mule_score} /> : '—') },
    { key: 'txn_count', header: 'Txns', align: 'right', render: (r) => (r.txn_count == null ? '—' : formatNumber(r.txn_count)) },
  ],
  searchPlaceholder: () => 'Search account, bank, risk…',
  totals: (visibleRows) => [
    { label: 'Received (shown, gross)', value: formatINR(visibleRows.reduce((s, r) => s + (r.total_received || 0), 0)) },
    { label: 'Traced fraud', value: formatINR(visibleRows.reduce((s, r) => s + (r.disputed_received || 0), 0)) },
  ],
  emptyMessage: () => 'No scored accounts are attributed to this layer.',
};

// ─── edge (sender → receiver) ────────────────────────────────────────

const edgeAdapter = {
  icon: '➜',
  titleMono: true,
  title: (d) => d.entity_id,
  subtitle: (d) => {
    const s = d.summary || {};
    const c = d.context || {};
    const parts = [];
    parts.push(`${formatNumber(s.txn_count || 0)} hop transaction${s.txn_count === 1 ? '' : 's'}`);
    if (c.layers) parts.push(`Layer ${c.layers}`);
    if (c.banks) parts.push(c.banks);
    if (s.first_seen) {
      parts.push(s.last_seen && s.last_seen !== s.first_seen
        ? `${formatDate(s.first_seen)} – ${formatDate(s.last_seen)}`
        : formatDate(s.first_seen));
    }
    return parts.join(' · ');
  },
  badges: () => null,
  chips: (d) => {
    const s = d.summary || {};
    const chips = [];
    pushChip(chips, 'Moved', s.total_amount, {
      tone: 'warn',
      hint: 'Gross fund movement along this edge — the same figure as the Money Flow top-edges table. Dispositions (ATM/POS/hold) between the same pair are not part of the edge.',
    });
    pushChip(chips, 'Disputed', s.total_disputed, { tone: 'danger' });
    pushChip(chips, 'Transactions', s.txn_count, { raw: true, value: formatNumber(s.txn_count) });
    return chips;
  },
  notes: () => null,
  columns: () => [
    {
      key: 'date',
      header: 'Date',
      render: (r) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {r.same_day && <span title="Cash-out the same day" style={{ marginRight: 4 }}>⚡</span>}
          {r.date ? formatDateTimeUTC(r.date) : '—'}
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatINR(r.amount) },
    { key: 'disputed', header: 'Disputed', align: 'right', render: (r) => formatINR(r.disputed) },
    { key: 'mode', header: 'Mode', render: (r) => r.mode || '—' },
    { key: 'layer', header: 'Layer', render: (r) => (r.layer == null ? '—' : `L${r.layer}`) },
    { key: 'utr', header: 'UTR', mono: true, render: (r) => trunc(r.utr, 130) },
    { key: 'bank', header: 'Beneficiary Bank', render: (r) => trunc(r.bank, 160) },
    { key: 'ifsc', header: 'IFSC', mono: true, render: (r) => r.ifsc || '—' },
  ],
  searchPlaceholder: () => 'Search bank, IFSC, UTR, mode, location…',
  totals: moneyTotals(),
  emptyMessage: () => 'No hop transactions between this pair in the deduplicated trail.',
};

// ─── bank ────────────────────────────────────────────────────────────

const bankAdapter = {
  icon: '🏦',
  titleMono: false,
  title: (d) => d.entity_id,
  subtitle: (d) => {
    const s = d.summary || {};
    const c = d.context || {};
    const parts = [];
    parts.push(`${formatNumber(s.row_count || 0)} ledger row${s.row_count === 1 ? '' : 's'} (raw${s.duplicate_count ? ` · ${formatNumber(s.duplicate_count)} ⧉ duplicate${s.duplicate_count === 1 ? '' : 's'}` : ''})`);
    if (c.layers_touched && c.layers_touched.length) {
      parts.push(`Layers ${c.layers_touched.map((l) => `L${l}`).join(', ')}`);
    }
    if (s.first_seen) {
      parts.push(s.last_seen && s.last_seen !== s.first_seen
        ? `${formatDate(s.first_seen)} – ${formatDate(s.last_seen)}`
        : formatDate(s.first_seen));
    }
    return parts.join(' · ');
  },
  badges: () => null,
  chips: (d) => {
    const s = d.summary || {};
    const chips = [];
    pushChip(chips, 'Ledger rows', s.row_count, {
      raw: true,
      value: formatNumber(s.row_count),
      hint: 'Raw legs whose beneficiary sits at this bank — identical to the Transactions page filtered by this bank (duplicates kept and ⧉-flagged).',
    });
    pushChip(chips, 'Accounts', s.unique_accounts, { raw: true, value: formatNumber(s.unique_accounts) });
    pushChip(chips, 'Layers touched', s.layer_count, { raw: true, value: formatNumber(s.layer_count) });
    pushChip(chips, '⧉ Duplicates', s.duplicate_count, { raw: true, value: formatNumber(s.duplicate_count) });
    return chips;
  },
  notes: () => null,
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
          {r.date ? formatDateTimeUTC(r.date) : '—'}
        </span>
      ),
    },
    { key: 'account', header: 'Account', mono: true, render: (r) => accountCell(drill, r.account) },
    { key: 'name', header: 'Name', render: (r) => trunc(r.name, 140) },
    { key: 'ifsc', header: 'IFSC', mono: true, render: (r) => r.ifsc || '—' },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatINR(r.amount) },
    { key: 'disputed', header: 'Disputed', align: 'right', render: (r) => formatINR(r.disputed) },
    { key: 'mode', header: 'Mode', render: (r) => r.mode || '—' },
    { key: 'layer', header: 'Layer', render: (r) => (r.layer == null ? '—' : `L${r.layer}`) },
    { key: 'utr', header: 'UTR', mono: true, render: (r) => trunc(r.utr, 130) },
  ],
  searchPlaceholder: () => 'Search account, name, IFSC, UTR, mode, city…',
  totals: moneyTotals('Total (shown, gross)'),
  emptyMessage: () => 'No ledger rows at this bank in the uploaded file.',
};

// ─── timelineDay ─────────────────────────────────────────────────────

const timelineDayAdapter = {
  icon: '📅',
  titleMono: false,
  title: (d) => formatDate(d.entity_id),
  subtitle: (d) => {
    const s = d.summary || {};
    const c = d.context || {};
    const parts = [];
    parts.push(`${formatNumber(s.txn_count || 0)} transaction${s.txn_count === 1 ? '' : 's'}`);
    if (s.cashout_count != null) parts.push(`${formatNumber(s.cashout_count)} cash-out leg${s.cashout_count === 1 ? '' : 's'}`);
    if (c.layers_active && c.layers_active.length) {
      parts.push(`Layers ${c.layers_active.map((l) => `L${l}`).join(', ')}`);
    }
    return parts.join(' · ');
  },
  badges: () => null,
  chips: (d) => {
    const s = d.summary || {};
    const chips = [];
    pushChip(chips, 'Amount', s.total_amount, {
      tone: 'warn',
      hint: 'Total moved on this day (deduplicated ledger) — the same figure as the Timeline page.',
    });
    pushChip(chips, 'Transactions', s.txn_count, { raw: true, value: formatNumber(s.txn_count) });
    pushChip(chips, 'Cash-outs', s.cashout_count, { raw: true, value: formatNumber(s.cashout_count) });
    return chips;
  },
  notes: () => null,
  columns: ({ drill }) => [
    {
      key: 'date',
      header: 'Time',
      render: (r) => (
        <span style={{ whiteSpace: 'nowrap' }}>
          {r.same_day && <span title="Cash-out the same day it was received" style={{ marginRight: 4 }}>⚡</span>}
          {r.date ? formatDateTimeUTC(r.date) : '—'}
        </span>
      ),
    },
    { key: 'from_account', header: 'From', mono: true, render: (r) => accountCell(drill, r.from_account) },
    { key: 'to_account', header: 'To', mono: true, render: (r) => accountCell(drill, r.to_account) },
    { key: 'bank', header: 'Beneficiary Bank', render: (r) => trunc(r.bank, 160) },
    { key: 'amount', header: 'Amount', align: 'right', render: (r) => formatINR(r.amount) },
    { key: 'disputed', header: 'Disputed', align: 'right', render: (r) => formatINR(r.disputed) },
    { key: 'mode', header: 'Mode', render: (r) => r.mode || '—' },
    { key: 'layer', header: 'Layer', render: (r) => (r.layer == null ? '—' : `L${r.layer}`) },
    { key: 'utr', header: 'UTR', mono: true, render: (r) => trunc(r.utr, 130) },
  ],
  searchPlaceholder: () => 'Search accounts, bank, IFSC, UTR, mode…',
  totals: moneyTotals(),
  emptyMessage: () => 'No transactions on this day in the deduplicated trail.',
};

// ─── transaction (single ledger row) ─────────────────────────────────

function txnValueCell(drill, r) {
  const v = r.value;
  if (v === null || v === undefined || v === '') return '—';
  switch (r.kind) {
    case 'account':
      return accountCell(drill, v);
    case 'money':
      return <span className="money-accent">{formatINR(v, { paise: true })}</span>;
    case 'date':
      return formatDateTimeUTC(v);
    case 'bool':
      return v ? '✔ Yes' : 'No';
    default:
      return <span style={{ wordBreak: 'break-word' }}>{String(v)}</span>;
  }
}

const transactionAdapter = {
  icon: '🧾',
  titleMono: false,
  title: (d) => `Transaction #${d.entity_id}`,
  subtitle: (d) => {
    const c = d.context || {};
    const parts = [];
    if (c.payment_mode) parts.push(c.payment_mode);
    if (c.layer_no != null) parts.push(`Layer ${c.layer_no}`);
    return parts.join(' · ');
  },
  badges: (d) => (d.context && d.context.is_duplicate
    ? (
      <Badge color="var(--text-muted)" dot={false}>
        ⧉ Exact duplicate — excluded from totals
      </Badge>
    )
    : null),
  chips: () => [],
  notes: () => null,
  columns: ({ drill }) => [
    { key: 'field', header: 'Field', render: (r) => <strong style={{ fontWeight: 600 }}>{r.field}</strong> },
    { key: 'value', header: 'Value', mono: true, render: (r) => txnValueCell(drill, r) },
  ],
  searchPlaceholder: () => 'Search field or value…',
  totals: () => [],
  emptyMessage: () => 'No stored fields for this transaction.',
};

// ─── Registry ────────────────────────────────────────────────────────

export const ENTITY_ADAPTERS = {
  account: accountAdapter,
  atm: makeTerminalAdapter({ icon: '🏧', amountLabel: 'Withdrawn' }),
  merchant: makeTerminalAdapter({ icon: '🏪', amountLabel: 'Total spend' }),
  cashflag: cashflagAdapter,
  layer: layerAdapter,
  edge: edgeAdapter,
  bank: bankAdapter,
  timelineDay: timelineDayAdapter,
  transaction: transactionAdapter,
};
