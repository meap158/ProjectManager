import { z } from 'zod';
import { run } from './analysis/exec.js';
import { PR_MERGE_METHODS } from '../shared/types.js';
import type {
  PullRequest,
  PullRequestAction,
  PullRequestActionResult,
  PullRequestCheck,
  PullRequestChecks,
  PullRequestListState,
  PullRequestMergeMethod,
  PullRequestMergeability,
  PullRequestRepoSettings,
  PullRequestsResult,
} from '../shared/types.js';
import type { RefEvent } from './analysis/cardRefs.js';

/*
 * The Pull requests tab: list a project's PRs and act on them through the GitHub CLI, run in the
 * project folder (gh resolves {owner}/{repo} from its remote). Every command is an argument array
 * (never a shell string), and every action re-reads the PR from GitHub rather than trusting the
 * client's copy of it: the client only names a PR number and a validated action.
 */

const LIST_FIELDS = [
  'number',
  'title',
  'url',
  'author',
  'state',
  'isDraft',
  'headRefName',
  'headRefOid',
  'baseRefName',
  'isCrossRepository',
  'updatedAt',
  'closedAt',
  'mergedAt',
  'reviewDecision',
  'mergeable',
  'mergeStateStatus',
  'autoMergeRequest',
  'statusCheckRollup',
].join(',');

const checkRow = z.object({
  __typename: z.string().optional(),
  // CheckRun
  name: z.string().optional(),
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  detailsUrl: z.string().nullish(),
  // StatusContext
  context: z.string().optional(),
  state: z.string().nullish(),
  targetUrl: z.string().nullish(),
});

const prRow = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  url: z.string().url(),
  author: z.object({ login: z.string() }).nullable(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']).catch('OPEN'),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string().default(''),
  baseRefName: z.string(),
  isCrossRepository: z.boolean().default(false),
  updatedAt: z.string(),
  closedAt: z.string().nullish(),
  mergedAt: z.string().nullish(),
  reviewDecision: z.string().nullable(),
  mergeable: z.string().nullish(),
  mergeStateStatus: z.string().nullish(),
  autoMergeRequest: z.object({ mergeMethod: z.string().nullish() }).nullish(),
  statusCheckRollup: z.array(checkRow).nullish(),
});
type PrRow = z.infer<typeof prRow>;

const repoRow = z.object({
  allow_merge_commit: z.boolean().nullish(),
  allow_squash_merge: z.boolean().nullish(),
  allow_rebase_merge: z.boolean().nullish(),
  allow_auto_merge: z.boolean().nullish(),
  delete_branch_on_merge: z.boolean().nullish(),
  permissions: z.object({ admin: z.boolean().optional(), push: z.boolean().optional() }).nullish(),
});

function httpsUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}

/** One status-check rollup entry (a CheckRun or a commit StatusContext) as pass/fail/pending. */
function checkOf(row: z.infer<typeof checkRow>): PullRequestCheck {
  if (row.__typename === 'StatusContext' || (row.context && !row.name)) {
    const state = (row.state ?? '').toUpperCase();
    return {
      name: row.context ?? 'Status',
      state:
        state === 'SUCCESS'
          ? 'pass'
          : state === 'FAILURE' || state === 'ERROR'
            ? 'fail'
            : 'pending',
      url: httpsUrl(row.targetUrl),
    };
  }
  const status = (row.status ?? '').toUpperCase();
  const conclusion = (row.conclusion ?? '').toUpperCase();
  let state: PullRequestCheck['state'];
  if (status && status !== 'COMPLETED') state = 'pending';
  else if (conclusion === 'SUCCESS' || conclusion === 'NEUTRAL') state = 'pass';
  else if (conclusion === 'SKIPPED' || conclusion === 'STALE') state = 'skipped';
  else if (!conclusion) state = 'pending';
  else state = 'fail'; // FAILURE, CANCELLED, TIMED_OUT, ACTION_REQUIRED, STARTUP_FAILURE
  return { name: row.name ?? 'Check', state, url: httpsUrl(row.detailsUrl) };
}

