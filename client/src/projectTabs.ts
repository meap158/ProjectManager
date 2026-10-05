// The project page tab (Overview / Board / Agents) is remembered per browser, so switching projects
// keeps the section you were in: links to a project open it on the current tab.
import { useLocation } from 'react-router';

export type ProjectTab = 'overview' | 'board' | 'agents' | 'pull-requests';

const KEY = 'pm-project-tab';

export function parseProjectTab(value: string | null): ProjectTab {
  return value === 'board' || value === 'agents' || value === 'pull-requests' ? value : 'overview';
}

export function rememberProjectTab(tab: ProjectTab): void {
  try {
    if (tab === 'overview') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, tab);
  } catch {
    // Per-browser convenience only.
  }
}

function rememberedProjectTab(): ProjectTab {
  try {
    return parseProjectTab(localStorage.getItem(KEY));
  } catch {
    return 'overview';
  }
}

export function projectHref(id: number, tab: ProjectTab): string {
  return tab === 'overview' ? `/projects/${id}` : `/projects/${id}?tab=${tab}`;
}

/**
 * Builds project links on the tab the viewer is in: the current page's tab when on a project
 * (re-renders on every tab change), else the last remembered one.
 */
export function useProjectHref(): (id: number) => string {
  const { pathname, search } = useLocation();
  const tab = pathname.startsWith('/projects/')
    ? parseProjectTab(new URLSearchParams(search).get('tab'))
    : rememberedProjectTab();
  return (id) => projectHref(id, tab);
}
