// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { WorkFilters, NO_FILTERS, type WorkFilterState } from './WorkFilters';
afterEach(cleanup);
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
