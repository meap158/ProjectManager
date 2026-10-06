import type { CommitSummary, Contributor, GitStats } from '../../shared/types.js';
import { isGitRepo } from './fileList.js';
import { run } from './exec.js';

// ASCII unit/record separators keep parsing unambiguous whatever the commit messages contain.
const US = '\x1f';
const RS = '\x1e';

export const EMPTY_GIT_STATS: GitStats = {
  isRepo: false,
  branch: null,
  remoteUrl: null,
  totalCommits: 0,
  firstCommitAt: null,
  lastCommitAt: null,
  contributors: [],
  dailyCommits: {},
  recentCommits: [],
};

export interface RawCommit {
  hash: string;
  /** Author date, ISO 8601 with the author's offset. */
  date: string;
  author: string;
  email: string;
  subject: string;
}

export async function scanGit(root: string): Promise<GitStats> {
  if (!(await isGitRepo(root))) return EMPTY_GIT_STATS;

  const [branch, remoteUrl, log, status, upstream] = await Promise.all([
    gitOrNull(root, ['rev-parse', '--abbrev-ref', 'HEAD']),
    gitOrNull(root, ['remote', 'get-url', 'origin']),
    // `-- .` limits history to this folder when the project is a subfolder of a larger repo.
    gitOrNull(root, ['log', `--format=%H${US}%aI${US}%an${US}%ae${US}%s${RS}`, '--', '.']),
    gitOrNull(root, ['status', '--porcelain=v1', '--untracked-files=all', '--', '.']),
    // "behind<TAB>ahead" relative to the upstream; fails (null) when there is none.
    gitOrNull(root, ['rev-list', '--left-right', '--count', '@{upstream}...HEAD']),
  ]);

  return {
    ...summarizeCommits(parseLog(log ?? '')),
    isRepo: true,
    branch,
    remoteUrl,
    ...parseWorkingState(status, upstream),
  };
}

/** Uncommitted files and ahead/behind counts for the "needs attention" view. */
export function parseWorkingState(
  status: string | null,
  upstream: string | null,
): { dirtyFiles: number; ahead: number | null; behind: number | null } {
  const dirtyFiles = status ? status.split(/\r?\n/).filter((l) => l.trim()).length : 0;
  const counts = upstream?.trim().split(/\s+/).map(Number);
  const valid = counts?.length === 2 && counts.every(Number.isFinite);
  return {
    dirtyFiles,
    behind: valid ? counts![0]! : null,
    ahead: valid ? counts![1]! : null,
  };
}

export function parseLog(output: string): RawCommit[] {
  return output
    .split(RS)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', date = '', author = '', email = '', subject = ''] = record.split(US);
      return { hash, date, author, email, subject };
    });
}

/** Aggregates newest-first commits into the stats shown on the overview page. */
export function summarizeCommits(
  commits: RawCommit[],
): Omit<GitStats, 'isRepo' | 'branch' | 'remoteUrl'> {
  const dailyCommits: Record<string, number> = {};
  const contributors = new Map<string, Contributor>();

  for (const commit of commits) {
    // The author's local calendar date, as GitHub's contribution graph shows it.
    const day = commit.date.slice(0, 10);
    dailyCommits[day] = (dailyCommits[day] ?? 0) + 1;
    const key = commit.email.toLowerCase() || commit.author;
    const c = contributors.get(key) ?? { name: commit.author, email: commit.email, commits: 0 };
    c.commits++;
    contributors.set(key, c);
  }

  const recentCommits: CommitSummary[] = commits.slice(0, 15).map((c) => ({
    hash: c.hash,
    date: c.date,
    author: c.author,
    subject: c.subject,
  }));

  return {
    totalCommits: commits.length,
    firstCommitAt: commits.at(-1)?.date ?? null,
    lastCommitAt: commits[0]?.date ?? null,
    contributors: [...contributors.values()].sort((a, b) => b.commits - a.commits).slice(0, 10),
    dailyCommits,
    recentCommits,
  };
}

export interface CommitMessage {
  hash: string;
  /** Committer date (moves monotonically with history, unlike author date). */
  committedAt: string;
  message: string;
}

/** Full commit messages committed after `since` (ISO), oldest first. */
/**
 * Commit messages since a time, oldest first. `revisions` picks the history (default: HEAD), e.g.
 * `['main']`, or `['--branches', '--not', 'main']` for commits only on other local branches.
 */
export async function commitMessagesSince(
  root: string,
  since: string,
  revisions: string[] = [],
): Promise<CommitMessage[]> {
  const out = await gitOrNull(root, [
    'log',
    ...revisions,
    '--reverse',
    `--since=${since}`,
    `--format=%H${US}%cI${US}%B${RS}`,
    '--',
    '.',
  ]);
  return (out ?? '')
    .split(RS)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash = '', committedAt = '', message = ''] = record.split(US);
      return { hash, committedAt, message };
    });
}

/**
 * The branch work lands on: origin's default branch when known (and present locally), else
 * main / master, else whatever is checked out. Null outside a repo.
 */
export async function defaultBranch(root: string): Promise<string | null> {
  const remote = (await gitOrNull(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']))
    ?.trim()
    .replace(/^origin\//, '');
  for (const name of [remote, 'main', 'master']) {
    if (name && (await gitOrNull(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])))
      return name;
  }
  return (await gitOrNull(root, ['rev-parse', '--abbrev-ref', 'HEAD']))?.trim() || null;
}

/** Local branches with their tip's commit time. */
export async function localBranches(root: string): Promise<{ name: string; at: string }[]> {
  const out = await gitOrNull(root, [
    'for-each-ref',
    `--format=%(refname:short)${US}%(committerdate:iso-strict)`,
    'refs/heads',
  ]);
  return (out ?? '')
    .split('\n')
    .map((line) => line.trim().split(US))
    .filter((parts): parts is [string, string] => !!parts[0] && !!parts[1])
    .map(([name, at]) => ({ name, at }));
}

/** The origin remote's URL, or null. */
export async function originUrl(root: string): Promise<string | null> {
  return (await gitOrNull(root, ['remote', 'get-url', 'origin']))?.trim() || null;
}

/** Changes whenever any local branch moves (cheap enough to poll every few seconds). */
export async function branchesFingerprint(root: string): Promise<string | null> {
  return gitOrNull(root, ['for-each-ref', '--format=%(objectname) %(refname)', 'refs/heads']);
}

/** The current HEAD commit hash, or null outside a repo / before the first commit. */
export async function headCommit(root: string): Promise<string | null> {
  const out = await gitOrNull(root, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return out?.trim() || null;
}

async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run('git', ['-c', 'core.quotepath=off', ...args], { cwd });
    return stdout.trim() || null;
  } catch {
    return null; // e.g. no commits yet, no "origin" remote.
  }
}
