// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilterChips } from './FilterChips';

afterEach(cleanup);

const chips = [
  { key: 'all', label: 'All', count: 3 },
  { key: 'a', label: 'Alpha', count: 2, tone: 'danger' },
  { key: 'b', label: 'Beta', count: 1 },
];

describe('FilterChips', () => {
  it('marks the chosen chip, selects on click and moves with the arrow keys', () => {
    const onSelect = vi.fn();
    render(<FilterChips chips={chips} selected="a" onSelect={onSelect} label="Show" />);
    const alpha = screen.getByRole('button', { name: 'Alpha (2)' });
    expect(alpha.getAttribute('aria-pressed')).toBe('true');
    expect(alpha.dataset.tone).toBe('danger');
    fireEvent.click(screen.getByRole('button', { name: 'Beta (1)' }));
    expect(onSelect).toHaveBeenCalledWith('b');
    alpha.focus();
    fireEvent.keyDown(alpha, { key: 'ArrowRight' });
    expect(document.activeElement?.textContent).toBe('Beta1');
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement?.textContent).toBe('All3');
  });
});
