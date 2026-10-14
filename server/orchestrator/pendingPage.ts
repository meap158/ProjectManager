import type { Db } from '../db.js';
import type { SituationItem } from '../../shared/orchestrator.js';
import { cardKey } from '../store.js';
import { STALLED_MS } from './situation.js';

/** Page database-backed attention after the small, ordered alert/session prefix. */
export function pendingDatabasePage(
  db: Db,
  projectIds: readonly number[],
  liveSessionCards: readonly number[],
  projectNames: ReadonlyMap<number, string>,
  prefix: SituationItem[],
  offset: number,
  limit: number,
  now: number,
) {
  const runScope = projectIds.length
    ? ` AND r.project_id IN (${projectIds.map(() => '?').join(',')})`
    : '';
  const cardScope = projectIds.length
    ? ` AND c.project_id IN (${projectIds.map(() => '?').join(',')})`
    : '';
  const reviewWhere = `r.status IN ('succeeded', 'failed') AND r.validation IS NULL${runScope}`;
  const stalledWhere = `c.status = 'in_progress'${cardScope}
    AND julianday(c.updated_at) < julianday(?)
    AND NOT EXISTS (SELECT 1 FROM agent_runs live WHERE live.card_id = c.id AND live.status IN ('running','queued'))
    AND c.id NOT IN (SELECT value FROM json_each(?))`;
  const stalledArgs = [
    ...projectIds,
    new Date(now - STALLED_MS).toISOString(),
    JSON.stringify(liveSessionCards),
  ];
  const reviewCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM agent_runs r WHERE ${reviewWhere}`)
      .get(...projectIds) as { n: number }
  ).n;
  const stalledCount = (
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM cards c JOIN projects p ON p.id=c.project_id WHERE ${stalledWhere}`,
      )
      .get(...stalledArgs) as { n: number }
  ).n;
  const total = prefix.length + reviewCount + stalledCount;
  const items = prefix.slice(offset, offset + limit);
  const reviewOffset = Math.max(0, offset - prefix.length);
  if (items.length < limit && reviewOffset < reviewCount) {
    const rows = db
      .prepare(
        `SELECT r.id, r.project_id AS projectId, r.card_id AS cardId, r.name, r.status,
      r.ended_at AS since, COALESCE(json_array_length(r.changes_json, '$.files'), 0) AS files,
      COALESCE(json_extract(r.changes_json, '$.commits'), 0) AS commits,
      c.status AS cardStatus
      FROM agent_runs r LEFT JOIN cards c ON c.id=r.card_id
      WHERE ${reviewWhere} ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      )
      .all(...projectIds, limit - items.length, reviewOffset) as unknown as {
      id: number;
      projectId: number;
      cardId: number | null;
      name: string;
      status: string;
      since: string | null;
      files: number;
      commits: number;
      cardStatus: string | null;
    }[];
    for (const row of rows)
      items.push({
        kind: 'awaiting-review',
        projectId: row.projectId,
        projectName: projectNames.get(row.projectId) ?? `Project ${row.projectId}`,
        title: `Review run ${row.id}: ${row.name}`,
        detail: `${row.status === 'failed' ? 'Failed' : 'Finished'}; ${row.files} file${row.files === 1 ? '' : 's'} changed, ${row.commits} commit(s). Accept or reject it.`,
        runId: row.id,
        cardId: row.cardId ?? undefined,
        cardKey:
          row.cardId != null && ['in_progress', 'review'].includes(row.cardStatus ?? '')
            ? cardKey(row.cardId)
            : undefined,
        since: row.since ?? undefined,
      });
  }
  if (items.length < limit) {
    const rows = db
      .prepare(
        `SELECT c.id, c.project_id AS projectId, p.name AS projectName,
      c.title, c.updated_at AS since FROM cards c JOIN projects p ON p.id=c.project_id
      WHERE ${stalledWhere} ORDER BY c.updated_at, c.id LIMIT ? OFFSET ?`,
      )
      .all(
        ...stalledArgs,
        limit - items.length,
        Math.max(0, offset - prefix.length - reviewCount),
      ) as unknown as {
      id: number;
      projectId: number;
      projectName: string;
      title: string;
      since: string;
    }[];
    for (const row of rows)
      items.push({
        kind: 'stalled',
        projectId: row.projectId,
        projectName: row.projectName,
        title: `${cardKey(row.id)} has stalled: ${row.title}`,
        detail: `In progress with no live worker since ${row.since}.`,
        cardId: row.id,
        cardKey: cardKey(row.id),
        since: row.since,
      });
  }
  return {
    version: 1 as const,
    generatedAt: new Date(now).toISOString(),
    total,
    offset,
    limit,
    items,
    nextOffset: offset + limit < total ? offset + limit : null,
  };
}