export function summarizeChecks(
  rows: z.infer<typeof checkRow>[] | null | undefined,
): PullRequestChecks {
  const items = (rows ?? []).map(checkOf);
  const count = (state: PullRequestCheck['state']) => items.filter((c) => c.state === state).length;
  const failing = count('fail');
  const pending = count('pending');
  const passing = count('pass');
  return {
    state: failing ? 'failing' : pending ? 'pending' : passing ? 'passing' : 'none',
    passing,
    failing,
    pending,
    skipped: count('skipped'),
    items,
  };
}

/**
 * GitHub's merge box, from gh's mergeable + mergeStateStatus. mergeStateStatus is BEHIND only when
 * the base requires up-to-date branches, BLOCKED when a requirement (checks, reviews) is unmet,
 * UNSTABLE when non-required checks fail, DIRTY on conflicts and UNKNOWN while GitHub computes it.
 */
export function mergeabilityOf(
  pr: Pick<PrRow, 'state' | 'isDraft' | 'mergeable' | 'mergeStateStatus' | 'reviewDecision'> & {
    autoMerge: boolean;
  },
  checks: PullRequestChecks,
  repo: PullRequestRepoSettings | null,
): PullRequestMergeability {
  const none = { canUpdateBranch: false, canAutoMerge: false, canBypass: false };
  if (pr.state !== 'OPEN') return { status: 'closed', canMerge: false, reason: null, ...none };
  if (repo && !repo.canPush)
    return {
      status: 'blocked',
      canMerge: false,
      reason: "You don't have write access to this repository.",
      ...none,
    };
  const mss = (pr.mergeStateStatus ?? 'UNKNOWN').toUpperCase();
  const mergeable = (pr.mergeable ?? 'UNKNOWN').toUpperCase();
  if (pr.isDraft)
    return {
      status: 'draft',
      canMerge: false,
      reason: 'This pull request is still a draft. Mark it ready for review to merge it.',
      ...none,
    };
  if (mergeable === 'CONFLICTING' || mss === 'DIRTY')
    return {
      status: 'conflicts',
      canMerge: false,
      reason: 'This branch has conflicts with the base branch that must be resolved.',
      ...none,
    };
  const autoMerge = !!repo?.allowAutoMerge && !pr.autoMerge;
  const bypass = !!repo?.isAdmin;
  if (mss === 'BEHIND')
    return {
      status: 'behind',
      canMerge: false,
      reason: 'This branch is out of date with the base branch.',
      canUpdateBranch: true,
      canAutoMerge: autoMerge,
      canBypass: bypass,
    };
  if (mss === 'BLOCKED') {
    const reason = checks.failing
      ? 'Required checks are failing.'
      : checks.pending
        ? 'Waiting for required checks to finish.'
        : pr.reviewDecision === 'CHANGES_REQUESTED'
          ? 'Changes were requested by a reviewer.'
          : pr.reviewDecision === 'REVIEW_REQUIRED'
            ? 'An approving review is required.'
            : 'Merging is blocked by branch protection rules.';
    return {
      status: 'blocked',
      canMerge: false,
      reason,
      canUpdateBranch: false,
      canAutoMerge: autoMerge,
      canBypass: bypass,
    };
  }
  if (mergeable === 'UNKNOWN' || mss === 'UNKNOWN')
    return {
      status: 'checking',
      canMerge: false,
      reason: 'GitHub is still checking whether this can merge. Refresh in a moment.',
      ...none,
    };
  // Mergeable now; auto-merge still makes sense while checks run (GitHub offers it then too).
  const pending = checks.pending > 0 && autoMerge;
  if (mss === 'UNSTABLE')
    return {
      status: 'unstable',
      canMerge: true,
      reason: checks.failing
        ? 'Some checks are failing (not required).'
        : 'Some checks have not finished (not required).',
      canUpdateBranch: false,
      canAutoMerge: pending,
      canBypass: false,
    };
  return {
    status: 'clean',
    canMerge: true,
    reason: null,
    canUpdateBranch: false,
    canAutoMerge: pending,
    canBypass: false,
  };
}

