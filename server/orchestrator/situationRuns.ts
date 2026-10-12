import type { Db } from '../db.js';
import type { SituationRun } from './situation.js';

/** Only runs that can contribute workers, review items or active-card context. */
function selection(projectIds: readonly number[]) {
  const scoped = projectIds.length > 0;
  const placeholders = projectIds.map(() => '?').join(',');
  const runScope = scoped ? ` AND project_id IN (${placeholders})` : '';
  const cardScope = scoped ? ` AND c.project_id IN (${placeholders})` : '';
  return `
    SELECT id FROM agent_runs WHERE status IN ('running', 'queued')${runScope}
    UNION
    SELECT id FROM agent_runs
      WHERE status IN ('succeeded', 'failed') AND validation IS NULL${runScope}
    UNION
    SELECT (SELECT r.id FROM agent_runs r WHERE r.card_id = c.id ORDER BY r.id DESC LIMIT 1) AS id
      FROM cards c WHERE c.status IN ('in_progress', 'review')${cardScope}
    ORDER BY id DESC
  `;
}
export function situationRunIds(db: Db, projectIds: number[] = []): number[] {
  const rows = db
    .prepare(selection(projectIds))
    .all(...projectIds, ...projectIds, ...projectIds) as { id: number | null }[];
  return rows.flatMap((row) => (row.id === null ? [] : [row.id]));
}

/** Read the situation's fields in one query, without full run/card/log hydration per item. */
export function listSituationRuns(db: Db, projectIds: readonly number[] = []): SituationRun[] {
  const rows = db
    .prepare(
      `SELECT id, project_id AS projectId, card_id AS cardId, name,
    provider_id AS providerId, status, validation, changes_json, ended_at AS endedAt
    FROM agent_runs WHERE id IN (${selection(projectIds)}) ORDER BY id DESC`,
    )
    .all(...projectIds, ...projectIds, ...projectIds) as (Omit<SituationRun, 'changes'> & {
    changes_json: string | null;
  })[];
  return rows.map(({ changes_json, ...run }) => ({
    ...run,
    changes: changes_json ? (JSON.parse(changes_json) as SituationRun['changes']) : null,
  }));
}
