import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import './styles.css';
import { syncThemeColor } from './theme';

// index.html set the theme before paint; now that the tokens are loaded, match the browser chrome.
syncThemeColor();

// A remembered device skips the sign-in page when scanning the host QR again.
// Remove the short-lived pairing code from its address/history in that case too.
if (new URLSearchParams(location.hash.slice(1)).has('pair')) {
  history.replaceState(null, '', location.pathname + location.search);
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