function repoSettingsOf(row: z.infer<typeof repoRow>): PullRequestRepoSettings {
  // GitHub only returns the allow_* settings to people with push access; when withheld, offer
  // every method and let gh report what the repo refuses.
  const known = [row.allow_merge_commit, row.allow_squash_merge, row.allow_rebase_merge];
  const unknown = known.every((v) => v === null || v === undefined);
  const mergeMethods = PR_MERGE_METHODS.filter((_, i) => unknown || known[i] === true);
  return {
    mergeMethods,
    allowAutoMerge: row.allow_auto_merge === true,
    deleteBranchOnMerge: row.delete_branch_on_merge === true,
    canPush: row.permissions?.push ?? true,
    isAdmin: row.permissions?.admin ?? false,
  };
}

async function repoSettings(cwd: string): Promise<PullRequestRepoSettings> {
  const { stdout } = await run('gh', ['api', 'repos/{owner}/{repo}'], { cwd, timeoutMs: 15_000 });
  return repoSettingsOf(repoRow.parse(JSON.parse(stdout)));
}

/** Names of every branch on the GitHub repo (null when they can't be listed). */
async function remoteBranches(cwd: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await run(
      'gh',
      ['api', '--paginate', 'repos/{owner}/{repo}/branches?per_page=100', '--jq', '.[].name'],
      { cwd, timeoutMs: 30_000 },
    );
    return new Set(stdout.split(/\r?\n/).filter(Boolean));
  } catch {
    return null;
  }
}

function methodOf(value: string | null | undefined): PullRequestMergeMethod | null {
  const lower = (value ?? '').toLowerCase();
  return (PR_MERGE_METHODS as readonly string[]).includes(lower)
    ? (lower as PullRequestMergeMethod)
    : null;
}

function toPullRequest(
  row: PrRow,
  repo: PullRequestRepoSettings | null,
  branches: Set<string> | null,
): PullRequest {
  const checks = summarizeChecks(row.statusCheckRollup);
  const autoMerge = row.autoMergeRequest
    ? { method: methodOf(row.autoMergeRequest.mergeMethod) }
    : null;
  return {
    number: row.number,
    title: row.title,
    url: row.url,
    author: row.author,
    state: row.state,
    isDraft: row.isDraft,
    headRefName: row.headRefName,
    headRefOid: row.headRefOid,
    baseRefName: row.baseRefName,
    isCrossRepository: row.isCrossRepository,
    headBranchExists: row.isCrossRepository
      ? null
      : row.state === 'OPEN'
        ? true
        : branches
          ? branches.has(row.headRefName)
          : null,
    updatedAt: row.updatedAt,
    closedAt: row.closedAt ?? null,
    mergedAt: row.mergedAt ?? null,
    reviewDecision: row.reviewDecision,
    autoMerge,
    checks,
    mergeability: mergeabilityOf({ ...row, autoMerge: !!autoMerge }, checks, repo),
  };
}

function ghErrorMessage(error: unknown, fallback: string): string {
  const e = error as Error & { code?: string; stderr?: string };
  if (e.code === 'ENOENT')
    return 'Install GitHub CLI (gh) and run gh auth login to use pull requests.';
  return e.stderr?.trim().slice(0, 1000) || fallback;
}

