import { run } from './analysis/exec.js';
import type { PullRequestAccount } from '../shared/types.js';

/*
 * Which GitHub account a project's gh calls run as. gh acts as its one *active* account, but this
 * machine may have several logged in (`gh auth login` twice), and some repos must be acted on by
 * their owner: Vercel's Hobby plan, for one, refuses to deploy commits merged by anyone else.
 *
 * So each call runs as the logged-in account whose login equals the repo owner, through GH_TOKEN
 * in that child process's environment only. The global active account is never switched, tokens
 * are never written to disk or logged, and nothing here is ever sent to the client: callers get a
 * `GhIdentity` whose `env` stays on the server and whose `account` is the client-safe summary.
 */

const HOST = 'github.com';
/** An account switch (or a new login) is picked up within this long. */
const CACHE_MS = 60_000;

export interface GhLogin {
  login: string;
  active: boolean;
}

export interface GhIdentity {
  /** Safe to send to the client: no token in it. */
  account: PullRequestAccount;
  /** Child-process environment for gh (GH_TOKEN set), or undefined for gh's active account. */
  env: NodeJS.ProcessEnv | undefined;
}

/** A resolution failure whose message is safe to show (it never contains a token). */
export class GhAccountError extends Error {
  constructor(
    message: string,
    /** What was resolved before it failed, so the tab can still show and change the account. */
    public account: PullRequestAccount | null = null,
  ) {
    super(message);
  }
}

interface Cached<T> {
  at: number;
  value: Promise<T>;
}
let accountsCache: Cached<GhLogin[]> | null = null;
const tokenCache = new Map<string, Cached<string>>();

/** Forget cached accounts and tokens (tests; also after the user changes an override). */
export function resetGhAccountCache(): void {
  accountsCache = null;
  tokenCache.clear();
}

