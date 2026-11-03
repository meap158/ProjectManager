// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
const read = vi.hoisted(() => vi.fn());
vi.mock('../api', () => ({ api: { projectBranches: read } }));
import { ProjectBranches } from './ProjectBranches';
afterEach(() => {
  cleanup();
  read.mockReset();
});
const branch = {
  name: 'feature/long-name',
  current: false,
  remote: false,
  hash: 'abc123',
  subject: 'Latest change',
  committedAt: '2026-11-01T10:00:00Z',
  upstream: null,
  tracking: '',
  worktree: true,
};
it('shows current tracking and expandable branch details, and refreshes', async () => {
  read.mockResolvedValue({
    isRepo: true,
    current: 'main',
    detached: false,
    head: 'abc123',
    branches: [
      { ...branch, name: 'main', current: true, upstream: 'origin/main', tracking: '[ahead 2]' },
      branch,
    ],
  });
  render(<ProjectBranches projectId={1} visible />);
  expect(await screen.findByText('main')).toBeTruthy();
  expect(screen.getByText(/ahead 2/)).toBeTruthy();
  expect(screen.getByText('Other branches')).toBeTruthy();
  expect(screen.getByText('feature/long-name')).toBeTruthy();
  expect(screen.getByText('In worktree')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Refresh branches' }));
  await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
});
it('handles detached HEAD, non-Git folders and errors', async () => {
  read.mockResolvedValueOnce({
    isRepo: true,
    current: null,
    detached: true,
    head: 'abc123',
    branches: [],
  });
  const view = render(<ProjectBranches projectId={1} visible />);
  expect(await screen.findByText(/Detached HEAD/)).toBeTruthy();
  view.unmount();
  read.mockResolvedValueOnce({ isRepo: false, branches: [] });
  const plain = render(<ProjectBranches projectId={2} visible />);
  expect(await screen.findByText(/not a Git repository/)).toBeTruthy();
  plain.unmount();
  read.mockRejectedValueOnce(new Error('Read failed'));
  render(<ProjectBranches projectId={3} visible />);
  expect(await screen.findByText('Read failed')).toBeTruthy();
});
it('does not read branches while the overview is hidden', () => {
  render(<ProjectBranches projectId={1} visible={false} />);
  expect(read).not.toHaveBeenCalled();
});

it('starts collapsed and filters a large branch list by name', async () => {
  read.mockResolvedValue({
    isRepo: true,
    current: 'main',
    detached: false,
    branches: [
      { ...branch, name: 'main', current: true },
      ...Array.from({ length: 10 }, (_, i) => ({ ...branch, name: `feature/topic-${i}` })),
    ],
  });
  render(<ProjectBranches projectId={1} visible />);
  await screen.findByText('main');
  expect(document.querySelector('details')?.open).toBe(false);
  fireEvent.change(screen.getByRole('searchbox', { hidden: true }), {
    target: { value: 'topic-7' },
  });
  expect(screen.getByText('feature/topic-7')).toBeTruthy();
  expect(screen.queryByText('feature/topic-6')).toBeNull();
});

it('narrows by kind with counts, clears with Escape and Clear filters, and resets per project', async () => {
  read.mockResolvedValue({
    isRepo: true,
    current: 'main',
    detached: false,
    branches: [
      { ...branch, name: 'main', current: true },
      { ...branch, name: 'feature/a', worktree: false },
      { ...branch, name: 'feature/b', worktree: false, tracking: '[behind 2]' },
      { ...branch, name: 'origin/main', remote: true, worktree: false },
      { ...branch, name: 'origin/feature/a', remote: true, worktree: false },
    ],
  });
  const view = render(<ProjectBranches projectId={1} visible />);
  await screen.findByText('main');
  const chip = (name: RegExp) => screen.getByRole('button', { name, hidden: true });
  expect(chip(/^Remote \(2\)/)).toBeTruthy();
  expect(chip(/^Ahead or behind \(1\)/)).toBeTruthy();
  // No branch is gone upstream, so that kind is not offered.
  expect(screen.queryByRole('button', { name: /Upstream gone/, hidden: true })).toBeNull();
  fireEvent.click(chip(/^Remote/));
  expect(screen.getByText('Showing 2 of 4')).toBeTruthy();
  expect(screen.queryByText('feature/b')).toBeNull();
  const search = screen.getByRole('searchbox', { hidden: true });
  fireEvent.change(search, { target: { value: 'feature' } });
  await waitFor(() => expect(screen.getByText('Showing 1 of 4')).toBeTruthy());
  expect(chip(/^All \(3\)/)).toBeTruthy();
  fireEvent.keyDown(search, { key: 'Escape' });
  expect((search as HTMLInputElement).value).toBe('');
  fireEvent.change(search, { target: { value: 'nothing-like-this' } });
  await screen.findByText('No branches match these filters.');
  fireEvent.click(screen.getAllByRole('button', { name: 'Clear filters', hidden: true })[0]!);
  await waitFor(() => expect(screen.getByText('4 branches')).toBeTruthy());
  fireEvent.click(chip(/^Local/));
  view.rerender(<ProjectBranches projectId={2} visible />);
  await waitFor(() => expect(chip(/^All/).getAttribute('aria-pressed')).toBe('true'));
});
