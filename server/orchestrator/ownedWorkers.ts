import type { Db } from '../db.js';
import type { AgentSession } from '../../shared/types.js';
import { getSetting, setSetting } from '../store.js';

/**
 * Sessions an orchestrator owns (PM-417), so its worker limits count its own workers instead of
 * every session the owner started by hand. A session is owned while it is still on the card the
 * orchestrator started it on or handed it (`start_session`, `assign_card`), or while that
 * orchestrator supervises it (PM-405 enrollment). Linking the session to another card ends it.
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
      owned.add(session.id);
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
