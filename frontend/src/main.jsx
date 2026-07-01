import React from 'react';
import ReactDOM from 'react-dom/client';
import AppRoot from './shell/AppRoot.jsx';
import { initTheme } from './utils/theme.js';
import './index.css';

// Apply the saved light/dark theme before the first render so there is no
// flash of the wrong theme on startup.
initTheme();

// AppRoot is the top-level shell that hosts one workspace module at a time
// (NCRP report / Bank statements). The NCRP app (App.jsx) is mounted unchanged
// inside it — this is the only edit to the original bootstrap.
ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AppRoot />
  </React.StrictMode>,
);
