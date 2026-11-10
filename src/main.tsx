import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { applyTheme, parseTheme, PREF_KEYS, readRaw } from './lib/prefs';

applyTheme(parseTheme(readRaw(PREF_KEYS.theme)));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