export async function pullRequests(
  cwd: string,
  state: PullRequestListState = 'open',
): Promise<PullRequestsResult> {
  try {
    const [{ stdout }, repo, branches] = await Promise.all([
      run('gh', ['pr', 'list', '--state', state, '--limit', '100', '--json', LIST_FIELDS], {
        cwd,
        timeoutMs: 30_000,
      }),
      repoSettings(cwd).catch(() => null),
      // Only closed PRs can have lost their head branch; open ones always have it.
      state === 'closed' ? remoteBranches(cwd) : Promise.resolve(null),
    ]);
    const requests = z
      .array(prRow)
      .parse(JSON.parse(stdout))
      .filter((p) => new URL(p.url).protocol === 'https:')
      .map((p) => toPullRequest(p, repo, branches));
    return { state, requests, repo, error: null, fetchedAt: new Date().toISOString() };
  } catch (error) {
    return {
      state,
      requests: [],
      repo: null,
      error: ghErrorMessage(
        error,
        'Could not load pull requests. Check gh auth status and the project GitHub remote.',
      ),
      fetchedAt: new Date().toISOString(),
    };
  }
}

// ---------------------------------------------------------------------------------------------
// Actions

const sha = z.string().regex(/^[0-9a-f]{40}$/i, 'headOid must be a commit SHA');

/** Request body for POST /projects/:id/pull-requests/:number/actions. */
export const pullRequestActionBody: z.ZodType<PullRequestAction> = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('merge'),
    method: z.enum(PR_MERGE_METHODS),
    deleteBranch: z.boolean().default(false),
    auto: z.boolean().default(false),
    admin: z.boolean().default(false),
    headOid: sha.optional(),
  }),
  z.object({ action: z.literal('disable-auto-merge') }),
  z.object({ action: z.literal('update-branch'), rebase: z.boolean().default(false) }),
  z.object({ action: z.literal('ready') }),
  z.object({ action: z.literal('draft') }),
  z.object({ action: z.literal('close'), deleteBranch: z.boolean().default(false) }),
  z.object({ action: z.literal('reopen') }),
  z.object({ action: z.literal('delete-branch') }),
  z.object({ action: z.literal('restore-branch') }),
]) as z.ZodType<PullRequestAction>;

/** PR numbers from the URL: digits only (no signs, exponents or hex), within GitHub's range. */
export function parsePullRequestNumber(value: string | undefined): number | null {
  if (!value || !/^[1-9]\d{0,9}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n <= 2_147_483_647 ? n : null;
}

export class PullRequestActionError extends Error {
  constructor(
    public status: 400 | 404 | 409 | 502,
    message: string,
  ) {
    super(message);
  }
}

const ACTION_TIMEOUT = 60_000;

async function gh(cwd: string, args: string[], fallback: string): Promise<string> {
  try {
    return (await run('gh', args, { cwd, timeoutMs: ACTION_TIMEOUT })).stdout;
  } catch (error) {
    throw new PullRequestActionError(502, ghErrorMessage(error, fallback));
  }
}

const viewRow = z.object({
  number: z.number().int().positive(),
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isDraft: z.boolean(),
  headRefName: z.string(),
  headRefOid: z.string(),
  isCrossRepository: z.boolean(),
});
type ViewRow = z.infer<typeof viewRow>;

async function viewPullRequest(cwd: string, number: number): Promise<ViewRow> {
  const stdout = await gh(
    cwd,
    [
      'pr',
      'view',
      String(number),
      '--json',
      'number,state,isDraft,headRefName,headRefOid,isCrossRepository',
    ],
    `Could not find pull request #${number}.`,
  );
  return viewRow.parse(JSON.parse(stdout));
}

/** A branch name as GitHub's API path wants it: each segment encoded, slashes kept. */
function refPath(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

function assertOwnBranch(pr: ViewRow): void {
  if (pr.isCrossRepository)
    throw new PullRequestActionError(
      409,
      `The head branch of #${pr.number} is in a fork, so it can't be managed from here.`,
    );
  // A name GitHub would never return, but a leading dash would read as an option to git.
  if (!pr.headRefName || pr.headRefName.startsWith('-'))
    throw new PullRequestActionError(409, `Unexpected branch name "${pr.headRefName}".`);
}

/**
 * Deletes a local branch only when nothing could be lost: it exists, isn't checked out (here or
 * in another worktree, which git itself refuses), and points at exactly the PR's head commit.
 */
async function deleteLocalBranch(cwd: string, pr: ViewRow): Promise<string> {
  let localOid: string;
  try {
    localOid = (
      await run('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${pr.headRefName}`], {
        cwd,
        timeoutMs: 15_000,
      })
    ).stdout.trim();
  } catch {
    return 'no local branch';
  }
  if (!localOid) return 'no local branch';
  const current = await run('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
    cwd,
    timeoutMs: 15_000,
  }).then(
    (r) => r.stdout.trim(),
    () => '',
  );
  if (current === pr.headRefName) return 'local branch kept: it is checked out';
  if (pr.headRefOid && localOid.toLowerCase() !== pr.headRefOid.toLowerCase())
    return 'local branch kept: it differs from the pull request head';
  try {
    await run('git', ['branch', '-D', '--', pr.headRefName], { cwd, timeoutMs: 15_000 });
    return 'local branch deleted';
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr?.trim().split('\n')[0];
    return `local branch kept: ${stderr || 'git refused to delete it'}`;
  }
}

