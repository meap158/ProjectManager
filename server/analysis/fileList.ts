import { opendir } from 'node:fs/promises';
import path from 'node:path';
import { isAvailable, run } from './exec.js';

/** Directories skipped when a folder is not a git repository (git uses .gitignore instead). */
export const DEFAULT_IGNORED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'bower_components',
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.cache',
  '.parcel-cache',
  'coverage',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.idea',
  '.vs',
  '.vscode',
  '.gradle',
  'Library',
  'Temp',
]);

export const MAX_SOURCE_FILES = 50_000;

export interface SourceFileList {
  /** Paths relative to the root, forward slashes. */
  files: string[];
  fromGit: boolean;
  truncated: boolean;
}

/**
 * Lists the project's "source" files: for git repos, tracked plus untracked-but-not-ignored files
 * (so .gitignore is honoured); otherwise a walk that skips well-known dependency/build folders.
 */
export async function listSourceFiles(root: string): Promise<SourceFileList> {
  if (await isGitRepo(root)) {
    try {
      const { stdout } = await run(
        'git',
        [
          '-c',
          'core.quotepath=off',
          'ls-files',
          '-z',
          '--cached',
          '--others',
          '--exclude-standard',
        ],
        { cwd: root },
      );
      // ls-files lists deleted-but-tracked files too; existence is checked when stat-ing later.
      const files = [...new Set(stdout.split('\0').filter(Boolean))];
      const truncated = files.length > MAX_SOURCE_FILES;
      return { files: files.slice(0, MAX_SOURCE_FILES), fromGit: true, truncated };
    } catch {
      // Fall through to the filesystem walk (e.g. "dubious ownership" errors).
    }
  }
  return walkSourceFiles(root);
}

async function walkSourceFiles(root: string): Promise<SourceFileList> {
  const files: string[] = [];
  const stack = [''];
  let truncated = false;
  while (stack.length > 0) {
    const rel = stack.pop()!;
    let dir;
    try {
      dir = await opendir(path.join(root, rel));
    } catch {
      continue;
    }
    for await (const entry of dir) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!DEFAULT_IGNORED_DIRS.has(entry.name)) stack.push(childRel);
      } else if (entry.isFile()) {
        if (files.length >= MAX_SOURCE_FILES) {
          truncated = true;
          break;
        }
        files.push(childRel);
      }
    }
    if (truncated) break;
  }
  return { files, fromGit: false, truncated };
}

export async function isGitRepo(root: string): Promise<boolean> {
  if (!(await isAvailable('git'))) return false;
  try {
    const { stdout } = await run('git', ['rev-parse', '--show-toplevel'], {
      cwd: root,
      timeoutMs: 15_000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}
