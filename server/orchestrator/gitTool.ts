import { execFile } from 'node:child_process';
import type { Db } from '../db.js';
import { redactTokens } from '../ghAccount.js';
import { projectGitEnv } from '../gitIdentity.js';

/*
 * The orchestrator chat's git and gh access when the owner turns on "Git on its own" (PM-428).
 * One tool instead of one per operation, so pushing, pull requests, merges and branch work all run
 * the same way: in the project folder, with the project's own commit author and GitHub account
 * (the env a project's agent sessions get, PM-186), never through a shell. A short list of
 * destructive forms is refused whatever the setting: force pushes, pushing to another remote URL,
 * deleting the main branch, discarding uncommitted work, history rewrites that need a force push,
 * skipping hooks, and deleting or transferring repositories.
 */

export type GitProgram = 'git' | 'gh';

const GIT_COMMANDS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'fetch',
  'pull',
  'push',
  'branch',
  'checkout',
  'switch',
  'merge',
  'rebase',
  'commit',
  'add',
  'tag',
  'stash',
  'cherry-pick',
  'revert',
  'remote',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
  'shortlog',
  'worktree',
  'restore',
  'reset',
  'mv',
  'rm',
]);
/** Commands that only read: not recorded in Activity. */
const GIT_READS = new Set([
  'status',
  'log',
  'diff',
  'show',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
  'shortlog',
]);
const GH_COMMANDS = new Set([
  'pr',
  'issue',
  'run',
  'workflow',
  'repo',
  'release',
  'label',
  'status',
]);
const GH_READS = new Set(['list', 'view', 'status', 'diff', 'checks']);
const MAIN_BRANCHES = /^(refs\/heads\/)?(main|master|trunk|develop)$/;
/** Options that make git run another program, or write outside the repository. */
const EXEC_OPTIONS = /^(--exec|--upload-pack|--receive-pack|--output|--git-dir|--work-tree)(=|$)/;

const has = (args: readonly string[], ...flags: string[]) => args.some((a) => flags.includes(a));

