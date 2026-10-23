// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { WorkFilters, NO_FILTERS, type WorkFilterState } from './WorkFilters';
afterEach(cleanup);
it('marks the phone filter toggle expanded only while its controls are open', () => {
  render(<Harness />);
  const toggle = screen.getByRole('button', { name: 'Filters' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
});
function Harness() {
  const [filters, setFilters] = useState<WorkFilterState>(NO_FILTERS);
  return (
    <WorkFilters
      items={[]}
      filters={filters}
      onChange={setFilters}
      now={0}
      projectNames={new Map()}
    />
  );
}
it('adds and removes statuses with Shift-click, while normal clicks select one', () => {
  render(<Harness />);
  const running = screen.getByRole('button', { name: 'Running0' });
  const idle = screen.getByRole('button', { name: 'Idle0' });
  fireEvent.click(running);
  fireEvent.click(idle, { shiftKey: true });
  expect(running.getAttribute('aria-pressed')).toBe('true');
  expect(idle.getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(running, { shiftKey: true });
  expect(running.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(idle, { shiftKey: true });
  expect(screen.getByRole('button', { name: 'All0' }).getAttribute('aria-pressed')).toBe('true');
  fireEvent.click(running);
  fireEvent.click(idle);
  expect(running.getAttribute('aria-pressed')).toBe('false');
  expect(idle.getAttribute('aria-pressed')).toBe('true');
});

it('phone status menu: a tap picks one and closes it; a long press adds another (PM-124)', async () => {
  vi.useFakeTimers();
  render(<Harness />);
  const chip = (name: string) => screen.getByRole('button', { name });
  const open = () =>
    fireEvent.click(document.querySelector('.work-status-picker .dropdown-trigger')!);
  const option = (label: RegExp) =>
    [...document.querySelectorAll('.work-status-picker [role="option"]')].find((o) =>
      label.test(o.textContent ?? ''),
    )!;
  open();
  fireEvent.click(option(/^Running/));
  expect(chip('Running0').getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.work-status-picker [role="listbox"]')).toBeNull(); // Closed.
  open();
  fireEvent.click(option(/^Idle/)); // A tap replaces the choice: one status at a time.
  expect(chip('Running0').getAttribute('aria-pressed')).toBe('false');
  expect(chip('Idle0').getAttribute('aria-pressed')).toBe('true');
  open();
  const running = option(/^Running/);
  fireEvent.pointerDown(running);
  await act(() => vi.advanceTimersByTimeAsync(500)); // Held: adds Running to Idle.
  fireEvent.pointerUp(running);
  fireEvent.click(running); // The click that ends a long press changes nothing more.
  expect(chip('Running0').getAttribute('aria-pressed')).toBe('true');
  expect(chip('Idle0').getAttribute('aria-pressed')).toBe('true');
  expect(document.querySelector('.work-status-picker [role="listbox"]')).not.toBeNull(); // Open.
  vi.useRealTimers();
});
