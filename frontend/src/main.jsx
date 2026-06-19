import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { initTheme } from './utils/theme.js';
import './index.css';

// Apply the saved light/dark theme before the first render so there is no
// flash of the wrong theme on startup.
initTheme();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
