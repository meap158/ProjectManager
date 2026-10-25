// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ContextMenu } from './ContextMenu';
afterEach(cleanup);
it('keeps its trigger available for toggling and restores focus after keyboard dismissal', () => {
  const anchor = document.createElement('button');
  document.body.append(anchor);
  const close = vi.fn();
  const { unmount, container } = render(
    <ContextMenu
      x={10}
      y={10}
      anchor={anchor}
      label="App actions"
      items={[{ command: 'open', label: 'Open' }]}
      onPick={vi.fn()}
      onClose={close}
    />,
  );
  expect(document.activeElement).toBe(screen.getByRole('menuitem'));
  expect(container.querySelector('[role="menu"]')).toBeNull();
  expect(screen.getByRole('menu').parentElement).toBe(document.body);
  fireEvent.pointerDown(anchor);
  expect(close).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole('menuitem'), { key: 'Escape' });
  expect(close).toHaveBeenCalledOnce();
  unmount();
  expect(document.activeElement).toBe(anchor);
  anchor.remove();
});
