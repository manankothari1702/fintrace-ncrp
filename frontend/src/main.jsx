import React from 'react';
import ReactDOM from 'react-dom/client';
import AppRoot from './shell/AppRoot.jsx';
import { AuthProvider } from './context/AuthContext.jsx';
import AuthGate from './auth/AuthGate.jsx';
import AuthBar from './auth/AuthBar.jsx';
import { initTheme } from './utils/theme.js';
import './index.css';

// Apply the saved light/dark theme before the first render so there is no
// flash of the wrong theme on startup.
initTheme();

// AppRoot is the top-level shell that hosts one workspace module at a time
// (NCRP report / Bank statements). Phase 1: the whole app is gated behind
// authentication — AuthGate wraps AppRoot from OUTSIDE (here in the bootstrap),
// so the off-limits shell module (src/shell) is never modified. Unauthenticated
// users see only the login screen; a forced-password-change user sees only that.
//
// The profile control (AuthBar) is handed to the shell as a slot so it renders
// inside the single top bar (next to the workspace toggle) rather than as a
// separate strip. It is created here, under the AuthProvider, and only mounts
// once AuthGate renders its children (i.e. after a successful login).
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <AuthGate>
        <AppRoot profileSlot={<AuthBar />} />
      </AuthGate>
    </AuthProvider>
  </React.StrictMode>,
);