async function deleteBranch(cwd: string, pr: ViewRow): Promise<string> {
  assertOwnBranch(pr);
  let remote = 'deleted on GitHub';
  try {
    await run(
      'gh',
      [
        'api',
        '--method',
        'DELETE',
        `repos/{owner}/{repo}/git/refs/heads/${refPath(pr.headRefName)}`,
      ],
      { cwd, timeoutMs: ACTION_TIMEOUT },
    );
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    // 422 "Reference does not exist": already gone (e.g. the repo deletes branches on merge).
    if (/reference does not exist|HTTP 422|HTTP 404/i.test(stderr))
      remote = 'already gone on GitHub';
    else
      throw new PullRequestActionError(502, ghErrorMessage(error, 'Could not delete the branch.'));
  }
  const local = await deleteLocalBranch(cwd, pr);
  return `Branch ${pr.headRefName}: ${remote}; ${local}.`;
}

/** Runs one validated action on PR #number in the project folder. */
export async function pullRequestAction(
  cwd: string,
  number: number,
  action: PullRequestAction,
): Promise<PullRequestActionResult> {
  const n = String(number);
  const done = (message: string): PullRequestActionResult => ({ ok: true, message });
  switch (action.action) {
    case 'merge': {
      const repo = await repoSettings(cwd).catch(() => null);
      if (repo && !repo.mergeMethods.includes(action.method))
        throw new PullRequestActionError(
          400,
          `This repository doesn't allow ${action.method} merges.`,
        );
      if (action.auto && repo && !repo.allowAutoMerge)
        throw new PullRequestActionError(400, "This repository doesn't allow auto-merge.");
      const pr = await viewPullRequest(cwd, number);
      if (pr.state !== 'OPEN')
        throw new PullRequestActionError(409, `#${number} is already ${pr.state.toLowerCase()}.`);
      // Never --delete-branch: gh would also check out the base branch in the project folder.
      const args = ['pr', 'merge', n, `--${action.method}`];
      if (action.auto) args.push('--auto');
      if (action.admin) args.push('--admin');
      if (action.headOid) args.push('--match-head-commit', action.headOid);
      await gh(cwd, args, `Could not merge #${number}.`);
      if (action.auto)
        return done(`Auto-merge enabled for #${number}: it merges once its requirements pass.`);
      const branch = action.deleteBranch ? ` ${await deleteBranch(cwd, pr)}` : '';
      return done(`Merged #${number}.${branch}`);
    }
    case 'disable-auto-merge':
      await gh(cwd, ['pr', 'merge', n, '--disable-auto'], `Could not disable auto-merge.`);
      return done(`Auto-merge disabled for #${number}.`);
    case 'update-branch':
      await gh(
        cwd,
        ['pr', 'update-branch', n, ...(action.rebase ? ['--rebase'] : [])],
        `Could not update the branch of #${number}.`,
      );
      return done(
        `Updated the branch of #${number} with its base${action.rebase ? ' (rebased)' : ''}.`,
      );
    case 'ready':
      await gh(cwd, ['pr', 'ready', n], `Could not mark #${number} ready.`);
      return done(`#${number} is ready for review.`);
    case 'draft':
      await gh(cwd, ['pr', 'ready', n, '--undo'], `Could not convert #${number} to a draft.`);
      return done(`#${number} is now a draft.`);
    case 'close': {
      const pr = action.deleteBranch ? await viewPullRequest(cwd, number) : null;
      // Never gh's own --delete-branch here either (it can switch the project's checkout).
      await gh(cwd, ['pr', 'close', n], `Could not close #${number}.`);
      const branch = pr ? ` ${await deleteBranch(cwd, pr)}` : '';
      return done(`Closed #${number}.${branch}`);
    }
    case 'reopen':
      await gh(cwd, ['pr', 'reopen', n], `Could not reopen #${number}.`);
      return done(`Reopened #${number}.`);
    case 'delete-branch': {
      const pr = await viewPullRequest(cwd, number);
      if (pr.state === 'OPEN')
        throw new PullRequestActionError(
          409,
          `#${number} is still open: deleting its branch would close it. Merge or close it first.`,
        );
      return done(await deleteBranch(cwd, pr));
    }
    case 'restore-branch': {
      const pr = await viewPullRequest(cwd, number);
      assertOwnBranch(pr);
      if (!/^[0-9a-f]{40}$/i.test(pr.headRefOid))
        throw new PullRequestActionError(409, `GitHub returned no head commit for #${number}.`);
      await gh(
        cwd,
        [
          'api',
          '--method',
          'POST',
          'repos/{owner}/{repo}/git/refs',
          '-f',
          `ref=refs/heads/${pr.headRefName}`,
          '-f',
          `sha=${pr.headRefOid}`,
        ],
        `Could not restore ${pr.headRefName}.`,
      );
      return done(`Restored branch ${pr.headRefName} on GitHub at ${pr.headRefOid.slice(0, 7)}.`);
    }
  }
}

