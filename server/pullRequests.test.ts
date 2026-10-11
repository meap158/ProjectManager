import { beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './analysis/exec.js';
import {
  mergeabilityOf,
  parsePullRequestNumber,
  pullRequestAction,
  pullRequestActionBody,
  PullRequestActionError,
  pullRequests,
  summarizeChecks,
} from './pullRequests.js';
import type { PullRequestRepoSettings } from '../shared/types.js';
vi.mock('./analysis/exec.js', () => ({ run: vi.fn() }));
beforeEach(() => vi.resetAllMocks());

const OID = 'a'.repeat(40);
const REPO_JSON = JSON.stringify({
  allow_merge_commit: false,
  allow_squash_merge: true,
  allow_rebase_merge: true,
  allow_auto_merge: true,
  delete_branch_on_merge: false,
  permissions: { admin: false, push: true },
});
const VIEW_OPEN = JSON.stringify({
  number: 7,
  state: 'OPEN',
  isDraft: false,
  headRefName: 'feat/x',
  headRefOid: OID,
  isCrossRepository: false,
});

interface Reply {
  stdout?: string;
  stderr?: string;
  fail?: boolean;
}
/** Answers each gh/git call by matching its arguments (unmatched calls succeed silently). */
function fakeRunner(match: (cmd: string, args: string[]) => Reply | undefined) {
  vi.mocked(run).mockImplementation((cmd, args) => {
    const reply = match(cmd, args) ?? {};
    if (reply.fail)
      return Promise.reject(Object.assign(new Error('failed'), { stderr: reply.stderr ?? '' }));
    return Promise.resolve({ stdout: reply.stdout ?? '', stderr: reply.stderr ?? '' });
  });
}
const calls = () => vi.mocked(run).mock.calls.map(([cmd, args]) => [cmd, ...args].join(' '));
const isRepoCall = (args: string[]) => args[0] === 'api' && args.length === 2;
const isView = (args: string[]) => args[0] === 'pr' && args[1] === 'view';

const settings: PullRequestRepoSettings = {
  mergeMethods: ['merge', 'squash', 'rebase'],
  allowAutoMerge: true,
  deleteBranchOnMerge: false,
  canPush: true,
  isAdmin: false,
};

const row = (number: number, headRefName: string, state: string, extra = {}) => ({
  number,
  title: 'Fix',
  url: `https://github.com/a/b/pull/${number}`,
  author: { login: 'dev' },
  state,
  isDraft: false,
  headRefName,
  headRefOid: OID,
  baseRefName: 'main',
  isCrossRepository: false,
  updatedAt: '2026-10-06',
  closedAt: state === 'OPEN' ? null : '2026-10-07',
  mergedAt: state === 'MERGED' ? '2026-10-07' : null,
  reviewDecision: null,
  ...extra,
});

describe('pull requests', () => {
  it('uses the project cwd and returns draft/review/mergeability metadata', async () => {
    fakeRunner((_cmd, args) =>
      isRepoCall(args)
        ? { stdout: REPO_JSON }
        : {
            stdout: JSON.stringify([
              row(3, 'fix', 'OPEN', {
                isDraft: true,
                reviewDecision: 'APPROVED',
                mergeable: 'MERGEABLE',
                mergeStateStatus: 'DRAFT',
                autoMergeRequest: null,
                statusCheckRollup: [],
              }),
            ]),
          },
    );
    const result = await pullRequests('project folder');
    expect(result.requests[0]?.isDraft).toBe(true);
    expect(result.requests[0]?.mergeability.status).toBe('draft');
    expect(result.requests[0]?.headBranchExists).toBe(true);
    expect(result.repo?.mergeMethods).toEqual(['squash', 'rebase']);
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['--state', 'open']), {
      cwd: 'project folder',
      timeoutMs: 30_000,
    });
  });

  it('lists closed PRs with whether their head branch still exists', async () => {
    fakeRunner((_cmd, args) => {
      if (args.includes('--paginate')) return { stdout: 'main\nkept\n' };
      if (isRepoCall(args)) return { stdout: REPO_JSON };
      return { stdout: JSON.stringify([row(1, 'kept', 'MERGED'), row(2, 'gone', 'CLOSED')]) };
    });
    const result = await pullRequests('folder', 'closed');
    expect(
      result.requests.map((p) => [p.state, p.headBranchExists, p.mergeability.status]),
    ).toEqual([
      ['MERGED', true, 'closed'],
      ['CLOSED', false, 'closed'],
    ]);
  });

  it('offers every merge method when GitHub withholds the repo settings', async () => {
    fakeRunner((_cmd, args) =>
      isRepoCall(args)
        ? { stdout: JSON.stringify({ allow_merge_commit: null, permissions: { push: true } }) }
        : { stdout: '[]' },
    );
    expect((await pullRequests('folder')).repo?.mergeMethods).toEqual([
      'merge',
      'squash',
      'rebase',
    ]);
  });

  it('reports missing gh and authentication failures without crashing the project page', async () => {
    vi.mocked(run).mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect((await pullRequests('folder')).error).toContain('gh auth login');
    vi.mocked(run).mockRejectedValue(
      Object.assign(new Error('auth'), { stderr: 'Authentication required' }),
    );
    expect((await pullRequests('folder')).error).toBe('Authentication required');
  });
});

