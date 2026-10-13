import type { Db } from '../db.js';

/** Run identities for one workspace: scoped actionable work and owned history.
 * History uses an id cursor; actionable work is never hidden by the history cap.
 */
export function workspaceRunIds(
  db: Db,
  owner: string,
  projectIds: readonly number[] = [],
  before?: number,
  limit = 20,
) {
  const marks = projectIds.map(() => '?').join(',');
  const scope = projectIds.length ? ` AND project_id IN (${marks})` : '';
  const actionable = db
    .prepare(
      `SELECT id FROM agent_runs
    WHERE (status IN ('running', 'queued') OR
      (status IN ('succeeded', 'failed') AND validation IS NULL))${scope}
    ORDER BY id DESC`,
    )
    .all(...projectIds) as { id: number }[];
  // Persisted ownership is authoritative even if a master's project scope changes.
  const history = db
    .prepare(
      `SELECT id FROM agent_runs
    WHERE orchestrator_id = ? ${before === undefined ? '' : 'AND id < ?'}
    ORDER BY id DESC LIMIT ?`,
    )
    .all(owner, ...(before === undefined ? [] : [before]), limit + 1) as { id: number }[];
  const page = history.slice(0, limit);
  return {
    ids: [...new Set([...actionable.map((row) => row.id), ...page.map((row) => row.id)])].sort(
      (a, b) => b - a,
    ),
    historyIds: page.map((row) => row.id),
    nextBefore: history.length > limit ? page.at(-1)!.id : null,
  };
}