const refRows = z.array(
  z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable().optional(),
    headRefName: z.string(),
    state: z.string(),
    createdAt: z.string(),
    mergedAt: z.string().nullable().optional(),
    closingIssuesReferences: z.array(z.object({ url: z.string() })).optional(),
  }),
);

/**
 * Recent pull requests (open, merged and closed) as board events: an open PR referencing a card
 * (title, description or branch name) and, once merged, the merge. Null when gh is missing, not
 * signed in, or the project has no GitHub remote.
 */
export async function pullRequestEvents(cwd: string): Promise<RefEvent[] | null> {
  try {
    const { stdout } = await run(
      'gh',
      [
        'pr',
        'list',
        '--state',
        'all',
        '--limit',
        '50',
        '--json',
        'number,title,body,headRefName,state,createdAt,mergedAt,closingIssuesReferences',
      ],
      { cwd, timeoutMs: 20_000 },
    );
    return refRows.parse(JSON.parse(stdout)).flatMap((pr): RefEvent[] => {
      const text = `${pr.title}\n${pr.body ?? ''}\n${pr.headRefName}\n${(pr.closingIssuesReferences ?? []).map((issue) => `Closes ${issue.url}`).join('\n')}`;
      const source = `PR #${pr.number}`;
      const opened: RefEvent = {
        id: `pr:${pr.number}:open`,
        kind: 'pr-open',
        at: pr.createdAt,
        text,
        source,
      };
      if (pr.state === 'MERGED' && pr.mergedAt) {
        const merged: RefEvent = {
          id: `pr:${pr.number}:merged`,
          kind: 'pr-merged',
          at: pr.mergedAt,
          issueClosures: (pr.closingIssuesReferences ?? []).map((issue) => issue.url),
          text,
          source,
        };
        return [opened, merged];
      }
      return pr.state === 'OPEN' ? [opened] : []; // Closed unmerged: no move.
    });
  } catch {
    return null;
  }
}
