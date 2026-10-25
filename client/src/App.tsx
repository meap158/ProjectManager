import { lazy, Suspense, useEffect } from 'react';
import { Link, NavLink, Route, Routes, useLocation } from 'react-router';
import { InboxButton } from './components/InboxButton';
import { MobileTabBar } from './components/MobileTabBar';
import { sectionHref, useSectionMemory } from './sectionMemory';
import { ProjectSidebar } from './components/ProjectSidebar';
import { ThemeSwitch } from './components/ThemeSwitch';
import { BoardIcon, GridIcon, MonitorIcon, SettingsIcon, TerminalIcon } from './components/icons';
import { RememberLastPage } from './lastPage';
import { useProjectPanel } from './projectPanel';
import { installShortcuts, loadShortcuts } from './shortcuts';

const ProjectsPage = lazy(() =>
  import('./pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })),
);
const ProjectPage = lazy(() =>
  import('./pages/ProjectPage').then((m) => ({ default: m.ProjectPage })),
);
const BoardPage = lazy(() => import('./pages/BoardPage').then((m) => ({ default: m.BoardPage })));
const WorkspacePage = lazy(() =>
  import('./pages/WorkspacePage').then((m) => ({ default: m.WorkspacePage })),
);
const OrchestratorPage = lazy(() =>
  import('./pages/OrchestratorPage').then((m) => ({ default: m.OrchestratorPage })),
);
const PreviewPage = lazy(() =>
  import('./pages/PreviewPage').then((m) => ({ default: m.PreviewPage })),
);
const SettingsPage = lazy(() =>
  import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
);

export function App() {
  // The agent workspace takes the full width: terminals need the screen space more than the list.
  const fullWidth = ['/workspace', '/orchestrators'].includes(useLocation().pathname);
  // Phone widths: the project list is a full-screen panel opened from the bottom tab bar.
  const projects = useProjectPanel();
  // Each section reopens where it was left, scroll position included (PM-72).
  useSectionMemory();
  // Keyboard shortcuts (Settings > Keyboard shortcuts) work on every page (PM-244).
  useEffect(() => {
    installShortcuts();
    loadShortcuts();
  }, []);
  return (
    <>
      <RememberLastPage />
      <header className="topbar">
        <Link to="/" className="brand" aria-label="ProjectManager">
          <img src="/favicon.svg" alt="" />
          <span>ProjectManager</span>
        </Link>
        <nav className="topnav" aria-label="Primary">
          <NavLink
            to="/"
            end
            aria-label="All projects"
            className={({ isActive }) => (isActive ? 'is-active' : '')}
          >
            <GridIcon />
            <span>All projects</span>
          </NavLink>
          <NavLink
            to={sectionHref('/board')}
            aria-label="Board"
            className={({ isActive }) => (isActive ? 'is-active' : '')}
          >
            <BoardIcon />
            <span>Board</span>
          </NavLink>
          <NavLink
            to={sectionHref('/workspace')}
            aria-label="Agents"
            className={({ isActive }) => (isActive ? 'is-active' : '')}
          >
            <TerminalIcon />
            <span>Agents</span>
          </NavLink>
          <NavLink
            to={sectionHref('/orchestrators')}
            className={({ isActive }) => (isActive ? 'is-active' : '')}
          >
            <BoardIcon />
            <span>Orchestrators</span>
          </NavLink>
          <NavLink
            to={sectionHref('/preview')}
            aria-label="Preview"
            className={({ isActive }) => (isActive ? 'is-active' : '')}
          >
            <MonitorIcon />
            <span>Preview</span>
          </NavLink>
        </nav>
        <div className="topbar-right">
          <InboxButton />
          <ThemeSwitch />
          <NavLink
            to={sectionHref('/settings')}
            aria-label="Settings"
            className={({ isActive }) => (isActive ? 'is-active' : '')}
          >
            <SettingsIcon />
            <span>Settings</span>
          </NavLink>
        </div>
      </header>
      <div className="app-shell">
        {(!fullWidth || projects.open) && (
          <ProjectSidebar panelOpen={projects.open} onNavigate={projects.close} />
        )}
        <div className="app-main">
          <Suspense
            fallback={
              <main className="page" role="status">
                Loading page…
              </main>
            }
          >
            <Routes>
              <Route path="/" element={<ProjectsPage />} />
              <Route path="/board" element={<BoardPage />} />
              <Route path="/projects/:id" element={<ProjectPage />} />
              <Route path="/workspace" element={<WorkspacePage />} />
              <Route path="/preview" element={<PreviewPage />} />
              <Route path="/orchestrators" element={<OrchestratorPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route
                path="*"
                element={
                  <main className="page">
                    <div className="empty">
                      <h2>Page not found</h2>
                      <Link to="/">Back to projects</Link>
                    </div>
                  </main>
                }
              />
            </Routes>
          </Suspense>
        </div>
      </div>
      <MobileTabBar projectsOpen={projects.open} onToggleProjects={projects.toggle} />
    </>
  );
}
