// The last page the viewer had open, so launching the app (which opens `/`) returns there.
// Choosing All projects during a visit stays there. Only this app's own routes are stored.
import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router';

const PAGE_KEY = 'pm-last-page';
const GATE_KEY = 'pm-last-page-gate';

const TABS = new Set(['board', 'agents', 'pull-requests']);
const SHOWS = new Set(['planned', 'active']);

/** A same-app path, or null when the value is not one of ours. Query keys we don't use are dropped. */
export function sanitizeLastPage(value: string | null): string | null {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return null;
  let url: URL;
  try {
    url = new URL(value, 'http://pm.local');
  } catch {
    return null;
  }
  if (url.origin !== 'http://pm.local') return null;

  const keep = new URLSearchParams();
  const project = /^\/projects\/(\d+)$/.exec(url.pathname);
  if (project) {
    const tab = url.searchParams.get('tab');
    if (tab && TABS.has(tab)) keep.set('tab', tab);
  } else if (url.pathname === '/board') {
    const show = url.searchParams.get('show');
    if (show && SHOWS.has(show)) keep.set('show', show);
    const id = url.searchParams.get('project');
    if (id && /^\d+$/.test(id)) keep.set('project', id);
  } else if (url.pathname === '/workspace') {
    const open = url.searchParams.get('open');
    if (open && /^\d+$/.test(open)) keep.set('open', open);
  } else if (url.pathname !== '/' && url.pathname !== '/settings') {
    return null;
  }

  const search = keep.toString();
  return url.pathname + (search ? `?${search}` : '');
}

export function readLastPage(): string | null {
  try {
    return sanitizeLastPage(localStorage.getItem(PAGE_KEY));
  } catch {
    return null;
  }
}

export function saveLastPage(path: string): void {
  const clean = sanitizeLastPage(path);
  if (!clean) return;
  try {
    localStorage.setItem(PAGE_KEY, clean);
  } catch {
    // Remembering the page is a convenience only.
  }
}

/**
 * Records the current page, and on the first load of a tab that opened at `/`, replaces it
 * with the remembered page. Later visits to All projects in that tab are left alone.
 */
export function RememberLastPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const current = location.pathname + location.search;

  useEffect(() => {
    let gate: string | null;
    try {
      gate = sessionStorage.getItem(GATE_KEY);
    } catch {
      saveLastPage(current);
      return;
    }

    // The replace back from `/` has not landed yet. Don't record the launcher URL over the real page.
    if (gate === 'restoring') {
      if (current === '/') return;
      try {
        sessionStorage.setItem(GATE_KEY, 'done');
      } catch {
        // The page is already the remembered one.
      }
      saveLastPage(current);
      return;
    }

    if (gate !== 'done') {
      const saved = readLastPage();
      if (current === '/' && saved && saved !== '/') {
        try {
          sessionStorage.setItem(GATE_KEY, 'restoring');
        } catch {
          // Still return there for this load.
        }
        navigate(saved, { replace: true });
        return;
      }
      try {
        sessionStorage.setItem(GATE_KEY, 'done');
      } catch {
        // Recording still works without the once-per-tab gate.
      }
    }

    saveLastPage(current);
  }, [current, navigate]);

  return null;
}
