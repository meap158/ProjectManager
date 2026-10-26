// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { App } from './App';

vi.mock('./components/ProjectSidebar', () => ({
  ProjectSidebar: () => <aside>Project sidebar</aside>,
}));
vi.mock('./components/MobileTabBar', () => ({ MobileTabBar: () => null }));
vi.mock('./components/ThemeSwitch', () => ({ ThemeSwitch: () => null }));
vi.mock('./projectPanel', () => ({
  useProjectPanel: () => ({ open: false, close: vi.fn(), toggle: vi.fn() }),
}));
function Page({ name }: { name: string }) {
  const location = useLocation();
  return (
    <h1>
      {name}
      {location.search}
    </h1>
  );
}
vi.mock('./pages/ProjectsPage', () => ({ ProjectsPage: () => <Page name="Projects page" /> }));
vi.mock('./pages/ProjectPage', () => ({ ProjectPage: () => <Page name="Project page" /> }));
vi.mock('./pages/BoardPage', () => ({ BoardPage: () => <Page name="Board page" /> }));
vi.mock('./pages/WorkspacePage', () => ({ WorkspacePage: () => <Page name="Agents page" /> }));
vi.mock('./pages/OrchestratorPage', () => ({
  OrchestratorPage: () => <Page name="Orchestrators page" />,
}));
vi.mock('./pages/SettingsPage', () => ({ SettingsPage: () => <Page name="Settings page" /> }));
afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
});

it.each([
  ['/', 'Projects page', true],
  ['/projects/7?tab=agents', 'Project page?tab=agents', true],
  ['/board?project=7', 'Board page?project=7', true],
  ['/workspace?open=12', 'Agents page?open=12', false],
  ['/orchestrators', 'Orchestrators page', false],
  ['/settings', 'Settings page', true],
])('loads direct route %s and preserves query/sidebar behavior', async (path, heading, sidebar) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: heading });
  expect(!!screen.queryByText('Project sidebar')).toBe(sidebar);
  expect(screen.getByRole('navigation', { name: 'Primary' })).toBeTruthy();
});

it('keeps shell navigation working when switching deferred pages', async () => {
  render(
    <MemoryRouter>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Projects page' });
  fireEvent.click(screen.getByRole('link', { name: 'Agents' }));
  await screen.findByRole('heading', { name: 'Agents page' });
  fireEvent.click(screen.getByRole('link', { name: 'Settings' }));
  await screen.findByRole('heading', { name: 'Settings page' });
});

it("highlights Board, not Home, on a project's Board tab, and Board leads to every project's board (PM-307)", async () => {
  sessionStorage.setItem(
    'pm-section-paths',
    JSON.stringify({ '/board': '/board?project=3&show=active' }),
  );
  render(
    <MemoryRouter initialEntries={['/projects/9?tab=board']}>
      <App />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Project page?tab=board' });
  const board = screen.getByRole('link', { name: 'Board' });
  expect(board.classList.contains('is-active')).toBe(true);
  expect(screen.getByRole('link', { name: 'Home' }).classList.contains('is-active')).toBe(false);
  // The board as last left, but for every project.
  expect(board.getAttribute('href')).toBe('/board?show=active');
});
