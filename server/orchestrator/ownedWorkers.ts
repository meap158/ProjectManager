import type { Db } from '../db.js';
import type { AgentSession } from '../../shared/types.js';
import { getCard, getSetting, setSetting } from '../store.js';

/**
 * Sessions an orchestrator owns (PM-417), so its worker limits count its own workers instead of
 * every session the owner started by hand. A session is owned while it is still on the card the
 * orchestrator started it on or handed it (`start_session`, `assign_card`), or while that
 * orchestrator supervises it (PM-405 enrollment). Linking the session to another card ends it.
 * Finished work frees the slot (PM-496): once the card reaches done, the session no longer
 * counts, even if it is still linked. Cards in review still count, so rework can continue.
 * Runs need no record: the ones an orchestrator dispatches carry its id.
 */
interface OwnedSession {
  sessionId: number;
  cardId: number;
}
interface Enrollment {
  owner: string;
  cardId: number;
  enabled: boolean;
}
/** Where PM-405 keeps a session's supervision enrollment (owner, card, on/off). */
export const enrollmentKey = (id: number) => `orchestrator-session-supervision:${id}`;
const key = (orchestratorId: string) => `orchestrator-owned-sessions:${orchestratorId}`;
/** Older records beyond this are dropped; a live orchestrator owns far fewer sessions. */
const KEEP = 200;

export function recordOwnedSession(
  db: Db,
  orchestratorId: string,
  sessionId: number,
  cardId: number,
): void {
  const records = (getSetting<OwnedSession[]>(db, key(orchestratorId)) ?? []).filter(
    (r) => r.sessionId !== sessionId,
  );
  records.push({ sessionId, cardId });
  setSetting(db, key(orchestratorId), records.slice(-KEEP));
}

/**
 * Cards this orchestrator has worked on (PM-420): any run it dispatched, a session it started
 * or handed the card to (kept records), or a session it supervises on that card.
 */
export function ownedCardIds(db: Db, orchestratorId: string): Set<number> {
  const cards = new Set<number>(
    (
      db
        .prepare(
          'SELECT DISTINCT card_id AS cardId FROM agent_runs WHERE orchestrator_id = ? AND card_id IS NOT NULL',
        )
        .all(orchestratorId) as { cardId: number }[]
    ).map((r) => r.cardId),
  );
  for (const r of getSetting<OwnedSession[]>(db, key(orchestratorId)) ?? []) cards.add(r.cardId);
  const enrollments = db
    .prepare("SELECT value FROM settings WHERE key LIKE 'orchestrator-session-supervision:%'")
    .all() as { value: string }[];
  for (const { value } of enrollments) {
    try {
      const e = JSON.parse(value) as Enrollment;
      if (e.enabled && e.owner === orchestratorId && e.cardId) cards.add(e.cardId);
    } catch {
      // A malformed record owns nothing.
    }
  }
  return cards;
}

/** The ids of the given sessions that this orchestrator owns right now. */
export function ownedSessionIds(
  db: Db,
  orchestratorId: string,
  sessions: readonly AgentSession[],
): Set<number> {
  const records = new Map(
    (getSetting<OwnedSession[]>(db, key(orchestratorId)) ?? []).map((r) => [r.sessionId, r.cardId]),
  );
  const owned = new Set<number>();
  for (const session of sessions) {
    if (session.cardId == null || session.orchestratorId) continue;
    if (records.get(session.id) === session.cardId) {
      // A done card releases its session (PM-496): finished work must not hold a worker
      // slot forever. A missing card row stays owned (conservative: never drop on read failure).
      if (getCard(db, session.cardId)?.status !== 'done') owned.add(session.id);
      continue;
    }
    const enrollment = getSetting<Enrollment>(db, enrollmentKey(session.id));
    if (
      enrollment?.enabled &&
      enrollment.owner === orchestratorId &&
      enrollment.cardId === session.cardId
    )
      owned.add(session.id);
  }
  return owned;
}
