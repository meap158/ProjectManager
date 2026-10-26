// Coming back to a section returns to the same place (PM-72): the top bar and the phone tab bar
// link each section to the address last open in it (e.g. Board filtered to one project), and every
// address keeps its scroll position. Kept per browser tab (sessionStorage), like a browser's own
// back/forward memory; the Agents page also remembers its open terminal (WorkspacePage).
import { useEffect, useLayoutEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { lastPageRestorePending, sanitizeLastPage } from './lastPage';

const PATHS_KEY = 'pm-section-paths';
const SCROLL_KEY = 'pm-section-scroll';
const HOME_KEY = 'pm-home-selection';

/** Project details and the portfolio belong to Home. */
export function sectionOf(pathname: string): string | null {
  if (pathname === '/' || /^\/projects\/[1-9]\d*$/.test(pathname)) return '/';
  for (const section of ['/board', '/workspace', '/preview', '/orchestrators', '/settings']) {
    if (pathname === section || pathname.startsWith(`${section}/`)) return section;
  }
  return null;
}

function read(key: string): Record<string, string | number> {
  try {
    const value = JSON.parse(sessionStorage.getItem(key) ?? '{}') as unknown;
    return value && typeof value === 'object' ? (value as Record<string, string | number>) : {};
  } catch {
    return {};
  }
}

function write(key: string, value: Record<string, string | number>): void {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or full storage: the app just starts sections fresh.
  }
}

/** Where a nav link to `section` should go: the address last open there, else the section. */
export function sectionHref(section: string): string {
  if (section === '/') {
    try {
      const home = sanitizeLastPage(localStorage.getItem(HOME_KEY));
      if (home && sectionOf(home.split('?')[0]!) === '/') return home;
    } catch {
      // Fall back to this tab's selection when persistent storage is unavailable.
    }
  }
  const saved = read(PATHS_KEY)[section];
  return typeof saved === 'string' && sectionOf(saved.split('?')[0]!) === section ? saved : section;
}

/** Explicit Home URLs win immediately, including browser back/forward and direct links. */
export function useHomeHref(): string {
  const { pathname, search } = useLocation();
  // A project's Board tab counts as Board: Home goes to the project itself.
  if (projectBoardId(pathname, search) !== null) return pathname;
  return sectionOf(pathname) === '/' ? pathname + search : sectionHref('/');
}

/**
 * A project's Board tab (/projects/N?tab=board) belongs to Board in the navigation: the Board menu
 * is highlighted there, not Home (owner, PM-307). The project's id, else null.
 */
export function projectBoardId(pathname: string, search: string): number | null {
  const match = /^\/projects\/([1-9]\d*)$/.exec(pathname);
  return match && new URLSearchParams(search).get('tab') === 'board' ? Number(match[1]) : null;
}

/** The every-project board, as Board was last left but without a project filter or open card. */
export function allProjectsBoardHref(): string {
  const [path, query = ''] = sectionHref('/board').split('?');
  const params = new URLSearchParams(query);
  params.delete('project');
  params.delete('card');
  const rest = params.toString();
  return `${path}${rest ? `?${rest}` : ''}`;
}

/** The scrolling page area (the sidebar and nav stay put; see .app-main in styles.css). */
const scroller = () => document.querySelector<HTMLElement>('.app-main');

/**
 * Records each section's last address and every address's scroll position, and restores the
 * scroll position when an address is shown again (retrying briefly while its data loads).
 */
export function useSectionMemory(): void {
  const { pathname, search } = useLocation();
  const path = pathname + search;
  const current = useRef(path);

  // Keep the scroll position of the page being shown, up to date as it scrolls.
  useEffect(() => {
    const el = scroller();
    if (!el) return;
    const save = () => write(SCROLL_KEY, { ...read(SCROLL_KEY), [current.current]: el.scrollTop });
    el.addEventListener('scroll', save, { passive: true });
    return () => el.removeEventListener('scroll', save);
  }, []);

  useLayoutEffect(() => {
    current.current = path;
    const section = sectionOf(pathname);
    if (section) write(PATHS_KEY, { ...read(PATHS_KEY), [section]: path });
    if (section === '/' && !(pathname === '/' && lastPageRestorePending())) {
      try {
        // From a project's Board tab Home remembers the project, not the board (that is Board's).
        const home = projectBoardId(pathname, search) !== null ? pathname : path;
        localStorage.setItem(HOME_KEY, sanitizeLastPage(home) ?? '/');
      } catch {
        // The current selection still works without persistent storage.
      }
    }
    const target = read(SCROLL_KEY)[path];
    const el = scroller();
    if (!el) return;
    if (typeof target !== 'number' || target <= 0) {
      el.scrollTop = 0;
      return;
    }
    // Content arrives asynchronously: keep trying for up to 3 s until the page is tall enough.
    let frame = 0;
    const started = performance.now();
    const restore = () => {
      el.scrollTop = target;
      if (Math.abs(el.scrollTop - target) > 2 && performance.now() - started < 3000) {
        frame = requestAnimationFrame(restore);
      }
    };
    restore();
    return () => cancelAnimationFrame(frame);
  }, [path, pathname, search]);
}
