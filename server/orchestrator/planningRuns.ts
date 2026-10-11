import type { Db } from '../db.js';
import type { PlanningRun } from './planner.js';

/** Global live occupancy plus scoped review/readiness and last-served identity. */
export function planningRuns(db: Db, projectIds: number[] = []): PlanningRun[] {
  const placeholders = projectIds.map(() => '?').join(',');
  const cardScope = projectIds.length ? ` AND c.project_id IN (${placeholders})` : '';
  const projectScope = projectIds.length ? ` AND project_id IN (${placeholders})` : '';
  return db
    .prepare(
      `
    SELECT id, project_id AS projectId, card_id AS cardId, provider_id AS providerId, status, validation
    FROM agent_runs WHERE id IN (
      SELECT id FROM agent_runs WHERE status IN ('running', 'queued')
      UNION
      SELECT (SELECT r.id FROM agent_runs r WHERE r.card_id = c.id ORDER BY r.id DESC LIMIT 1)
      FROM cards c WHERE c.status IN ('todo', 'in_progress', 'review')${cardScope}
      UNION
      SELECT MAX(id) FROM agent_runs WHERE card_id IS NOT NULL${projectScope} GROUP BY project_id
    ) ORDER BY id DESC
  `,
    )
    .all(...projectIds, ...projectIds) as PlanningRun[];
}
