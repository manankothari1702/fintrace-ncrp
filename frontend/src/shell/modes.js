/**
 * Top-level application modules.
 *
 * This is the single source of truth for the app-shell mode toggle. It is a
 * plain data array on purpose: the segmented control (SegmentedControl.jsx) is
 * fully generic over this list, and AppRoot maps each `id` to a module
 * component. Adding a future third mode (e.g. a "Combined" cross-analysis view)
 * is therefore a two-line change — append an entry here and register its
 * component in AppRoot's MODULE_COMPONENTS map — with no changes to the toggle
 * component itself.
 *
 * `id` also seeds the initial active module and is persisted to localStorage so
 * the chosen workspace survives a restart of the air-gapped Electron app.
 */

export const MODES = [
  { id: 'ncrp', label: 'NCRP report', icon: '🛡️' },
  { id: 'bankStatement', label: 'Bank statements', icon: '🏦' },
  // Future: { id: 'combined', label: 'Combined', icon: '🔗' },
];

/** The mode shown on first launch when nothing is persisted. */
export const DEFAULT_MODE_ID = MODES[0].id;
