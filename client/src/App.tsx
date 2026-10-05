import { Link, NavLink, Route, Routes, useLocation } from 'react-router';
import { ProjectSidebar } from './components/ProjectSidebar';
import { ThemeSwitch } from './components/ThemeSwitch';
import { BoardIcon, GridIcon, SettingsIcon, TerminalIcon } from './components/icons';
import { RememberLastPage } from './lastPage';
import { BoardPage } from './pages/BoardPage';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { WorkspacePage } from './pages/WorkspacePage';

export function App() {
  // The agent workspace takes the full width: terminals need the screen space more than the list.
  const fullWidth = useLocation().pathname === '/workspace';
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
            to="/board"
            aria-label="Board"
            className={({ isActive }) => (isActive ? 'is-active' : '')}
          >
            <BoardIcon />
            <span>Board</span>
          </NavLink>
          <NavLink
            to="/workspace"
            aria-label="Agents"
            className={({ isActive }) => (isActive ? 'is-active' : '')}
          >
            <TerminalIcon />
            <span>Agents</span>
          </NavLink>
        </nav>
        <div className="topbar-right">
          <ThemeSwitch />
          <NavLink
            to="/settings"
            aria-label="Settings"
            className={({ isActive }) => (isActive ? 'is-active' : '')}
          >
            <SettingsIcon />
            <span>Settings</span>
          </NavLink>
        </div>
      </header>
      <div className="app-shell">
        {!fullWidth && <ProjectSidebar />}
        <div className="app-main">
          <Routes>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/board" element={<BoardPage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
            <Route path="/workspace" element={<WorkspacePage />} />
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
        </div>
      </div>
    </>
  );
}
