import type { Db } from '../db.js';

/** Only runs that can contribute workers, review items or active-card context. */
export function situationRunIds(db: Db, projectIds: number[] = []): number[] {
  const scoped = projectIds.length > 0;
  const placeholders = projectIds.map(() => '?').join(',');
  const runScope = scoped ? ` AND project_id IN (${placeholders})` : '';
  const cardScope = scoped ? ` AND c.project_id IN (${placeholders})` : '';
  const rows = db
    .prepare(
      `
    SELECT id FROM agent_runs WHERE status IN ('running', 'queued')${runScope}
    UNION
    SELECT id FROM agent_runs
      WHERE status IN ('succeeded', 'failed') AND validation IS NULL${runScope}
    UNION
    SELECT (SELECT r.id FROM agent_runs r WHERE r.card_id = c.id ORDER BY r.id DESC LIMIT 1) AS id
      FROM cards c WHERE c.status IN ('in_progress', 'review')${cardScope}
    ORDER BY id DESC
  `,
    )
    .all(...projectIds, ...projectIds, ...projectIds) as { id: number | null }[];
  return rows.flatMap((row) => (row.id === null ? [] : [row.id]));
}
