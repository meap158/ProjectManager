// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { PullRequest, PullRequestsResult } from '../../../shared/types';
import { api } from '../api';
import { PullRequestsPanel } from './PullRequestsPanel';

vi.mock('../api', () => ({
  api: {
    pullRequests: vi.fn(),
    pullRequestAction: vi.fn(),
    setPullRequestAccount: vi.fn(),
    getGitIdentity: vi.fn(),
    setGitIdentity: vi.fn(),
  },
}));
beforeEach(() => {
  vi.mocked(api.getGitIdentity).mockResolvedValue({ name: null, email: null });
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
  account: {
    login: 'meap158',
    source: 'owner',
    owner: 'meap158',
    accounts: ['meapwork', 'meap158'],
    override: null,
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

it('names the account it acts as, in the tab and in the merge and close confirmations', async () => {
  vi.mocked(api.pullRequests).mockResolvedValue(result([pr()]));
  render(<PullRequestsPanel projectId={4} visible />);
  expect((await screen.findByText('meap158')).closest('p')?.textContent).toContain(
    'Acting as meap158 (owner of meap158)',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Actions for #12' }));
  const merge = screen.getByText('Squash and merge: #12?').closest('dialog')!;
  expect(merge.textContent).toContain('Acting as meap158.');
  const close = screen.getByText('Close #12 without merging?').closest('dialog')!;
  expect(close.textContent).toContain('Acting as meap158.');
});

it('chooses another gh account for the project, then reloads as it', async () => {
  vi.mocked(api.pullRequests).mockResolvedValue(result([]));
  vi.mocked(api.setPullRequestAccount).mockResolvedValue({ override: 'meapwork' });
  render(<PullRequestsPanel projectId={4} visible />);
  fireEvent.click(await screen.findByRole('button', { name: /GitHub account/ }));
  fireEvent.click(within(screen.getByRole('option', { name: /meapwork/ })).getByRole('button'));
  await waitFor(() => expect(api.setPullRequestAccount).toHaveBeenCalledWith(4, 'meapwork'));
  await waitFor(() => expect(api.pullRequests).toHaveBeenCalledTimes(2));
});

it('sets the commit author agents use in this project (PM-186)', async () => {
  vi.mocked(api.pullRequests).mockResolvedValue(result([]));
  vi.mocked(api.setGitIdentity).mockResolvedValue({ name: 'Ada', email: 'ada@example.com' });
  render(<PullRequestsPanel projectId={4} visible />);
  fireEvent.click(await screen.findByRole('button', { name: 'Set' }));
  fireEvent.change(screen.getByLabelText('Commit name'), { target: { value: 'Ada' } });
  fireEvent.change(screen.getByLabelText('Commit email'), {
    target: { value: 'ada@example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.setGitIdentity).toHaveBeenCalledWith(4, 'Ada', 'ada@example.com'));
  expect(await screen.findByText('Ada <ada@example.com>')).toBeDefined();
});
