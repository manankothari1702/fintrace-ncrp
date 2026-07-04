/**
 * Dashboard page.
 *
 * Case overview for one report. Headline metrics use the "show both" money
 * model: a Victim Loss figure (disputed money that entered the network at the
 * first hop) plus the all-layers Total Trail Disputed for reference. Below that:
 * a Recovery Status ("fund trail") bar, key milestone dates, amount-by-layer and
 * payment-mode charts, an auto-generated Investigation Roadmap, the analyzer's
 * key findings, and the top cashout locations. Export buttons stream the PDF
 * dossier and the multi-sheet Excel workbook.
 *
 * The reportId is resolved by {@link useActiveReportId}. While the report is
 * still analysing the page shows an auto-refreshing "Analyzing…" state.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Label,
  LabelList,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import StatCard from '../components/StatCard.jsx';
import LoadingSpinner from '../components/LoadingSpinner.jsx';
import ErrorAlert from '../components/ErrorAlert.jsx';
import EntityLink, { AccountLink } from '../components/EntityLink.jsx';
import { SkeletonStats, SkeletonChart, SkeletonTable } from '../components/Skeleton.jsx';
import { formatCrore, formatINR, formatNumber, formatDate, formatHours } from '../utils/format.js';
import {
  getReport, getPaymentModes, saveReportPdf, saveReportExcel, suggestExportName,
  friendlyErrorMessage, ApiError,
} from '../utils/api.js';
import { useActiveReportId } from '../context/ReportContext.jsx';

// ─── Colour helpers ──────────────────────────────────────────────────────────

/* recharts paints SVG fills, which don't resolve CSS var() / color-mix() the way
   CSS properties do. So chart colours are resolved to CONCRETE values from the
   live design tokens via getComputedStyle, and re-resolved whenever the theme
   flips (the hook watches data-theme on <html>). This is what makes the charts
   theme-aware — recharts does not auto-theme. */

