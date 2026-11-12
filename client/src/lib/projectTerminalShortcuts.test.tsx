// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useProjectTerminalShortcuts } from './projectTerminalShortcuts';

afterEach(cleanup);
it('focuses the project CLI and toggles fullscreen without forwarding the keys', () => {
  const toggle = vi.fn();
  const forwarded = vi.fn();
  function Fixture() {
    const dock = useRef<HTMLDivElement>(null);
    useProjectTerminalShortcuts(dock, true, toggle);
    return (
      <div ref={dock} onKeyDown={forwarded}>
        <textarea className="xterm-helper-textarea" />
        <input />
      </div>
    );
  }
  const { container } = render(<Fixture />);
  const terminal = container.querySelector('textarea')!;
  fireEvent.keyDown(document.body, { altKey: true, code: 'Digit1' });
  expect(document.activeElement).toBe(terminal);
  fireEvent.keyDown(terminal, { altKey: true, key: 'Enter' });
  expect(toggle).toHaveBeenCalledTimes(1);
  expect(forwarded).not.toHaveBeenCalled();
  fireEvent.keyDown(container.querySelector('input')!, { altKey: true, key: 'Enter' });
  fireEvent.keyDown(terminal, { altKey: true, key: 'Enter', repeat: true });
  fireEvent.keyDown(terminal, { altKey: true, key: 'Enter', isComposing: true });
  const dialog = document.createElement('dialog');
  dialog.open = true;
  container.append(dialog);
  fireEvent.keyDown(terminal, { altKey: true, key: 'Enter' });
  expect(toggle).toHaveBeenCalledTimes(1);
});
