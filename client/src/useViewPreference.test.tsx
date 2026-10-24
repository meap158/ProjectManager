// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useViewPreference } from './useViewPreference';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.restoreAllMocks();
});
function View() {
  const [open, setOpen] = useViewPreference(
    'test.view',
    false,
    (v): v is boolean => typeof v === 'boolean',
  );
  return (
    <button aria-expanded={open} onClick={() => setOpen(!open)}>
      Section
    </button>
  );
}
it('restores expanded and collapsed preferences after remount', () => {
  const first = render(<View />);
  fireEvent.click(screen.getByRole('button'));
  first.unmount();
  const second = render(<View />);
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(screen.getByRole('button'));
  second.unmount();
  render(<View />);
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
});
it.each(['broken json', '"wrong type"'])('ignores invalid stored preferences: %s', (saved) => {
  localStorage.setItem('test.view', saved);
  render(<View />);
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('false');
});
it('still toggles when storage is blocked', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked');
  });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('full');
  });
  render(<View />);
  fireEvent.click(screen.getByRole('button'));
  expect(screen.getByRole('button').getAttribute('aria-expanded')).toBe('true');
});
