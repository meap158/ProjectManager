// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { navigateProjectPane } from './projectPaneNavigation';
afterEach(cleanup);
it('opens adjacent visible projects while retaining pane focus and stopping terminal shortcuts', () => {
  const navigate = vi.fn();
  const outside = vi.fn();
  render(
    <div onKeyDown={outside}>
      <aside aria-label="Projects" onKeyDown={(e) => navigateProjectPane(e, navigate)}>
        <input aria-label="Filter" />
        <a className="sidebar-item" href="/projects/3?tab=agents" aria-current="page">
          First
        </a>
        <a className="sidebar-item" href="/projects/8?tab=agents">
          Second
        </a>
      </aside>
    </div>,
  );
  fireEvent.keyDown(screen.getByText('First'), { key: 'ArrowDown', ctrlKey: true });
  expect(navigate).toHaveBeenLastCalledWith('/projects/8?tab=agents');
  expect(document.activeElement).toBe(screen.getByText('Second'));
  expect(outside).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByText('Second'), { key: 'ArrowUp', ctrlKey: true });
  expect(document.activeElement).toBe(screen.getByText('First'));
  navigate.mockClear();
  fireEvent.keyDown(screen.getByLabelText('Filter'), { key: 'ArrowDown', ctrlKey: true });
  fireEvent.keyDown(screen.getByText('First'), { key: 'ArrowDown' });
  expect(navigate).not.toHaveBeenCalled();
});
