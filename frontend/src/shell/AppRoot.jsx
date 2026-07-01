/**
 * Application root — the top-level shell that hosts one workspace module at a
 * time.
 *
 * This layer is intentionally *above* both feature modules and owns the only
 * piece of cross-module state: which module is active. A slim top bar carries
 * the master brand plus a segmented mode toggle; the module chosen there is
 * rendered whole into the body below it.
 *
 * Isolation contract:
 *   • The existing NCRP app (App.jsx) is rendered as an opaque black box — it
 *     is imported and mounted unchanged, never wrapped into or reached inside.
 *     It keeps its own HashRouter, ReportProvider, sidebar and routes.
 *   • The Bank Statement module (modules/bankStatement) is fully self-contained
 *     with its own MemoryRouter, so the two modules never contend for the URL
 *     hash. Only one module is mounted at any time (the other unmounts on
 *     toggle), which also keeps their routers from ever coexisting.
 *
 * The active module id persists to localStorage so the chosen workspace
 * survives a restart of the air-gapped desktop app.
 */

import { useCallback, useState } from 'react';

import App from '../App.jsx';
import BankStatementApp from '../modules/bankStatement/BankStatementApp.jsx';
import SegmentedControl from './SegmentedControl.jsx';
import { MODES, DEFAULT_MODE_ID } from './modes.js';
import './shell.css';

const STORAGE_KEY = 'fintrace-active-module';

// id → module component. Kept here (not in modes.js) so the mode list stays a
// pure data array. Add a future mode's component here alongside its MODES entry.
const MODULE_COMPONENTS = {
  ncrp: App,
  bankStatement: BankStatementApp,
};

function readStoredMode() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && MODES.some((m) => m.id === saved)) return saved;
  } catch (_e) {
    /* storage unavailable — fall through to the default */
  }
  return DEFAULT_MODE_ID;
}

export default function AppRoot() {
  const [activeModule, setActiveModule] = useState(readStoredMode);

  const changeModule = useCallback((id) => {
    setActiveModule(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch (_e) {
      /* storage unavailable — choice still applies for this session */
    }
  }, []);

  // Resolve to a component (fall back to the default if an unknown id ever
  // slips through). Rendering the component lazily by reference — rather than
  // instantiating every module up front — guarantees the inactive module is
  // fully unmounted.
  const ActiveModule = MODULE_COMPONENTS[activeModule] || MODULE_COMPONENTS[DEFAULT_MODE_ID];

  return (
    <div className="fx-root">
      <header className="fx-topbar">
        <div className="fx-brand">
          <span className="fx-brand-mark" aria-hidden="true">🛡️</span>
          <span className="fx-brand-name">FinTrace</span>
        </div>
        <SegmentedControl
          options={MODES}
          value={activeModule}
          onChange={changeModule}
          ariaLabel="Workspace"
        />
      </header>

      {/*
        Each module renders its own full shell (sidebar + routed pages) inside
        this scroll container. `key` forces a clean remount on toggle so a
        switched-away module never leaves stale subscriptions behind.
      */}
      <div className="fx-body">
        <ActiveModule key={activeModule} />
      </div>
    </div>
  );
}