describe('checks and mergeability', () => {
  it('summarizes check runs and commit statuses', () => {
    const checks = summarizeChecks([
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      {
        __typename: 'StatusContext',
        context: 'ci/legacy',
        state: 'PENDING',
        targetUrl: 'http://insecure.example',
      },
    ]);
    expect(checks).toMatchObject({
      state: 'failing',
      passing: 1,
      failing: 1,
      pending: 2,
      skipped: 1,
    });
    expect(checks.items.find((c) => c.name === 'ci/legacy')?.url).toBeNull();
    expect(summarizeChecks([]).state).toBe('none');
  });

  const base = { state: 'OPEN' as const, isDraft: false, reviewDecision: null, autoMerge: false };
  const noChecks = summarizeChecks([]);
  const pending = summarizeChecks([{ name: 'ci', status: 'QUEUED' }]);
  const failing = summarizeChecks([{ name: 'ci', status: 'COMPLETED', conclusion: 'FAILURE' }]);
  const at = (mergeable: string, mss: string, checks = noChecks, extra = {}) =>
    mergeabilityOf({ ...base, mergeable, mergeStateStatus: mss, ...extra }, checks, settings);

  it('allows merging a clean PR and blocks with a reason otherwise', () => {
    expect(at('MERGEABLE', 'CLEAN')).toMatchObject({ status: 'clean', canMerge: true });
    expect(at('MERGEABLE', 'CLEAN', noChecks, { isDraft: true })).toMatchObject({
      status: 'draft',
      canMerge: false,
    });
    expect(at('CONFLICTING', 'DIRTY')).toMatchObject({ status: 'conflicts', canMerge: false });
    expect(at('MERGEABLE', 'BEHIND')).toMatchObject({
      status: 'behind',
      canMerge: false,
      canUpdateBranch: true,
      canAutoMerge: true,
    });
    expect(at('MERGEABLE', 'BLOCKED', failing).reason).toBe('Required checks are failing.');
    expect(at('MERGEABLE', 'BLOCKED', pending)).toMatchObject({
      reason: 'Waiting for required checks to finish.',
      canAutoMerge: true,
    });
    expect(at('MERGEABLE', 'BLOCKED', noChecks, { reviewDecision: 'REVIEW_REQUIRED' }).reason).toBe(
      'An approving review is required.',
    );
    expect(at('UNKNOWN', 'UNKNOWN')).toMatchObject({ status: 'checking', canMerge: false });
    expect(at('MERGEABLE', 'UNSTABLE', failing)).toMatchObject({
      status: 'unstable',
      canMerge: true,
    });
    expect(at('MERGEABLE', 'CLEAN', pending).canAutoMerge).toBe(true);
    // Already on: nothing more to enable.
    expect(at('MERGEABLE', 'BLOCKED', pending, { autoMerge: true }).canAutoMerge).toBe(false);
  });

  it('honours repo settings: no auto-merge, no write access, admin bypass', () => {
    const pr = { ...base, mergeable: 'MERGEABLE', mergeStateStatus: 'BLOCKED' };
    expect(mergeabilityOf(pr, pending, { ...settings, allowAutoMerge: false }).canAutoMerge).toBe(
      false,
    );
    expect(mergeabilityOf(pr, noChecks, { ...settings, isAdmin: true }).canBypass).toBe(true);
    expect(
      mergeabilityOf({ ...pr, mergeStateStatus: 'CLEAN' }, noChecks, {
        ...settings,
        canPush: false,
      }),
    ).toMatchObject({ canMerge: false, reason: "You don't have write access to this repository." });
  });
});

