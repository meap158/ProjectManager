// Records what an agent run changed in the project's git working tree, so validation shows real
// evidence ("3 files changed, 1 commit") instead of trusting the exit code. A CLI that had its
// edits declined still exits 0; with this, the run card says "no file changes".

import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { RunChanges } from '../../shared/types.js';
import { run } from '../analysis/exec.js';

export interface TreeSnapshot {
  head: string | null;
  /** Dirty/untracked path -> fingerprint (status + mtime + size), so edits to an already-dirty
      file are still noticed. */
  dirty: Map<string, string>;
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await run('git', ['-c', 'core.quotepath=off', ...args], { cwd, timeoutMs: 30_000 }))
      .stdout;
  } catch {
    return null;
  }
}

/** Snapshot of HEAD and the dirty files, or null when the folder isn't a git work tree. */
export async function snapshotTree(cwd: string): Promise<TreeSnapshot | null> {
  const status = await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  if (status === null) return null;
  const head = (await git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']))?.trim() || null;
  const dirty = new Map<string, string>();
  const entries = status.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    // Renames/copies carry the original path as the next NUL-separated field.
    if (code[0] === 'R' || code[0] === 'C') i++;
    let fingerprint = code;
    try {
      const info = await stat(path.join(cwd, file));
      fingerprint += `|${info.mtimeMs}|${info.size}`;
    } catch {
      fingerprint += '|gone';
    }
    dirty.set(file, fingerprint);
  }
  return { head, dirty };
}

/** Compares the tree now with a snapshot taken before the run. */
export async function diffSince(cwd: string, before: TreeSnapshot): Promise<RunChanges | null> {
  const after = await snapshotTree(cwd);
  if (!after) return null;
  const files = new Set<string>();
  for (const [file, fp] of after.dirty) if (before.dirty.get(file) !== fp) files.add(file);
  for (const file of before.dirty.keys()) if (!after.dirty.has(file)) files.add(file);

  let commits = 0;
  if (after.head && after.head !== before.head) {
    if (before.head) {
      commits =
        Number(
          (await git(cwd, ['rev-list', '--count', `${before.head}..${after.head}`]))?.trim(),
        ) || 0;
      const committed = await git(cwd, ['diff', '--name-only', before.head, after.head]);
      for (const f of committed?.split(/\r?\n/).filter(Boolean) ?? []) files.add(f);
    } else {
      commits = Number((await git(cwd, ['rev-list', '--count', after.head]))?.trim()) || 0;
    }
  }
  return { files: [...files].sort().slice(0, 500), commits };
}