function hexToRgb(hex) {
  let h = String(hex || '').trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h || '0', 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Linear-interpolate between two RGB triples, returning an `rgb(...)` string. */
function mixRgb(a, b, t) {
  const u = Math.max(0, Math.min(1, t));
  const ch = (i) => Math.round(a[i] + (b[i] - a[i]) * u);
  return `rgb(${ch(0)}, ${ch(1)}, ${ch(2)})`;
}

/**
 * Resolve the design tokens the charts need into concrete colours, refreshed on
 * theme change. Surface/line/text tokens flip between themes; the brand/risk
 * grammar colours are the same in both but still read from tokens so there's a
 * single source of truth (no duplicated hexes).
 */
function useChartTheme() {
  const [theme, setTheme] = useState(
    () => (typeof document !== 'undefined'
      ? document.documentElement.getAttribute('data-theme') : null) || 'light',
  );
  useEffect(() => {
    const el = document.documentElement;
    const obs = new MutationObserver(() => setTheme(el.getAttribute('data-theme') || 'light'));
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);
  return useMemo(() => {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, fallback) => (cs.getPropertyValue(n).trim() || fallback);
    return {
      theme,
      text: v('--text', '#1a1a2e'),
      textMuted: v('--text-muted', '#5a6a7a'),
      border: v('--border', '#e0e5ed'),
      cardBg: v('--card-bg', '#ffffff'),
      brand: v('--brand', '#1f3a6e'),
      danger: v('--danger', '#c62828'),
      accent: v('--accent', '#2e7d32'),
      accentOrange: v('--accent-orange', '#e65100'),
    };
  }, [theme]);
}

/**
 * Distinct, on-brand colour per payment mode. Known modes keep the colour
 * grammar (cash exit = danger, etc.); any extra modes (RTGS, wallets…) draw from
 * a derived palette of token blends so every slice stays visually distinct
 * without going rainbow.
 */
function buildPaymentColors(names, c) {
  const known = {
    ATM: c.danger, UPI: c.brand, IMPS: c.accent, NEFT: c.accentOrange, OTHERS: c.textMuted,
  };
  // Four mutually-distinct on-brand blends for modes outside the grammar
  // (teal / plum / light-slate / ember) — kept far apart in hue so no two
  // slices read as the same colour.
  const extras = [
    mixRgb(hexToRgb(c.brand), hexToRgb(c.accent), 0.5),         // teal
    mixRgb(hexToRgb(c.brand), hexToRgb(c.danger), 0.5),         // plum
    mixRgb(hexToRgb(c.brand), [255, 255, 255], 0.5),            // light slate
    mixRgb(hexToRgb(c.danger), hexToRgb(c.accentOrange), 0.5),  // ember
  ];
  const map = {};
  let ei = 0;
  for (const name of names) {
    const key = String(name || '').toUpperCase();
    if (known[key]) map[name] = known[key];
    else { map[name] = extras[ei % extras.length]; ei += 1; }
  }
  return map;
}

/* Consistent line-icon set for the hero stat cards (replaces the mixed emoji).
   Each is a 22px stroke icon coloured to its metric's semantic grammar. */
const SVG_ICON_PROPS = {
  width: 22, height: 22, viewBox: '0 0 24 24', fill: 'none',
  strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
};

function IconBanknote({ color }) {
  return (
    <svg {...SVG_ICON_PROPS} stroke={color}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M6 9.5v5M18 9.5v5" />
    </svg>
  );
}

function IconLayers({ color }) {
  return (
    <svg {...SVG_ICON_PROPS} stroke={color}>
      <polygon points="12 2 2 7 12 12 22 7 12 2" />
      <polyline points="2 17 12 22 22 17" />
      <polyline points="2 12 12 17 22 12" />
    </svg>
  );
}

function IconUsers({ color }) {
  return (
    <svg {...SVG_ICON_PROPS} stroke={color}>
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconShieldCheck({ color }) {
  return (
    <svg {...SVG_ICON_PROPS} stroke={color}>
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
      <polyline points="9 12 12 15 16 10" />
    </svg>
  );
}

/**
 * Value label for the Amount-by-Layer bars, rendered vertically just above each
 * bar. recharts <LabelList> clones this with the bar geometry (x/y/width/value);
 * rotating the text -90° keeps a row of adjacent short-bar labels from colliding
 * (the failure mode of horizontal labels) while every layer's amount stays
 * visible.
 *
 * The theme colour is passed as `themeFill`, NOT `fill`, on purpose: recharts'
 * <LabelList> clones this element and injects its OWN `fill` (the bar/Cell
 * colour) on top, which would override a `fill` prop of ours — so in dark mode
 * the labels rendered in the bar's navy/red instead of the theme text and
 * vanished against the dark card. `themeFill` is not a prop recharts injects,
 * so it survives the clone and the label tracks the theme in both modes.
 */
function VerticalBarLabel({ x, y, width, value, themeFill }) {
  if (value == null || x == null) return null;
  const cx = x + width / 2;
  const ly = y - 5;
  return (
    <text
      x={cx}
      y={ly}
      transform={`rotate(-90 ${cx} ${ly})`}
      textAnchor="start"
      dominantBaseline="central"
      style={{ fontSize: 10.5, fontWeight: 700, fill: themeFill }}
    >
      {formatCrore(value)}
    </text>
  );
}

// Recovery-bucket → colour grammar (cashed out is the worst outcome).
const RECOVERY_COLORS = {
  cashed_out: 'var(--danger)',
  on_hold: 'var(--accent-orange)',
  refunded: 'var(--brand)',
  recoverable: 'var(--accent)',
};

// Roadmap priority → colour (P0 most urgent).
const PRIORITY_COLORS = {
  P0: 'var(--danger)',
  P1: 'var(--accent-orange)',
  P2: 'var(--brand)',
  P3: 'var(--text-muted)',
};

// Identifiers inside the P0–P3 roadmap prose become drill-down doorways
// ("verify before acting"). ONLY the identifier text is clickable — the rest
// of the card stays inert so the planned "Go to Lien Tracker →" style action
// control can later coexist without click-target conflicts. Two token shapes:
//   • "ATM <id>" (the P3 CCTV card) → the atm drill-down;
//   • bare 9–18 digit runs → account numbers (\b keeps digits inside
//     alphanumeric tokens like ack numbers, and 19+ digit runs, from matching).
const IDENTIFIER_TOKEN = /ATM\s+([A-Za-z0-9_-]{4,})|\b\d{9,18}\b/g;

function LinkifyAccounts({ text }) {
  const str = String(text || '');
  const parts = [];
  let last = 0;
  let m;
  IDENTIFIER_TOKEN.lastIndex = 0;
  // eslint-disable-next-line no-cond-assign
  while ((m = IDENTIFIER_TOKEN.exec(str)) !== null) {
    if (m.index > last) parts.push(str.slice(last, m.index));
    if (m[1]) {
      parts.push('ATM ');
      parts.push(
        <EntityLink
          key={m.index}
          type="atm"
          params={{ id: m[1] }}
          label={m[1]}
          title={`Open ATM ${m[1]} details`}
        />,
      );
    } else {
      parts.push(<AccountLink key={m.index} account={m[0]} />);
    }
    last = m.index + m[0].length;
  }
  parts.push(str.slice(last));
  return <>{parts}</>;
}

function findingIcon(text) {
  const t = text.toLowerCase();
  if (/(lien|recommend|priority|action|recover)/.test(t)) return '🎯';
  if (/(₹|cash|amount|exposure|recoverable|victim)/.test(t)) return '💰';
  return '⚠️';
}

// ─── Recovery "fund trail" bar ─────────────────────────────────────────────────

function RecoveryBar({ recovery }) {
  if (!recovery || !recovery.base_amount) return null;
  const segments = [
    { key: 'cashed_out', label: 'Cashed Out', amount: recovery.cashed_out, pct: recovery.cashed_out_pct },
    { key: 'on_hold', label: 'On Hold', amount: recovery.on_hold, pct: recovery.on_hold_pct },
    { key: 'refunded', label: 'Refunded', amount: recovery.refunded, pct: recovery.refunded_pct },
    { key: 'recoverable', label: 'Recoverable', amount: recovery.recoverable, pct: recovery.recoverable_pct },
  ].filter((s) => s.pct > 0);

  return (
    <div className="card card-pad" style={{ marginBottom: 20 }}>
      <h3 style={{ fontSize: 15, marginBottom: 4 }}>Fund Trail — Recovery Status</h3>
      <p className="subtitle" style={{ marginBottom: 14 }}>
        Where the {formatINR(recovery.base_amount)} of victim funds ended up.
      </p>
      <div style={{ display: 'flex', height: 28, borderRadius: 6, overflow: 'hidden', border: '1px solid var(--border)' }}>
        {segments.map((s) => (
          <div
            key={s.key}
            title={`${s.label}: ${formatINR(s.amount)} (${s.pct}%)`}
            style={{
              width: `${s.pct}%`, background: RECOVERY_COLORS[s.key],
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--text-on-solid)', fontSize: 11, fontWeight: 700, minWidth: s.pct > 6 ? 'auto' : 0,
            }}
          >
            {s.pct >= 8 ? `${s.pct}%` : ''}
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, marginTop: 12 }}>
        {segments.map((s) => (
          <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <span style={{ width: 12, height: 12, borderRadius: 3, background: RECOVERY_COLORS[s.key], display: 'inline-block' }} />
            <span style={{ fontWeight: 600 }}>{s.label}</span>
            <span style={{ color: 'var(--text-muted)' }}>{formatINR(s.amount)} ({s.pct}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Data Quality status card (v0.2.0) ────────────────────────────────────────

// Actionable flag → short officer-facing chip label.
const DQ_ACTIONABLE_LABELS = [
  ['INVALID_IFSC', 'Invalid IFSC'],
  ['UNKNOWN_IFSC_PREFIX', 'Unknown IFSC prefix'],
  ['NO_IFSC', 'Bank row missing IFSC'],
];

const DQ_STATUS_COLORS = {
  green: 'var(--accent)',
  amber: 'var(--accent-orange)',
  red: 'var(--danger)',
};

/**
 * Always-visible rigor signal with a freeze-target-scoped severity model:
 *   green — zero actionable flags (auto-corrected mismatches and expected
 *           wallet/cash no-IFSC rows are informational, shown separately).
 *   amber — actionable flags exist, but none on a lien-table account.
 *   red   — an actionable flag falls on a freeze-target account: a lien
 *           letter is about to go to a bank that couldn't be confirmed.
 * Flags are advisory metadata only — they never alter financial totals.
 * Clicking drills into the affected accounts on the Data Quality page.
 */
function DataQualityCard({ analysis, reportId }) {
  let dq = analysis?.data_quality_summary;
  const legacy = !dq || dq.actionable_accounts === undefined;
  if (legacy) {
    // Reports analysed before the severity model: derive a coarse fallback
    // from the row list. Severity can't be reconstructed, so any flag → amber.
    const rows = analysis?.data_quality || [];
    dq = {
      flagged_accounts: rows.length,
      actionable_accounts: rows.length,
      actionable_counts: {},
      informational: { auto_corrected: 0, expected_no_ifsc: 0 },
      freeze_target_total: null,
      freeze_target_flags: null,
      status: rows.length === 0 ? 'green' : 'amber',
    };
  }

  const color = DQ_STATUS_COLORS[dq.status] || DQ_STATUS_COLORS.amber;
  const icon = dq.status === 'green' ? '✅' : dq.status === 'red' ? '⛔' : '🔎';

  let headline;
  let detail;
  if (dq.status === 'green') {
    headline = dq.freeze_target_total
      ? `Data quality: clean — all ${formatNumber(dq.freeze_target_total)} freeze-target banks confirmed from IFSC`
      : 'Data quality: clean — no actionable flags';
    detail = 'Every lien letter targets a bank confirmed from its IFSC.';
  } else if (dq.status === 'red') {
    headline = `${formatNumber(dq.freeze_target_flags)} freeze-target bank(s) could not be confirmed from IFSC — verify before issuing lien letters.`;
    detail = 'These accounts are in the lien table, but their bank rests on unverified source text. Figures are unaffected.';
  } else {
    headline = legacy
      ? `${formatNumber(dq.flagged_accounts)} account(s) need bank verification — figures unaffected.`
      : `${formatNumber(dq.actionable_accounts)} account(s) need bank verification (none are freeze targets) — figures unaffected.`;
    detail = 'No lien-table account is affected; review when convenient.';
  }

  const info = dq.informational || {};
  const infoParts = [];
  if (info.auto_corrected > 0) {
    infoParts.push(`${formatNumber(info.auto_corrected)} bank names auto-corrected from IFSC (source text disagreed)`);
  }
  if (info.expected_no_ifsc > 0) {
    infoParts.push(`${formatNumber(info.expected_no_ifsc)} wallet/cash rows without IFSC (expected)`);
  }

  const chips = DQ_ACTIONABLE_LABELS.filter(([key]) => (dq.actionable_counts?.[key] || 0) > 0);

  // Tint the banner by severity so a warning reads as a warning at a glance —
  // soft, not alarming. Green stays a neutral card; amber/red pick up the
  // matching alert surface (theme-aware tokens, dark-mode safe).
  const tintBg = dq.status === 'red'
    ? 'var(--danger-bg)'
    : dq.status === 'amber'
      ? 'var(--warning-bg)'
      : undefined;

  return (
    <Link
      to={`/data-quality${reportId ? `?reportId=${reportId}` : ''}`}
      className="card card-pad"
      aria-label="Open data quality details"
      style={{
        display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20,
        borderLeft: `4px solid ${color}`,
        background: tintBg,
        textDecoration: 'none', color: 'inherit', cursor: 'pointer',
      }}
    >
      <span style={{ fontSize: 24 }} aria-hidden="true">{icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <strong style={{ color }}>{headline}</strong>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 2 }}>{detail}</div>
        {chips.length > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 }}>
            {chips.map(([key, label]) => (
              <span
                key={key}
                style={{
                  fontSize: 12, fontWeight: 700, padding: '2px 10px', borderRadius: 999,
                  background: 'var(--brand-light)', color: 'var(--text)', border: '1px solid var(--border)',
                }}
              >
                {label}: {formatNumber(dq.actionable_counts[key])}
              </span>
            ))}
          </div>
        )}
        {infoParts.length > 0 && (
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
            ✓ {infoParts.join(' · ')}
          </div>
        )}
      </div>
      <span className="btn btn-sm btn-primary" style={{ flexShrink: 0 }}>
        {dq.status === 'green' ? 'Details →' : 'Review →'}
      </span>
    </Link>
  );
}

// ─── Milestone date card ───────────────────────────────────────────────────────

// `untracked` is for milestones the engine never computes (e.g. refunds, which
// are not captured from the source file). It renders a muted "Not tracked"
// instead of a date, so a blank card never reads as a verified "zero / none"
// data point. A normal missing date (genuinely not detected) still shows "—".
function DateCard({ label, date, icon, color, untracked = false }) {
  return (
    <div className="stat-card" style={{ borderLeftColor: untracked ? 'var(--text-muted)' : color }}>
      <div className="stat-head">
        <span className="stat-title">{label}</span>
        <span className="stat-icon" aria-hidden="true">{icon}</span>
      </div>
      {untracked ? (
        <div className="stat-value" style={{ color: 'var(--text-muted)', fontSize: 15, fontWeight: 600 }}>
          Not tracked
        </div>
      ) : (
        <div className="stat-value" style={{ color, fontSize: 20 }}>{date ? formatDate(date) : '—'}</div>
      )}
    </div>
  );
}

/* Feature 1 — value colour + warning glyph per severity. Colour is NEVER the
   only signal: warn/danger also carry a ⚠ icon and a basis sub-line. The green
   "ok" and neutral "none" states are the calm default and carry no alarm glyph. */
const IM_SEVERITY = {
  ok: { color: 'var(--risk-low)', icon: null },
  warn: { color: 'var(--risk-medium)', icon: '⚠' },
  danger: { color: 'var(--risk-high)', icon: '⚠' },
  none: { color: 'var(--text-muted)', icon: null },
};

/**
 * Feature 1 — "Investigation Metrics" band: three investigation-health/urgency
 * KPIs (response gap, recovery rate, cash-out speed) that answer a different
 * question from the case-size KPIs above. Values + severities are computed once
 * in the backend (analysis.investigation_metrics) and only rendered here.
 */
function InvestigationMetricsBand({ metrics }) {
  if (!metrics) return null;
  const rg = metrics.response_gap || {};
  const rr = metrics.recovery_rate || {};
  const cs = metrics.cashout_speed || {};
  const rgSev = IM_SEVERITY[rg.severity] || IM_SEVERITY.none;
  const rrSev = IM_SEVERITY[rr.severity] || IM_SEVERITY.none;

  const warnIcon = (sev) =>
    (sev.icon ? <span style={{ color: sev.color }} aria-hidden="true">{sev.icon}</span> : undefined);

  const gapValue = rg.days == null ? '—' : `${rg.days} ${rg.days === 1 ? 'day' : 'days'}`;
  const gapSub = rg.days == null
    ? 'No bank action recorded yet'
    : `Fraud ${formatDate(rg.from_date)} → 1st action ${formatDate(rg.to_date)}`;

  const rrValue = rr.pct == null ? '—' : `${rr.pct}%`;
  const rrSub = rr.pct == null
    ? 'No victim loss to measure against'
    : `${formatCrore(rr.secured_amount)} of ${formatCrore(rr.base_amount)} secured`;

  const csValue = cs.median_hours == null ? '—' : formatHours(cs.median_hours);
  const csSub = cs.median_hours == null
    ? 'No cash-out accounts in trail'
    : `Receipt → 1st cash-out · median of ${formatNumber(cs.account_count)} ${cs.account_count === 1 ? 'account' : 'accounts'}`;

  return (
    <div style={{ marginBottom: 20 }}>
      <div className="metrics-band-label">Investigation Metrics</div>
      <div className="grid grid-stats">
        <StatCard
          title="Response Gap"
          value={gapValue}
          subtitle={gapSub}
          color={rgSev.color}
          icon={warnIcon(rgSev)}
          info="How long between the first fraud transfer and the first bank action (funds put on hold). Amber over 7 days, red over 14."
        />
        <StatCard
          title="Recovery Rate"
          value={rrValue}
          subtitle={rrSub}
          color={rrSev.color}
          icon={warnIcon(rrSev)}
          info="Share of the victim loss secured so far — money frozen on hold or refunded, divided by the total loss. Amber under 25%, red at 0%."
        />
        <StatCard
          title="Cash-out Speed"
          value={csValue}
          subtitle={csSub}
          color="var(--brand-text)"
          info="Typical (median) time from money landing in an account to that account pulling it out as cash, measured across every cash-out account in the trail."
        />
      </div>
    </div>
  );
}

export default function Dashboard() {
  const reportId = useActiveReportId();

  const [report, setReport] = useState(null);
  const [paymentSplit, setPaymentSplit] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Export feedback: which button is busy ('pdf' | 'excel' | null), last error,
  // and a transient "Saved to …" success notice.
  const [exporting, setExporting] = useState(null);
  const [exportError, setExportError] = useState(null);
  const [savedNotice, setSavedNotice] = useState(null);

  async function handleExport(kind) {
    setExportError(null);
    setSavedNotice(null);
    setExporting(kind);
    try {
      const suggested = suggestExportName(report, kind === 'pdf' ? 'pdf' : 'excel');
      const result = kind === 'pdf'
        ? await saveReportPdf(report.id, suggested)
        : await saveReportExcel(report.id, suggested);
      // User cancelled the save dialog → do nothing (no file, no error, no notice).
      if (result && result.savedTo) {
        setSavedNotice(`Saved to ${result.savedTo}`);
      }
    } catch (err) {
      setExportError(err);
    } finally {
      setExporting(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    if (!reportId) {
      setError(new ApiError('No report selected.', { code: 'NO_REPORT' }));
      setLoading(false);
      return undefined;
    }

    async function load() {
      try {
        const r = await getReport(reportId);
        if (cancelled) return;
        setReport(r);
        setError(null);
        setLoading(false);

        if (r.analysis_status === 'complete') {
          try {
            // Full distribution over the case's de-duplicated LEDGER ROWS — the
            // endpoint reuses the analyzer's own dedupeRows, so the donut total +
            // percentages reflect the whole case without double-counting re-listed
            // legs. This is a ledger-row count (all row kinds), deliberately
            // distinct from the headline transaction count.
            const pm = await getPaymentModes(reportId);
            if (!cancelled) setPaymentSplit((pm.modes || []).map((m) => ({ mode: m.mode, count: m.count })));
          } catch (_e) { /* pie is non-critical */ }
        } else if (r.analysis_status !== 'error') {
          timer = setTimeout(load, 2000);
        }
      } catch (err) {
        if (!cancelled) { setError(err); setLoading(false); }
      }
    }

    setLoading(true);
    setError(null);
    load();

    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [reportId]);

  const analysis = report?.analysis_json;
  const summary = analysis?.summary;
  const recovery = analysis?.recovery_status;
  const timelineSummary = analysis?.timeline_summary;
  const roadmap = analysis?.investigation_roadmap || [];

  const lienEligibleTotal = useMemo(
    () => (analysis?.lien_calculation || []).reduce((s, l) => s + (l.lien_eligible_amount || 0), 0),
    [analysis],
  );

  // Mule risk split. The analyzer SCORES every account that touched the money
  // (incl. LOW-risk pass-through accounts), so mule_detection.length is the count
  // of accounts scored — NOT the count of mules. The headline must reflect the
  // actual flagged mules, so the card leads with the HIGH-risk count and footnotes
  // the medium/low split. Counted exactly as the Mules page does (by risk_label),
  // so the dashboard's HIGH number always equals the Mules page's "High Risk" card.
  const muleRisk = useMemo(() => {
    const c = { HIGH: 0, MEDIUM: 0, LOW: 0 };
    for (const m of (analysis?.mule_detection || [])) {
      if (c[m.risk_label] !== undefined) c[m.risk_label] += 1;
    }
    return c;
  }, [analysis]);

  const layerChartData = useMemo(
    () => (analysis?.layer_analysis || []).map((l) => ({
      name: `Layer ${l.layer_no}`,
      amount: l.total_amount,
    })),
    [analysis],
  );

  // Payment-mode slices carry their share so the legend, tooltip and centre
  // label all read the same %. The endpoint returns modes already sorted desc,
  // so the legend reads largest-to-smallest. value = ledger-row count (the chart
  // is a distribution of how the case's deduped ledger rows split across payment
  // channels — all row kinds, not just transfers; hence "LEDGER ROWS", a count
  // deliberately distinct from the headline transaction (hop) figure).
  const paymentTotal = useMemo(
    () => paymentSplit.reduce((s, p) => s + (p.count || 0), 0),
    [paymentSplit],
  );
  const paymentChartData = useMemo(
    () => paymentSplit.map((p) => ({
      name: p.mode,
      value: p.count,
      pct: paymentTotal ? +((p.count / paymentTotal) * 100).toFixed(1) : 0,
    })),
    [paymentSplit, paymentTotal],
  );

  // Theme-aware chart colours (re-resolved on theme flip), plus the derived
  // per-bar / per-slice palettes.
  const chart = useChartTheme();
  const layerBarColors = useMemo(() => {
    const max = Math.max(1, ...layerChartData.map((d) => d.amount || 0));
    const lo = hexToRgb(chart.brand);
    const hi = hexToRgb(chart.danger);
    // Higher amount → hotter (toward danger red); the lightest layers stay navy.
    return layerChartData.map((d) => mixRgb(lo, hi, (d.amount || 0) / max));
  }, [layerChartData, chart.brand, chart.danger]);
  const paymentColors = useMemo(
    () => buildPaymentColors(paymentChartData.map((p) => p.name), chart),
    [paymentChartData, chart],
  );

  if (loading) {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Dashboard</h1>
          <p className="subtitle">Loading case overview…</p>
        </header>
        <SkeletonStats count={4} />
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', marginBottom: 20 }}>
          <SkeletonChart />
          <SkeletonChart />
        </div>
        <SkeletonTable rows={5} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="page">
        <header className="page-header"><h1>Dashboard</h1></header>
        <ErrorAlert
          error={error}
          title="Could not load the report"
          message={error.code === 'NO_REPORT'
            ? 'No report is selected. Upload a file or pick one from Previous Reports.'
            : friendlyErrorMessage(error)}
        />
        <div style={{ marginTop: 16 }}>
          <Link className="btn btn-primary" to="/upload">← Go to Upload</Link>
        </div>
      </div>
    );
  }

  if (report.analysis_status === 'error') {
    return (
      <div className="page">
        <header className="page-header"><h1>Dashboard</h1></header>
        <ErrorAlert
          title="Analysis failed for this report"
          message="The background analysis did not complete. Re-upload the file or contact MINT support."
        />
        <div style={{ marginTop: 16 }}>
          <Link className="btn btn-primary" to="/upload">← Go to Upload</Link>
        </div>
      </div>
    );
  }

  if (report.analysis_status !== 'complete') {
    return (
      <div className="page">
        <header className="page-header">
          <h1>Dashboard</h1>
          <p className="subtitle">{report.original_filename}</p>
        </header>
        <LoadingSpinner block label="Analyzing… this report is still being processed. The page refreshes automatically." />
      </div>
    );
  }

  const totalLayers = summary?.total_layers ?? report.total_layers;
  // Headline victim loss = first-hop disputed money. On LEGACY snapshots that
  // predate this field we must NOT fall back to total_disputed_amount: that is
  // the all-layers trail sum (the same rupees re-counted as they traverse hops),
  // so showing it as "Total Fraud" silently inflates the headline. Suppress the
  // figure instead (value renders "—" via formatCrore(null)) and flag that the
  // report needs re-analysis; the trail total is still shown in the subtitle,
  // correctly labelled as trail disputed.
  const hasVictimLoss = summary?.victim_loss_amount != null;
  const victimLoss = hasVictimLoss ? summary.victim_loss_amount : null;
  const trailDisputed = summary?.total_trail_disputed ?? summary?.total_disputed_amount ?? report.total_disputed_amount;
  const uniqueTxns = summary?.unique_transactions ?? report.total_transactions;
  // Exact-duplicate transparency: the count the dedup system already computed
  // (summary.duplicate_count, the same value that drives the dossier's Suspected
  // Duplicates annexure) — never recomputed here. The donut excludes these legs,
  // so we tell the officer how many were collapsed rather than absorbing them
  // silently. Absent on legacy snapshots → 0 → the note simply doesn't render.
  const duplicateCount = summary?.duplicate_count
    ?? analysis?.reconciliation?.transactions?.duplicates
    ?? 0;

  return (
    <div className="page">
      <header className="page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
        <div>
          <h1>Dashboard</h1>
          <p className="subtitle">{report.original_filename} · case overview &amp; recommended actions</p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => handleExport('excel')}
            disabled={exporting !== null}
          >
            {exporting === 'excel' ? '… Exporting' : '⬇ Export Excel'}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-primary"
            onClick={() => handleExport('pdf')}
            disabled={exporting !== null}
          >
            {exporting === 'pdf' ? '… Exporting' : '⬇ Export PDF'}
          </button>
        </div>
      </header>

      {exportError && (
        <div style={{ marginBottom: 16 }}>
          <ErrorAlert
            error={exportError}
            title="Export failed"
            message={friendlyErrorMessage(exportError)}
          />
        </div>
      )}

      {savedNotice && (
        <div role="status" className="save-notice">
          ✓ {savedNotice}
        </div>
      )}

      {/* Data Quality status card (v0.2.0) — always visible near the top as a
          rigor signal: green = every bank attribution verified from its IFSC,
          amber = some accounts need IO review, red = pervasively poor source
          data. Advisory only — flags never alter financial totals. Clicking
          drills into the affected accounts. */}
      <DataQualityCard analysis={analysis} reportId={reportId} />

      {/* Row 1 — headline metrics (Victim Loss is the actual loss; Trail Disputed re-counts the same money across hops). */}
      <div className="metrics-band-label">Case Summary</div>
      <div className="grid grid-stats" style={{ marginBottom: 20 }}>
        <StatCard
          title="Victim Loss (Total Fraud)"
          value={formatCrore(victimLoss)}
          subtitle={hasVictimLoss
            ? `Trail disputed ${formatCrore(trailDisputed)} · ${formatNumber(uniqueTxns)} transactions`
            : `Requires re-analysis to compute · Trail disputed ${formatCrore(trailDisputed)} · ${formatNumber(uniqueTxns)} transactions`}
          icon={<IconBanknote color="var(--danger)" />}
          color="var(--danger)"
        />
        <StatCard title="Layers in Trail" value={totalLayers} subtitle="laundering hops" icon={<IconLayers color="var(--brand)" />} color="var(--brand)" />
        <StatCard
          title="Mule Accounts"
          value={formatNumber(muleRisk.HIGH)}
          subtitle={`high-risk · ${formatNumber(muleRisk.MEDIUM)} medium · ${formatNumber(muleRisk.LOW)} low`}
          icon={<IconUsers color="var(--accent-orange)" />}
          color="var(--accent-orange)"
        />
        {/* Subtitle deliberately avoids the word "recoverable": this is the Σ
            per-account lien-eligible (freezable) balance, which re-counts money
            across layers and can exceed the loss — distinct from the Fund Trail
            "Recoverable" residual below. Only that residual is labelled recoverable. */}
        <StatCard
          title="Lien Eligible"
          value={formatCrore(lienEligibleTotal)}
          subtitle={`freezable balance · ${formatNumber(analysis?.lien_calculation?.length || 0)} accounts`}
          icon={<IconShieldCheck color="var(--accent)" />}
          color="var(--accent)"
        />
      </div>

      {/* Feature 1 — Investigation Metrics band (below Case Summary, above the fold). */}
      <InvestigationMetricsBand metrics={analysis?.investigation_metrics} />

      {/* Recovery / fund-trail bar */}
      <RecoveryBar recovery={recovery} />

      {/* Milestone dates */}
      {timelineSummary && (
        <div className="grid grid-stats" style={{ marginBottom: 20 }}>
          <DateCard label="First Fraud" date={timelineSummary.first_fraud_date} icon="🚨" color="var(--danger)" />
          <DateCard label="First Cashout" date={timelineSummary.first_cashout_date} icon="🏧" color="var(--accent-orange)" />
          <DateCard label="First Bank Action" date={timelineSummary.first_bank_action_date} icon="🏦" color="var(--brand)" />
          {/* Refunds aren't computed from the NCRP source, so this is never a
              verified "no refund" — show "Not tracked" rather than a bare dash. */}
          <DateCard label="First Refund" untracked icon="↩️" color="var(--accent)" />
        </div>
      )}

      {/* Row 2 — charts */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', marginBottom: 20 }}>
        <div className="card card-pad">
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Amount by Layer</h3>
          <ResponsiveContainer width="100%" height={280}>
            <BarChart data={layerChartData} margin={{ top: 24, right: 8, left: 8, bottom: 4 }}>
              <CartesianGrid vertical={false} stroke={chart.border} strokeDasharray="3 3" />
              <XAxis
                dataKey="name"
                tick={{ fontSize: 12, fill: chart.textMuted }}
                axisLine={{ stroke: chart.border }}
                tickLine={{ stroke: chart.border }}
              />
              <YAxis
                tickFormatter={(v) => formatCrore(v)}
                tick={{ fontSize: 12, fill: chart.textMuted }}
                width={64}
                axisLine={{ stroke: chart.border }}
                tickLine={{ stroke: chart.border }}
                /* Headroom above the tallest bar so its vertical value label
                   has room and isn't clipped at the top edge. */
                domain={[0, (dataMax) => Math.ceil(dataMax * 1.3)]}
              />
              <Tooltip
                formatter={(v) => formatINR(v)}
                cursor={{ fill: chart.text, fillOpacity: 0.06 }}
                contentStyle={{ background: chart.cardBg, border: `1px solid ${chart.border}`, borderRadius: 8, color: chart.text }}
                labelStyle={{ color: chart.text }}
                itemStyle={{ color: chart.text }}
              />
              <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                {/* Every bar gets its value, rendered VERTICALLY just above the
                    bar. Rotating the labels uses the empty vertical headroom and
                    removes the horizontal collisions that plagued the cluster of
                    short layers — a row of compact ₹ figures would overlap, thin
                    vertical strips never do. */}
                <LabelList dataKey="amount" content={<VerticalBarLabel themeFill={chart.text} />} />
                {layerChartData.map((_, i) => (
                  <Cell key={i} fill={layerBarColors[i]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="card card-pad">
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Payment Mode Distribution</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie
                data={paymentChartData}
                dataKey="value"
                nameKey="name"
                cx="50%"
                cy="50%"
                innerRadius={52}
                outerRadius={92}
                paddingAngle={1}
                stroke={chart.cardBg}
                strokeWidth={1}
              >
                {paymentChartData.map((entry, i) => (
                  <Cell key={i} fill={paymentColors[entry.name] || chart.textMuted} />
                ))}
                {/* Use the empty donut hole for the running total. */}
                <Label
                  position="center"
                  content={({ viewBox }) => {
                    if (!viewBox || viewBox.cx == null) return null;
                    const { cx, cy } = viewBox;
                    return (
                      <g>
                        <text x={cx} y={cy - 8} textAnchor="middle" dominantBaseline="central"
                          style={{ fontSize: 22, fontWeight: 800, fill: chart.text }}>
                          {formatNumber(paymentTotal)}
                        </text>
                        <text x={cx} y={cy + 14} textAnchor="middle" dominantBaseline="central"
                          style={{ fontSize: 10.5, fontWeight: 600, fill: chart.textMuted, letterSpacing: '0.06em' }}>
                          LEDGER ROWS
                        </text>
                      </g>
                    );
                  }}
                />
              </Pie>
              <Tooltip
                formatter={(v, n) => {
                  const pct = paymentTotal ? ((v / paymentTotal) * 100).toFixed(1) : '0';
                  return [`${formatNumber(v)} rows (${pct}%)`, n];
                }}
                contentStyle={{ background: chart.cardBg, border: `1px solid ${chart.border}`, borderRadius: 8, color: chart.text }}
                labelStyle={{ color: chart.text }}
                itemStyle={{ color: chart.text }}
              />
              <Legend
                wrapperStyle={{ fontSize: 12 }}
                formatter={(value) => {
                  const d = paymentChartData.find((x) => x.name === value);
                  return (
                    <span style={{ color: chart.text }}>
                      {value}
                      {d ? <span style={{ color: chart.textMuted }}>{`  ${formatNumber(d.value)} (${d.pct}%)`}</span> : ''}
                    </span>
                  );
                }}
              />
            </PieChart>
          </ResponsiveContainer>
          {/* Duplicate-transparency note (Finding #2). Informational, never
              alarming: the dedup system already collapsed these re-listed legs
              (summary.duplicate_count), and the donut excludes them — so we say
              how many were set aside rather than absorbing them silently. Hidden
              when none were found (count 0 / legacy snapshot). */}
          {duplicateCount > 0 && (
            <p style={{ marginTop: 8, marginBottom: 0, fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.45 }}>
              {formatNumber(paymentTotal)} de-duplicated ledger rows shown ·{' '}
              {formatNumber(duplicateCount)} exact duplicate{duplicateCount === 1 ? '' : 's'} excluded —
              {' '}identical legs re-listed across NCRP sheets, collapsed before counting
              {' '}(itemised in the exported dossier).
            </p>
          )}
        </div>
      </div>

      {/* Investigation roadmap */}
      {roadmap.length > 0 && (
        <div className="card card-pad" style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 15, marginBottom: 12 }}>Investigation Roadmap</h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {roadmap.map((item, i) => (
              <div
                key={i}
                style={{
                  display: 'flex', gap: 12, alignItems: 'flex-start',
                  padding: '12px 14px', border: '1px solid var(--border)', borderRadius: 'var(--radius)',
                  borderLeft: `4px solid ${PRIORITY_COLORS[item.priority] || 'var(--text-muted)'}`,
                }}
              >
                <span style={{
                  flexShrink: 0, fontWeight: 800, fontSize: 12, color: 'var(--text-on-solid)',
                  background: PRIORITY_COLORS[item.priority] || 'var(--text-muted)',
                  borderRadius: 4, padding: '2px 8px',
                }}>{item.priority}</span>
                <div>
                  <div style={{ fontWeight: 700 }}>{item.title}</div>
                  <div style={{ color: 'var(--text-muted)', fontSize: 13, marginTop: 2 }}>
                    <LinkifyAccounts text={item.description} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Key findings */}
      <div className="card card-pad" style={{ marginBottom: 20 }}>
        <h3 style={{ fontSize: 15, marginBottom: 12 }}>Key Findings &amp; Recommended Actions</h3>
        {(analysis?.key_findings || []).length === 0 ? (
          <div className="empty-state">No findings generated for this report.</div>
        ) : (
          <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 10 }}>
            {analysis.key_findings.map((finding, i) => (
              <li key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
                <span style={{ fontSize: 16, lineHeight: 1.4 }} aria-hidden="true">{findingIcon(finding)}</span>
                <span>{finding}</span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Top cashout locations */}
      <div className="card card-pad">
        <h3 style={{ fontSize: 15, marginBottom: 4 }}>Top Cashout Locations</h3>
        {/* Reconciliation note (Finding #5): this table lists GROSS withdrawal
            legs (full ATM/POS amounts at each terminal), whereas the Fund Trail
            "Cashed Out" figure above is the disputed-attributable (capped) share.
            Both are correct; the table total reads higher. Explained here so the
            difference is never a silent contradiction. */}
        <p className="subtitle" style={{ marginTop: 0, marginBottom: 12 }}>
          Gross withdrawal legs (full ATM/POS amounts per terminal). The Fund Trail
          {' '}&ldquo;Cashed Out&rdquo; total above is the disputed-attributable (capped)
          {' '}figure, so it reads lower than the sum of this table.
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>ATM ID</th>
                <th>Location</th>
                <th>State</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
                <th style={{ textAlign: 'right' }}>Withdrawals</th>
              </tr>
            </thead>
            <tbody>
              {(analysis?.cashout_analysis?.atm_cashouts || []).length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <div className="empty-state">No ATM or POS cashouts were detected in this trail — funds may still be sitting in beneficiary accounts (check the Lien Tracker).</div>
                  </td>
                </tr>
              ) : (
                (analysis?.cashout_analysis?.atm_cashouts || []).map((a) => (
                  <tr key={a.atm_id}>
                    <td style={{ fontFamily: 'var(--font-mono)' }}>
                      {a.atm_id
                        ? <EntityLink type="atm" params={{ id: a.atm_id }} label={a.atm_id} title={`Open ATM ${a.atm_id} details`} />
                        : '—'}
                    </td>
                    <td>{a.atm_location || '—'}</td>
                    <td>{a.state || '—'}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatINR(a.amount)}</td>
                    <td style={{ textAlign: 'right' }}>{formatNumber(a.count)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