/** Why this command is refused, or null when it may run. Pure, so every rule is tested. */
export function gitCommandBlock(program: GitProgram, args: readonly string[]): string | null {
  const [command, ...rest] = args;
  if (!command) return 'Give a command';
  if (program === 'gh') {
    if (!GH_COMMANDS.has(command))
      return `gh ${command} is not available; use pr, issue, run, workflow, repo, release, label or status`;
    if (has(rest, 'delete', 'transfer', 'archive', 'rename', 'unarchive'))
      return 'Deleting, transferring, archiving or renaming is left to the owner';
    if (command === 'repo' && !has(rest, 'view', 'list')) return 'gh repo is read-only here';
    if (command === 'run' && has(rest, 'download')) return 'gh run download writes files; not here';
    if (command === 'pr' && rest[0] === 'merge') {
      if (has(rest, '--admin')) return 'Merging past branch protection (--admin) is refused';
      // gh switches the project's checkout to delete the branch (AGENTS.md); never use it here.
      if (rest.some((a) => a === '-d' || a.startsWith('--delete-branch')))
        return 'Never use --delete-branch: delete the branch with git after the merge';
    }
    return null;
  }
  if (command.startsWith('-')) return 'Start with the git command; global options are refused';
  if (!GIT_COMMANDS.has(command)) return `git ${command} is not available here`;
  if (rest.some((a) => EXEC_OPTIONS.test(a))) return 'That option runs another program; refused';
  if (
    (command === 'commit' || command === 'push') &&
    (has(rest, '--no-verify') || (command === 'commit' && has(rest, '-n')))
  )
    return 'Hooks are never skipped';
  switch (command) {
    case 'push': {
      if (rest.some((a) => /^--force/.test(a) || a === '-f' || a === '--mirror' || a === '--prune'))
        return 'Force pushes are refused';
      if (rest.some((a) => a.startsWith('+'))) return 'Force pushes (+refspec) are refused';
      // Only the project's configured remotes: a URL would send the code somewhere new.
      if (rest.some((a) => /^[a-z][a-z0-9+.-]*:\/\/|^[^\s/]+@[^\s:]+:/i.test(a)))
        return 'Push to a configured remote by name, not a URL';
      const deleting = has(rest, '--delete', '-d');
      const refs = rest.filter((a) => !a.startsWith('-'));
      if (
        refs.some(
          (r) =>
            (r.startsWith(':') && MAIN_BRANCHES.test(r.slice(1))) ||
            (deleting && MAIN_BRANCHES.test(r)),
        )
      )
        return 'Deleting the main branch is refused';
      return null;
    }
    case 'branch':
      if (has(rest, '-D', '-f', '--force', '-M', '-C'))
        return 'Forced branch changes are refused; -d deletes merged branches only';
      if (has(rest, '-d', '--delete') && rest.some((a) => MAIN_BRANCHES.test(a)))
        return 'Deleting the main branch is refused';
      return null;
    case 'checkout':
      // "git checkout <name>" discards a file's changes when no branch has that name.
      if (rest[0] !== '-b' || rest.length > 3 || has(rest, '--', '.'))
        return 'Use git switch for branches; checkout is allowed only as checkout -b <new> [start]';
      return null;
    case 'switch':
      if (has(rest, '-f', '--force', '--discard-changes', '-C'))
        return 'Discarding uncommitted work is refused';
      return null;
    case 'restore':
      if (!has(rest, '--staged', '-S') || has(rest, '--worktree', '-W'))
        return 'Restoring files discards their changes; only --staged is allowed';
      return null;
    case 'reset':
      if (has(rest, '--hard', '--merge', '--keep'))
        return 'Discarding commits or changes is refused';
      return null;
    case 'rm':
      if (has(rest, '-f', '--force')) return 'Forced removal discards changes; refused';
      return null;
    case 'stash':
      if (has(rest, 'drop', 'clear')) return 'Dropping stashes is refused';
      return null;
    case 'rebase':
      if (has(rest, '-i', '--interactive', '-x')) return 'Interactive or exec rebases are refused';
      return null;
    case 'tag':
      if (has(rest, '-d', '--delete', '-f', '--force')) return 'Deleting or moving tags is refused';
      return null;
    case 'remote':
      if (rest.length && !has(rest, '-v', 'show', 'get-url'))
        return 'Remotes are read-only here (-v, show, get-url)';
      return null;
    case 'worktree':
      if (!has(rest, 'list', 'add')) return 'Only git worktree list and add are available';
      return null;
  }
  return null;
}

/** Whether the command changes something (recorded in Activity), as opposed to only reading. */
export function gitCommandWrites(program: GitProgram, args: readonly string[]): boolean {
  if (program === 'gh') return !GH_READS.has(args[1] ?? '') && args[0] !== 'status';
  if (GIT_READS.has(args[0] ?? '')) return false;
  if (args[0] === 'branch' || args[0] === 'tag' || args[0] === 'remote' || args[0] === 'stash')
    return args.length > 1 && !has(args.slice(1), '-a', '-r', '-v', '--list', '-l', 'list', 'show');
  return true;
}

const tail = (text: string, max: number) =>
  text.length > max ? `…${text.slice(text.length - max)}` : text;

/** Runs an allowed git or gh command in the project folder as the project's identity. */
export async function runProjectGit(
  db: Db,
  project: { id: number; path: string },
  program: GitProgram,
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const block = gitCommandBlock(program, args);
  if (block) throw new Error(block);
  const identity = await projectGitEnv(db, project);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...identity,
    GIT_TERMINAL_PROMPT: '0',
    GH_PROMPT_DISABLED: '1',
    GIT_EDITOR: 'true',
  };
  return new Promise((resolve) => {
    execFile(
      program,
      [...args],
      { cwd: project.path, env, timeout: 180_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        resolve({
          exitCode: error ? (typeof code === 'number' ? code : 1) : 0,
          stdout: tail(redactTokens(String(stdout), env), 8000),
          stderr: tail(
            redactTokens(
              String(stderr || (error && typeof code !== 'number' ? error.message : '')),
              env,
            ),
            4000,
          ),
        });
      },
    );
  });
}
