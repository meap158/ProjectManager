import { z } from 'zod';
import type { Db } from '../db.js';
import type { RunChanges } from '../../shared/types.js';
import type { RunExecutionIdentity } from './runExecution.js';
import { snapshotTree, diffSince } from './gitChanges.js';

const snapshot = z.object({
  head: z.string().nullable(),
  dirty: z.array(z.tuple([z.string(), z.string()])).max(10000),
});

/** Immutable baseline: replay must never substitute the current tree for pre-launch evidence. */
export async function captureRunBaseline(db: Db, identity: RunExecutionIdentity, cwd: string) {
  const baselineAt = new Date().toISOString();
  const tree = await snapshotTree(cwd);
  let json = tree ? JSON.stringify({ head: tree.head, dirty: [...tree.dirty] }) : null;
  if (json && (json.length > 1024 * 1024 || tree!.dirty.size > 10000)) json = null;
  db.prepare(
    `INSERT INTO agent_run_evidence(nonce,cwd,baseline_at,baseline_json)
    VALUES(?,?,?,?) ON CONFLICT(nonce) DO NOTHING`,
  ).run(identity.nonce, cwd, baselineAt, json);
}

/** Interval evidence, not attribution: other authors may change the shared worktree. */
export async function observeRunChanges(
  db: Db,
  identity: RunExecutionIdentity,
): Promise<RunChanges | null> {
  const evidence = db
    .prepare(`SELECT cwd,baseline_at,baseline_json FROM agent_run_evidence WHERE nonce=?`)
    .get(identity.nonce) as
    { cwd: string; baseline_at: string; baseline_json: string | null } | undefined;
  if (!evidence?.baseline_json) return null;
  let parsed: z.infer<typeof snapshot>;
  try {
    parsed = snapshot.parse(JSON.parse(evidence.baseline_json));
  } catch {
    return null;
  }
  const changes = await diffSince(evidence.cwd, {
    head: parsed.head,
    dirty: new Map(parsed.dirty),
  });
  return changes
    ? {
        ...changes,
        observation: { baselineAt: evidence.baseline_at, observedAt: new Date().toISOString() },
      }
    : null;
}