function fresh<T>(entry: Cached<T> | null | undefined): entry is Cached<T> {
  return !!entry && Date.now() - entry.at < CACHE_MS;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** `gh auth status --json hosts` (gh 2.73+): every account, with which one is active. */
function parseStatusJson(stdout: string): GhLogin[] | null {
  try {
    const parsed = JSON.parse(stdout) as {
      hosts?: Record<string, { login?: unknown; active?: unknown }[]>;
    };
    const rows = parsed.hosts?.[HOST];
    if (!parsed.hosts || !Array.isArray(rows)) return parsed.hosts ? [] : null;
    return rows
      .filter((r) => typeof r.login === 'string' && LOGIN.test(r.login))
      .map((r) => ({ login: r.login as string, active: r.active === true }));
  } catch {
    return null;
  }
}

/** The human-readable `gh auth status` of older gh versions (stdout, or stderr before 2.40). */
export function parseStatusText(text: string): GhLogin[] {
  const out: GhLogin[] = [];
  for (const line of text.split(/\r?\n/)) {
    const login = /Logged in to (\S+) (?:account|as) ([A-Za-z0-9-]+)/.exec(line);
    if (login) {
      if (login[1] === HOST && LOGIN.test(login[2]!)) out.push({ login: login[2]!, active: false });
      continue;
    }
    const last = out[out.length - 1];
    if (last && /Active account:\s*true/i.test(line)) last.active = true;
  }
  // Single-account gh (before 2.40) prints no "Active account" line: that one is active.
  if (out.length === 1) out[0]!.active = true;
  return out;
}

async function loadAccounts(): Promise<GhLogin[]> {
  const json = await run('gh', ['auth', 'status', '--json', 'hosts'], { timeoutMs: 20_000 }).then(
    (r) => parseStatusJson(r.stdout),
    () => null,
  );
  if (json) return json;
  // gh without --json (or a failing status): read the text form, which may be on either stream
  // and comes with exit code 1 when any account's token is invalid.
  const text = await run('gh', ['auth', 'status', '--hostname', HOST], { timeoutMs: 20_000 }).then(
    (r) => `${r.stdout}\n${r.stderr}`,
    (error: unknown) => {
      const e = error as { stdout?: string; stderr?: string };
      return `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
    },
  );
  return parseStatusText(text);
}

/** The gh accounts logged in to github.com, cached for a minute. Empty when gh is missing. */
export function ghAccounts(options: { refresh?: boolean } = {}): Promise<GhLogin[]> {
  if (!options.refresh && fresh(accountsCache)) return accountsCache.value;
  const value = loadAccounts().catch(() => []);
  accountsCache = { at: Date.now(), value };
  return value;
}

function ghToken(login: string): Promise<string> {
  const cached = tokenCache.get(login);
  if (fresh(cached)) return cached.value;
  const value = run('gh', ['auth', 'token', '--hostname', HOST, '--user', login], {
    timeoutMs: 15_000,
  }).then(
    (r) => {
      const token = r.stdout.trim();
      if (!token || /\s/.test(token)) throw new Error('empty token');
      return token;
    },
    () => {
      // gh's own error is not passed on: keep messages free of anything gh might print.
      throw new GhAccountError(
        `Could not read the gh token for ${login}. Run gh auth status, and gh auth login as ${login} if it is missing.`,
      );
    },
  );
  // A failed lookup isn't cached, so a fixed login is picked up on the next try.
  value.catch(() => tokenCache.delete(login));
  tokenCache.set(login, { at: Date.now(), value });
  return value;
}

/** owner/repo from a github.com remote URL (https, ssh or scp-like), or null. */
export function githubRepoOf(url: string): { owner: string; repo: string } | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|git:\/\/|[^@/:]+@)github\.com[:/]+([A-Za-z0-9-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(
      url.trim(),
    );
  return match ? { owner: match[1]!, repo: match[2]! } : null;
}

/**
 * The repo gh resolves `{owner}/{repo}` to in this folder: `gh repo set-default` when set,
 * otherwise the remotes in gh's own order of preference (upstream, github, origin, then the rest).
 */
export async function repoOwner(cwd: string): Promise<string | null> {
  const chosen = await run('gh', ['repo', 'set-default', '--view'], {
    cwd,
    timeoutMs: 15_000,
  }).then(
    (r) => /^([A-Za-z0-9-]+)\/[A-Za-z0-9_.-]+$/.exec(r.stdout.trim())?.[1] ?? null,
    () => null,
  );
  if (chosen) return chosen;
  const remotes = await run('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], {
    cwd,
    timeoutMs: 15_000,
  }).then(
    (r) => r.stdout,
    () => '',
  );
  const rank = (name: string) => {
    const i = ['upstream', 'github', 'origin'].indexOf(name);
    return i === -1 ? 3 : i;
  };
  const found = remotes
    .split(/\r?\n/)
    .map((line) => /^remote\.(.+)\.url\s+(.+)$/.exec(line.trim()))
    .flatMap((m) => {
      const repo = m ? githubRepoOf(m[2]!) : null;
      return m && repo ? [{ name: m[1]!, owner: repo.owner }] : [];
    })
    .sort((a, b) => rank(a.name) - rank(b.name));
  return found[0]?.owner ?? null;
}

/** Whether `login` is one of the logged-in accounts (re-reads gh once if it isn't cached yet). */
export async function isLoggedIn(login: string): Promise<boolean> {
  const has = (list: GhLogin[]) => list.some((a) => a.login.toLowerCase() === login.toLowerCase());
  return has(await ghAccounts()) || has(await ghAccounts({ refresh: true }));
}

/**
 * Who gh should act as in this project folder: the per-project override when one is set, else
 * the logged-in account that owns the repo, else gh's active account (no GH_TOKEN). Throws
 * GhAccountError when the account it must use can't be used (an override that logged out, or a
 * token that can't be read): silently acting as another account is exactly the bug this avoids.
 */
export async function resolveGhIdentity(
  cwd: string,
  override: string | null = null,
): Promise<GhIdentity> {
  const [accounts, owner] = await Promise.all([ghAccounts(), repoOwner(cwd)]);
  const logins = accounts.map((a) => a.login);
  const active = accounts.find((a) => a.active)?.login ?? null;
  const find = (login: string | null) =>
    login ? (logins.find((l) => l.toLowerCase() === login.toLowerCase()) ?? null) : null;
  const base = { owner, accounts: logins, override };

  let login: string | null;
  let source: PullRequestAccount['source'];
  if (override) {
    login = find(override);
    if (!login)
      throw new GhAccountError(
        `The GitHub account chosen for this project (${override}) is not logged in to gh. Pick another account, or run gh auth login.`,
        { ...base, login: null, source: 'override' },
      );
    source = 'override';
  } else if (find(owner)) {
    login = find(owner);
    source = 'owner';
  } else {
    return { account: { ...base, login: active, source: 'active' }, env: undefined };
  }
  // With one account there is nothing to choose between: gh already acts as it.
  if (accounts.length < 2) return { account: { ...base, login, source }, env: undefined };
  let token: string;
  try {
    token = await ghToken(login!);
  } catch (error) {
    const message =
      error instanceof GhAccountError ? error.message : 'Could not read the gh token.';
    throw new GhAccountError(message, { ...base, login, source });
  }
  return {
    account: { ...base, login, source },
    env: { ...process.env, GH_TOKEN: token },
  };
}

/** Removes anything token-shaped from text bound for the client or a log. */
export function redactTokens(text: string, env?: NodeJS.ProcessEnv): string {
  let out = text.replace(/\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{16,}/g, '[redacted]');
  const token = env?.GH_TOKEN;
  if (token && token.length >= 8) out = out.split(token).join('[redacted]');
  return out;
}

/** Settings key for a project's chosen gh account (the Pull requests tab's override). */
export function ghAccountSettingKey(projectId: number): string {
  return `gh-account:${projectId}`;
}

/** A GitHub login as gh prints it: what an override must look like before it's even checked. */
export const GH_LOGIN = LOGIN;
