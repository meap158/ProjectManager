import type { Db } from '../db.js';

function actionableSelection(projectIds: readonly number[]) {
  const marks = projectIds.map(() => '?').join(',');
  const scope = projectIds.length ? ` AND project_id IN (${marks})` : '';
  return `SELECT id FROM agent_runs WHERE status IN ('running', 'queued')${scope}
      UNION
      SELECT id FROM agent_runs WHERE status IN ('succeeded', 'failed') AND validation IS NULL${scope}
      ${
        projectIds.length
          ? `UNION SELECT id FROM agent_runs WHERE orchestrator_id = ?
        AND (status IN ('running', 'queued') OR (status IN ('succeeded', 'failed') AND validation IS NULL))`
          : ''
      }
`;
}
function actionableParameters(owner: string, projectIds: readonly number[]) {
  return [...projectIds, ...projectIds, ...(projectIds.length ? [owner] : [])];
}

/** Complete scalar counts: no run JSON, card lookup or filesystem hydration. */
export function workspaceRunCounts(db: Db, owner: string, projectIds: readonly number[] = []) {
  return db
    .prepare(
      `SELECT COUNT(*) AS total,
    COALESCE(SUM(status IN ('queued', 'running')), 0) AS live,
    COALESCE(SUM(status IN ('succeeded', 'failed') AND validation IS NULL), 0) AS awaitingReview,
    COALESCE(SUM(status = 'failed' AND validation IS NULL), 0) AS failedReview,
    COALESCE(SUM(orchestrator_id = ? AND status IN ('queued', 'running')), 0) AS ownedLive,
    COALESCE(SUM(orchestrator_id = ? AND status IN ('succeeded', 'failed') AND validation IS NULL), 0) AS ownedReview
    FROM agent_runs WHERE id IN (${actionableSelection(projectIds)})`,
    )
    .get(owner, owner, ...actionableParameters(owner, projectIds)) as {
    total: number;
    live: number;
    awaitingReview: number;
    failedReview: number;
    ownedLive: number;
    ownedReview: number;
  };
}

/** Bounded detail hydration with a descending identity cursor, independent of history. */
export function workspaceActionablePage(
  db: Db,
  owner: string,
  projectIds: readonly number[] = [],
  before?: number,
  limit = 20,
  kind: 'all' | 'live' | 'review' = 'all',
) {
  const kindClause =
    kind === 'live'
      ? " AND status IN ('running','queued')"
      : kind === 'review'
        ? " AND status IN ('succeeded','failed') AND validation IS NULL"
        : '';
  const rows = db
    .prepare(
      `SELECT id FROM agent_runs WHERE id IN (${actionableSelection(projectIds)})
    ${before === undefined ? '' : 'AND id < ?'}${kindClause} ORDER BY id DESC LIMIT ?`,
    )
    .all(
      ...actionableParameters(owner, projectIds),
      ...(before === undefined ? [] : [before]),
      limit + 1,
    ) as { id: number }[];
  const page = rows.slice(0, limit);
  return {
    ids: page.map((row) => row.id),
    nextBefore: rows.length > limit ? page.at(-1)!.id : null,
  };
}

/** Run identities for one workspace: scoped actionable work and owned history.
 * History uses an id cursor; actionable work is never hidden by the history cap.
 */
export function workspaceRunIds(
  db: Db,
  owner: string,
  projectIds: readonly number[] = [],
  before?: number,
  limit = 20,
  focus?: number,
  includeActionable = true,
) {
  const actionable = includeActionable
    ? (db
        .prepare(`${actionableSelection(projectIds)} ORDER BY id DESC`)
        .all(...actionableParameters(owner, projectIds)) as { id: number }[])
    : [];
  // Persisted ownership is authoritative even if a master's project scope changes.
  const history = db
    .prepare(
      `SELECT id FROM agent_runs
    WHERE orchestrator_id = ? ${before === undefined ? '' : 'AND id < ?'}
    ORDER BY id DESC LIMIT ?`,
    )
    .all(owner, ...(before === undefined ? [] : [before]), limit + 1) as { id: number }[];
  const page = history.slice(0, limit);
  const focused =
    focus === undefined
      ? undefined
      : (db
          .prepare('SELECT id FROM agent_runs WHERE id = ? AND orchestrator_id = ?')
          .get(focus, owner) as { id: number } | undefined);
  return {
    ids: [
      ...new Set([
        ...actionable.map((row) => row.id),
        ...page.map((row) => row.id),
        ...(focused ? [focused.id] : []),
      ]),
    ].sort((a, b) => b - a),
    historyIds: page.map((row) => row.id),
    ...(focus === undefined ? {} : { focusFound: Boolean(focused) }),
    nextBefore: history.length > limit ? page.at(-1)!.id : null,
  };
}

/** Live task identity stays complete across detail pages without hydrating logs or commands. */
export function workspaceLiveAssignments(
  db: Db,
  owner: string,
  projectIds: readonly number[] = [],
) {
  return db
    .prepare(
      `SELECT id, project_id AS projectId, card_id AS cardId
    FROM agent_runs WHERE id IN (${actionableSelection(projectIds)})
    AND status IN ('running', 'queued') ORDER BY id DESC`,
    )
    .all(...actionableParameters(owner, projectIds)) as {
    id: number;
    projectId: number;
    cardId: number | null;
  }[];
}
