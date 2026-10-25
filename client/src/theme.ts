// Light / dark theme. The stylesheet only knows `data-theme="light" | "dark"` on <html>; this module
// (and the inline script in index.html, which applies it before first paint so there is no flash)
// resolves the viewer's choice, including "system", which follows the OS setting live.

export type ThemePreference = 'system' | 'light' | 'dark';
/** Dispatched on window after the resolved theme is applied, for content that can't follow CSS
 * (a framed page's colours and scrollbars). */
export const THEME_EVENT = 'pm-theme';

const KEY = 'pm-theme';
const media = () => window.matchMedia('(prefers-color-scheme: dark)');

export function readThemePreference(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'light' || value === 'dark' ? value : 'system';
  } catch {
    return 'system';
  }
}

export function applyTheme(preference: ThemePreference): void {
  const dark = preference === 'dark' || (preference === 'system' && media().matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  syncThemeColor();
  rememberPreviewTheme(dark);
  window.dispatchEvent(new Event(THEME_EVENT));
}

/**
 * Lets the preview proxy dark-theme a framed page's scrollbars: a framed page's scrollbar is the
 * page's own, and only the server can reach it. A same-site cookie scoped to the proxy's path; the
 * proxy never forwards cookies to the previewed app.
 */
function rememberPreviewTheme(dark: boolean): void {
  try {
    const secure = location.protocol === 'https:' ? '; Secure' : '';
    document.cookie = `pm-preview-theme=${dark ? 'dark' : 'light'}; Path=/api/preview; SameSite=Strict; Max-Age=31536000${secure}`;
  } catch {
    // Cookies blocked: the scrollbars simply stay the page's own.
  }
}

/**
 * Tint the mobile browser's own chrome (address bar, status bar) to the top bar's surface.
 * The meta tag needs a literal colour, so it is read from the active token.
 */
export function syncThemeColor(): void {
  const surface = getComputedStyle(document.documentElement).getPropertyValue('--surface').trim();
  if (!surface) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = surface;
}

export function setThemePreference(preference: ThemePreference): void {
  try {
    if (preference === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, preference);
  } catch {
    // A per-browser convenience: the theme still applies for this visit.
  }
  applyTheme(preference);
}

/** Keep "system" in sync when the OS switches between light and dark. Returns an unsubscribe. */
export function followSystemTheme(getPreference: () => ThemePreference): () => void {
  const query = media();
  const onChange = () => {
    if (getPreference() === 'system') applyTheme('system');
  };
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}
