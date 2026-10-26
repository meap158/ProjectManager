// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Link, MemoryRouter, useLocation } from 'react-router';
import { sectionHref, useHomeHref, useSectionMemory } from './sectionMemory';
import { RememberLastPage, saveLastPage } from './lastPage';

afterEach(() => {
  cleanup();
  localStorage.clear();
  sessionStorage.clear();
  vi.restoreAllMocks();
});
function Harness() {
  useSectionMemory();
  const home = useHomeHref();
  const location = useLocation();
  return (
    <>
      <Link to={home}>Home</Link>
      <Link to="/">All projects</Link>
      <Link to="/projects/7?tab=files">Project</Link>
      <Link to="/board">Board</Link>
      <output>{location.pathname + location.search}</output>
    </>
  );
}
function open(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>,
  );
}
it('remembers a project and its tab across sections and reloads, and remembers explicitly choosing All projects', () => {
  open('/');
  fireEvent.click(screen.getByText('Project'));
  fireEvent.click(screen.getByText('Board'));
  expect(screen.getByText('Home').getAttribute('href')).toBe('/projects/7?tab=files');
  cleanup();
  sessionStorage.clear(); // A new browser tab retains the Home selection.
  open('/settings');
  fireEvent.click(screen.getByText('Home'));
  expect(screen.getByRole('status').textContent).toBe('/projects/7?tab=files');
  fireEvent.click(screen.getByText('All projects'));
  fireEvent.click(screen.getByText('Board'));
  expect(screen.getByText('Home').getAttribute('href')).toBe('/');
});
it('honors a direct project URL over the saved selection and rejects invalid saved destinations', () => {
  localStorage.setItem('pm-home-selection', '/projects/7');
  open('/projects/9?tab=files');
  expect(screen.getByText('Home').getAttribute('href')).toBe('/projects/9?tab=files');
  cleanup();
  // A project's Board tab belongs to Board (PM-307): Home leads to the project, and remembers it.
  open('/projects/9?tab=board');
  expect(screen.getByText('Home').getAttribute('href')).toBe('/projects/9');
  expect(localStorage.getItem('pm-home-selection')).toBe('/projects/9');
  cleanup();
  sessionStorage.clear();
  for (const invalid of ['https://example.com', '//example.com', '/settings', '/projects/nope']) {
    localStorage.setItem('pm-home-selection', invalid);
    expect(sectionHref('/')).toBe('/');
  }
});
it('keeps navigation working when persistent storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  open('/projects/7');
  fireEvent.click(screen.getByText('Board'));
  expect(screen.getByRole('status').textContent).toBe('/board');
});

it('does not overwrite the Home selection with the temporary launcher URL', () => {
  localStorage.setItem('pm-home-selection', '/projects/7?tab=files');
  saveLastPage('/board');
  render(
    <MemoryRouter initialEntries={['/']}>
      <RememberLastPage />
      <Harness />
    </MemoryRouter>,
  );
  expect(screen.getByRole('status').textContent).toBe('/board');
  expect(screen.getByText('Home').getAttribute('href')).toBe('/projects/7?tab=files');
});
