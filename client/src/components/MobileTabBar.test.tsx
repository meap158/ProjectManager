// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useNavigate } from 'react-router';
import { useProjectPanel } from '../projectPanel';
import { MobileTabBar } from './MobileTabBar';

let phone = true;
const mediaListeners: (() => void)[] = [];
vi.stubGlobal('matchMedia', () => ({
  get matches() {
    return phone;
  },
  addEventListener: (_: string, cb: () => void) => mediaListeners.push(cb),
  removeEventListener: () => undefined,
}));

afterEach(() => {
  cleanup();
  phone = true;
  mediaListeners.length = 0;
});

function Harness() {
  const panel = useProjectPanel();
  const navigate = useNavigate();
  return (
    <>
      <button type="button" onClick={() => navigate('/projects/1')}>
        Go to project
      </button>
      {panel.open && <div role="dialog" aria-label="Project panel" />}
      <MobileTabBar projectsOpen={panel.open} onToggleProjects={panel.toggle} />
    </>
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Harness />
    </MemoryRouter>,
  );
}

const projectsTab = () => screen.getByRole('button', { name: 'Projects' });
const panel = () => screen.queryByRole('dialog', { name: 'Project panel' });

describe('MobileTabBar', () => {
  it('marks Home active on project pages and Projects only while the picker is open', () => {
    renderAt('/board');
    expect(screen.getByRole('link', { name: 'Board' }).className).toBe('is-active');
    expect(projectsTab().className).toBe('');
    cleanup();
    renderAt('/projects/3');
    expect(projectsTab().className).toBe('');
    expect(screen.getByRole('link', { name: 'Home' }).className).toBe('is-active');
  });

  it('toggles the project panel, which takes the active state while open', () => {
    renderAt('/board');
    fireEvent.click(projectsTab());
    expect(panel()).not.toBeNull();
    expect(projectsTab().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByRole('link', { name: 'Board' }).className).toBe('');
    fireEvent.click(projectsTab());
    expect(panel()).toBeNull();
  });

  it('closes the panel on navigation, Esc, or leaving phone width', () => {
    renderAt('/');
    fireEvent.click(projectsTab());
    fireEvent.click(screen.getByRole('button', { name: 'Go to project' }));
    expect(panel()).toBeNull();

    fireEvent.click(projectsTab());
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(panel()).toBeNull();

    fireEvent.click(projectsTab());
    phone = false;
    act(() => mediaListeners.forEach((cb) => cb()));
    expect(panel()).toBeNull();
  });

  it('leaves the panel open when an inner menu handles Esc', () => {
    renderAt('/');
    fireEvent.click(projectsTab());
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    event.preventDefault();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(panel()).not.toBeNull();
  });
});
