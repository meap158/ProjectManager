import { Link, NavLink, Route, Routes } from 'react-router';
import { ProjectSidebar } from './components/ProjectSidebar';
import { ProjectPage } from './pages/ProjectPage';
import { ProjectsPage } from './pages/ProjectsPage';

export function App() {
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand">
          <img src="/favicon.svg" alt="" />
          ProjectManager
        </Link>
        <nav className="topnav" aria-label="Primary">
          <NavLink to="/" end className={({ isActive }) => (isActive ? 'is-active' : '')}>
            All projects
          </NavLink>
        </nav>
      </header>
      <div className="app-shell">
        <ProjectSidebar />
        <div className="app-main">
          <Routes>
            <Route path="/" element={<ProjectsPage />} />
            <Route path="/projects/:id" element={<ProjectPage />} />
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
          <footer className="footer">
            Animated components by{' '}
            <a href="https://rareui.com" target="_blank" rel="noreferrer">
              Rare UI
            </a>
          </footer>
        </div>
      </div>
    </>
  );
}