describe('pull request action validation', () => {
  it('accepts only integer PR numbers', () => {
    expect(parsePullRequestNumber('12')).toBe(12);
    for (const bad of [undefined, '', '0', '-3', '1.5', '1e3', '0x1f', '12abc', '99999999999'])
      expect(parsePullRequestNumber(bad)).toBeNull();
  });

  it('accepts only known actions, merge methods and commit SHAs', () => {
    expect(pullRequestActionBody.safeParse({ action: 'merge', method: 'squash' }).data).toEqual({
      action: 'merge',
      method: 'squash',
      deleteBranch: false,
      auto: false,
      admin: false,
    });
    expect(pullRequestActionBody.safeParse({ action: 'merge', method: 'octopus' }).success).toBe(
      false,
    );
    expect(pullRequestActionBody.safeParse({ action: 'rm -rf' }).success).toBe(false);
    const option = { action: 'merge', method: 'merge', headOid: '--admin' };
    expect(pullRequestActionBody.safeParse(option).success).toBe(false);
  });
});

describe('pull request actions', () => {
  it('merges with the chosen method and head guard, then deletes the remote and local branch', async () => {
    fakeRunner((_cmd, args) => {
      if (isRepoCall(args)) return { stdout: REPO_JSON };
      if (isView(args)) return { stdout: VIEW_OPEN };
      if (args[0] === 'rev-parse') return { stdout: `${OID}\n` };
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n' };
      return undefined;
    });
    const result = await pullRequestAction('folder', 7, {
      action: 'merge',
      method: 'squash',
      deleteBranch: true,
      auto: false,
      admin: false,
      headOid: OID,
    });
    expect(calls()).toContain(`gh pr merge 7 --squash --match-head-commit ${OID}`);
    expect(calls()).toContain('gh api --method DELETE repos/{owner}/{repo}/git/refs/heads/feat/x');
    expect(calls()).toContain('git branch -D -- feat/x');
    // gh's own --delete-branch would switch the project's checkout: never used.
    expect(calls().some((c) => c.includes('--delete-branch'))).toBe(false);
    expect(result.message).toContain('Merged #7.');
    expect(result.message).toContain('local branch deleted');
    for (const [, , options] of vi.mocked(run).mock.calls) expect(options?.cwd).toBe('folder');
  });

  it('refuses a merge method the repository disallows without calling gh pr merge', async () => {
    fakeRunner((_cmd, args) => (isRepoCall(args) ? { stdout: REPO_JSON } : undefined));
    await expect(
      pullRequestAction('folder', 7, {
        action: 'merge',
        method: 'merge',
        deleteBranch: false,
        auto: false,
        admin: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(calls().some((c) => c.startsWith('gh pr merge'))).toBe(false);
  });

  it('enables auto-merge without deleting the branch', async () => {
    fakeRunner((_cmd, args) =>
      isRepoCall(args) ? { stdout: REPO_JSON } : isView(args) ? { stdout: VIEW_OPEN } : undefined,
    );
    const result = await pullRequestAction('folder', 7, {
      action: 'merge',
      method: 'rebase',
      deleteBranch: true,
      auto: true,
      admin: false,
    });
    expect(calls()).toContain('gh pr merge 7 --rebase --auto');
    expect(calls().some((c) => c.includes('DELETE'))).toBe(false);
    expect(result.message).toContain('Auto-merge enabled');
  });

  it('surfaces gh stderr as the error message', async () => {
    const stderr = 'X Pull request #7 is not mergeable: the base branch policy prohibits it.\n';
    fakeRunner((_cmd, args) =>
      isRepoCall(args)
        ? { stdout: REPO_JSON }
        : isView(args)
          ? { stdout: VIEW_OPEN }
          : { fail: true, stderr },
    );
    const error: unknown = await pullRequestAction('folder', 7, {
      action: 'merge',
      method: 'squash',
      deleteBranch: false,
      auto: false,
      admin: false,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PullRequestActionError);
    expect(error).toMatchObject({ status: 502, message: stderr.trim() });
  });

  it('maps the simple actions onto gh subcommands', async () => {
    fakeRunner(() => undefined);
    await pullRequestAction('folder', 7, { action: 'ready' });
    await pullRequestAction('folder', 7, { action: 'draft' });
    await pullRequestAction('folder', 7, { action: 'reopen' });
    await pullRequestAction('folder', 7, { action: 'close', deleteBranch: false });
    await pullRequestAction('folder', 7, { action: 'update-branch', rebase: true });
    await pullRequestAction('folder', 7, { action: 'update-branch', rebase: false });
    await pullRequestAction('folder', 7, { action: 'disable-auto-merge' });
    expect(calls()).toEqual([
      'gh pr ready 7',
      'gh pr ready 7 --undo',
      'gh pr reopen 7',
      'gh pr close 7',
      'gh pr update-branch 7 --rebase',
      'gh pr update-branch 7',
      'gh pr merge 7 --disable-auto',
    ]);
  });

  it('closes and then deletes the branch when asked', async () => {
    fakeRunner((_cmd, args) => {
      if (isView(args)) return { stdout: VIEW_OPEN };
      if (args[0] === 'rev-parse') return { fail: true };
      return undefined;
    });
    const result = await pullRequestAction('folder', 7, { action: 'close', deleteBranch: true });
    expect(calls()).toContain('gh pr close 7');
    expect(calls()).toContain('gh api --method DELETE repos/{owner}/{repo}/git/refs/heads/feat/x');
    expect(result.message).toContain('no local branch');
  });

  it('keeps a local branch that is checked out or differs from the PR head', async () => {
    const merged = VIEW_OPEN.replace('"OPEN"', '"MERGED"');
    fakeRunner((_cmd, args) => {
      if (isView(args)) return { stdout: merged };
      if (args[0] === 'rev-parse') return { stdout: `${OID}\n` };
      if (args[0] === 'symbolic-ref') return { stdout: 'feat/x\n' };
      return undefined;
    });
    expect((await pullRequestAction('folder', 7, { action: 'delete-branch' })).message).toContain(
      'local branch kept: it is checked out',
    );
    fakeRunner((_cmd, args) => {
      if (isView(args)) return { stdout: merged };
      if (args[0] === 'rev-parse') return { stdout: `${'b'.repeat(40)}\n` };
      if (args[0] === 'symbolic-ref') return { stdout: 'main\n' };
      if (args.includes('DELETE'))
        return { fail: true, stderr: 'gh: Reference does not exist (HTTP 422)' };
      return undefined;
    });
    const message = (await pullRequestAction('folder', 7, { action: 'delete-branch' })).message;
    expect(message).toContain('already gone on GitHub');
    expect(message).toContain('differs from the pull request head');
    expect(calls().some((c) => c.startsWith('git branch -D'))).toBe(false);
  });

  it('refuses to delete the branch of an open PR or a fork', async () => {
    fakeRunner((_cmd, args) => (isView(args) ? { stdout: VIEW_OPEN } : undefined));
    await expect(pullRequestAction('folder', 7, { action: 'delete-branch' })).rejects.toMatchObject(
      { status: 409 },
    );
    const fork = VIEW_OPEN.replace('"OPEN"', '"CLOSED"').replace(
      '"isCrossRepository":false',
      '"isCrossRepository":true',
    );
    fakeRunner((_cmd, args) => (isView(args) ? { stdout: fork } : undefined));
    await expect(pullRequestAction('folder', 7, { action: 'delete-branch' })).rejects.toMatchObject(
      { status: 409 },
    );
    expect(calls().some((c) => c.includes('DELETE'))).toBe(false);
  });

  it('restores a deleted branch at the PR head commit', async () => {
    const closed = VIEW_OPEN.replace('"OPEN"', '"CLOSED"');
    fakeRunner((_cmd, args) => (isView(args) ? { stdout: closed } : undefined));
    await pullRequestAction('folder', 7, { action: 'restore-branch' });
    expect(calls()).toContain(
      `gh api --method POST repos/{owner}/{repo}/git/refs -f ref=refs/heads/feat/x -f sha=${OID}`,
    );
  });
});
