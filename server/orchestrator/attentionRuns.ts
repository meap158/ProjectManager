import type { Db } from '../db.js';

/** Run identities for follow-up cards only; IDs can be reused after deleting the newest run. */
export function attentionRunIds(db: Db, cardIds: readonly number[]): number[] {
  if (!cardIds.length) return [];
  const query = db.prepare('SELECT id FROM agent_runs WHERE card_id = ? ORDER BY id DESC');
  return [...new Set(cardIds)]
    .flatMap((cardId) => (query.all(cardId) as { id: number }[]).map((row) => row.id))
    .sort((a, b) => b - a);
}
