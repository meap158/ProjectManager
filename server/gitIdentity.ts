import type { Db } from './db.js';
import { getSetting } from './store.js';
import { GhAccountError, ghAccountSettingKey, resolveGhIdentity } from './ghAccount.js';

/*
 * Which git identity an agent acts as in a project (PM-186). Two parts, both applied only to the
 * environment of that project's agent sessions and runs: the commit author (name and email, as
 * GIT_AUTHOR_* / GIT_COMMITTER_*) and the GitHub account (the same choice the Pull requests tab
 * uses, as GH_TOKEN plus gh's git credential helper, so `git push` and `gh pr create` use it).
 * Nothing is written to the project's .git/config and no token is stored: ProjectManager never
 * changes files inside a tracked project, and a token only ever lives in the child's environment.
 */

export interface GitIdentity {
  name: string | null;
  email: string | null;
}

export function gitIdentitySettingKey(projectId: number): string {
  return `git-identity:${projectId}`;
}

const CONTROL = /[\p{Cc}<>]/u;
const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

/** A name or email as it may be stored: trimmed, or an explanation of what is wrong. */
export function validateGitIdentity(input: {
  name?: string | null;
  email?: string | null;
}): { ok: true; value: GitIdentity } | { ok: false; error: string } {
  const name = input.name?.trim() || null;
  const email = input.email?.trim() || null;
  if (name && (name.length > 100 || CONTROL.test(name)))
    return { ok: false, error: 'The commit name must be under 100 characters, without < or >.' };
  if (email && (email.length > 200 || !EMAIL.test(email)))
    return { ok: false, error: 'The commit email is not a valid address.' };
  if (!!name !== !!email)
    return { ok: false, error: 'Set both the commit name and the commit email, or neither.' };
  return { ok: true, value: { name, email } };
}

export function getGitIdentity(db: Db, projectId: number): GitIdentity {
  const stored = getSetting<Partial<GitIdentity>>(db, gitIdentitySettingKey(projectId));
  const checked = validateGitIdentity(stored ?? {});
  return checked.ok ? checked.value : { name: null, email: null };
}

/** The environment that makes git and gh act as `identity` / `ghToken`; empty when neither is set. */
export function gitIdentityEnv(
  identity: GitIdentity,
  ghToken: string | null,
  inherited: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  if (identity.name && identity.email) {
    env.GIT_AUTHOR_NAME = identity.name;
    env.GIT_COMMITTER_NAME = identity.name;
    env.GIT_AUTHOR_EMAIL = identity.email;
    env.GIT_COMMITTER_EMAIL = identity.email;
  }
  if (ghToken) {
    env.GH_TOKEN = ghToken;
    // GIT_CONFIG_* appends to any the user already set; an empty helper first drops other
    // helpers (a stored login for another account) so git asks gh, which answers with GH_TOKEN.
    const base = Number.parseInt(inherited.GIT_CONFIG_COUNT ?? '', 10);
    const n = Number.isInteger(base) && base >= 0 ? base : 0;
    env.GIT_CONFIG_COUNT = String(n + 2);
    env[`GIT_CONFIG_KEY_${n}`] = 'credential.https://github.com.helper';
    env[`GIT_CONFIG_VALUE_${n}`] = '';
    env[`GIT_CONFIG_KEY_${n + 1}`] = 'credential.https://github.com.helper';
    env[`GIT_CONFIG_VALUE_${n + 1}`] = '!gh auth git-credential';
  }
  return env;
}

/**
 * The identity environment for a project's agent processes. A GitHub account that can't be used
 * (logged out, token unreadable) is logged and skipped rather than blocking the launch: the
 * commit author still applies, and the Pull requests tab shows the account problem.
 */
export async function projectGitEnv(
  db: Db,
  project: { id: number; path: string },
): Promise<Record<string, string>> {
  const identity = getGitIdentity(db, project.id);
  let token: string | null = null;
  try {
    const gh = await resolveGhIdentity(
      project.path,
      getSetting<string>(db, ghAccountSettingKey(project.id)),
    );
    token = gh.env?.GH_TOKEN ?? null;
  } catch (error) {
    if (!(error instanceof GhAccountError)) console.error('[git-identity] gh lookup failed');
    else console.error(`[git-identity] project ${project.id}: ${error.message}`);
  }
  return gitIdentityEnv(identity, token);
}
