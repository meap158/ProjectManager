// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PullRequest, PullRequestsResult } from '../../../shared/types';
import { api } from '../api';
import { PullRequestsPanel } from './PullRequestsPanel';

vi.mock('../api', () => ({ api: { pullRequests: vi.fn(), pullRequestAction: vi.fn() } }));
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const OID = 'c'.repeat(40);
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 12,
  title: 'Add things',
  url: 'https://github.com/a/b/pull/12',
  author: { login: 'dev' },
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/things',
  headRefOid: OID,
  baseRefName: 'main',
  isCrossRepository: false,
  headBranchExists: true,
  updatedAt: new Date().toISOString(),
  closedAt: null,
  mergedAt: null,
  reviewDecision: 'APPROVED',
  autoMerge: null,
  checks: { state: 'passing', passing: 2, failing: 0, pending: 0, skipped: 0, items: [] },
  mergeability: {
    status: 'clean',
    canMerge: true,
    reason: null,
    canUpdateBranch: false,
    canAutoMerge: false,
    canBypass: false,
  },
  ...over,
});
const result = (
  requests: PullRequest[],
  state: 'open' | 'closed' = 'open',
): PullRequestsResult => ({
  state,
  requests,
  repo: {
    mergeMethods: ['squash', 'rebase'],
    allowAutoMerge: true,
    deleteBranchOnMerge: false,
    canPush: true,
    isAdmin: false,
  },
  error: null,
  fetchedAt: new Date().toISOString(),
});

it('merges with the first allowed method after an in-app confirmation, then refreshes', async () => {
  vi.mocked(api.pullRequests).mockResolvedValue(result([pr()]));
  vi.mocked(api.pullRequestAction).mockResolvedValue({ ok: true, message: 'Merged #12.' });
  render(<PullRequestsPanel projectId={4} visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for #12' }));
  fireEvent.click(screen.getByLabelText('Delete branch after merging or closing'));
  // The visible merge button only opens the dialog; the dialog's button confirms.
  const [open] = screen.getAllByRole('button', { name: 'Squash and merge' });
  fireEvent.click(open!);
  expect(api.pullRequestAction).not.toHaveBeenCalled();
  const dialog = screen.getByText('Squash and merge: #12?').closest('dialog')!;
  fireEvent.click(within(dialog).getByText('Squash and merge'));
  await screen.findByText('Merged #12.');
  expect(api.pullRequestAction).toHaveBeenCalledWith(4, 12, {
    action: 'merge',
    method: 'squash',
    deleteBranch: true,
    auto: false,
    admin: false,
    headOid: OID,
  });
  await waitFor(() => expect(api.pullRequests).toHaveBeenCalledTimes(2));
});

it('disables merge with the reason and offers update branch and auto-merge when behind', async () => {
  const reason = 'This branch is out of date with the base branch.';
  vi.mocked(api.pullRequests).mockResolvedValue(
    result([
      pr({
        mergeability: {
          status: 'behind',
          canMerge: false,
          reason,
          canUpdateBranch: true,
          canAutoMerge: true,
          canBypass: false,
        },
      }),
    ]),
  );
  render(<PullRequestsPanel projectId={4} visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for #12' }));
  expect(screen.getByText(reason)).toBeTruthy();
  expect(screen.getByTitle(reason).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText('Update branch')).toBeTruthy();
  expect(screen.getAllByText('Enable auto-merge').length).toBeGreaterThan(0);
});

it('shows gh errors inline in the row', async () => {
  vi.mocked(api.pullRequests).mockResolvedValue(result([pr()]));
  vi.mocked(api.pullRequestAction).mockRejectedValue(new Error('GraphQL: not permitted'));
  render(<PullRequestsPanel projectId={4} visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for #12' }));
  fireEvent.click(screen.getByText('Convert to draft'));
  expect((await screen.findByRole('alert')).textContent).toBe('GraphQL: not permitted');
  expect(api.pullRequestAction).toHaveBeenCalledWith(4, 12, { action: 'draft' });
});

it('lists closed pull requests with reopen and restore branch', async () => {
  vi.mocked(api.pullRequests).mockImplementation((_id, state) =>
    Promise.resolve(
      state === 'closed'
        ? result(
            [pr({ state: 'CLOSED', closedAt: new Date().toISOString(), headBranchExists: false })],
            'closed',
          )
        : result([]),
    ),
  );
  vi.mocked(api.pullRequestAction).mockResolvedValue({ ok: true, message: 'Restored.' });
  render(<PullRequestsPanel projectId={4} visible />);
  await screen.findByText('No open pull requests.');
  fireEvent.click(screen.getByRole('button', { name: 'Closed' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Actions for #12' }));
  expect(screen.getByText('Reopen pull request')).toBeTruthy();
  expect(screen.queryByText('Delete branch')).toBeNull();
  fireEvent.click(screen.getByText('Restore branch'));
  await screen.findByText('Restored.');
  expect(api.pullRequestAction).toHaveBeenCalledWith(4, 12, { action: 'restore-branch' });
  expect(api.pullRequests).toHaveBeenLastCalledWith(4, 'closed');
});
