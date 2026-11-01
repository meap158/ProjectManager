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
