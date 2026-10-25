import { NavLink, useLocation } from 'react-router';
import { BoardIcon, FoldersIcon, GridIcon, SettingsIcon, TerminalIcon } from './icons';
import { sectionHref } from '../sectionMemory';

/**
 * Bottom tab bar for phone widths (DESIGN.md §2, KDP's 65px mobile bar). CSS hides it above the
 * phone breakpoint, where the top bar and sidebar carry navigation. "Projects" opens the
 * tracked-project list as a full-screen panel instead of a route, so the list keeps its filter,
 * sort and scroll position between visits.
 */
export function MobileTabBar({
  projectsOpen,
  onToggleProjects,
}: {
  projectsOpen: boolean;
  onToggleProjects: () => void;
}) {
  const { pathname } = useLocation();
  const onProject = pathname.startsWith('/projects/');
  // Orchestrators and Preview live under Agents on phones, reached from its tools menu.
  const onAgentsTools = pathname.startsWith('/orchestrators') || pathname.startsWith('/preview');
  // While the project panel covers the page, it is the active tab, not the route underneath.
  const routeClass = ({ isActive }: { isActive: boolean }) =>
    isActive && !projectsOpen ? 'is-active' : '';
  return (
    <nav className="tabbar" aria-label="Primary">
      <NavLink to="/" end className={routeClass}>
        <GridIcon size={20} />
        <span>Home</span>
      </NavLink>
      <button
        type="button"
        className={projectsOpen || onProject ? 'is-active' : ''}
        aria-expanded={projectsOpen}
        aria-controls="project-panel"
        onClick={onToggleProjects}
      >
        <FoldersIcon size={20} />
        <span>Projects</span>
      </button>
      <NavLink to={sectionHref('/board')} className={routeClass}>
        <BoardIcon size={20} />
        <span>Board</span>
      </NavLink>
      <NavLink
        to={sectionHref('/workspace')}
        // Orchestrators live under Agents on phones (reached from its tools menu, PM-71).
        className={({ isActive }) => routeClass({ isActive: isActive || onAgentsTools })}
      >
        <TerminalIcon size={20} />
        <span>Agents</span>
      </NavLink>
      <NavLink to={sectionHref('/settings')} className={routeClass}>
        <SettingsIcon size={20} />
        <span>Settings</span>
      </NavLink>
    </nav>
  );
}
