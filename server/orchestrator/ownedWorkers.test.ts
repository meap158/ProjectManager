import { describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import { setSetting } from '../store.js';
import type { AgentSession } from '../../shared/types.js';
import { enrollmentKey, ownedSessionIds, recordOwnedSession } from './ownedWorkers.js';

const session = (id: number, cardId: number | null, orchestratorId: string | null = null) =>
  ({ id, cardId, orchestratorId, status: 'running' }) as AgentSession;

describe('orchestrator-owned sessions (PM-417)', () => {
  it('owns a session it started or handed a card to while it stays on that card', () => {
    const db = openDb(':memory:');
    recordOwnedSession(db, 'm1', 5, 40);
    recordOwnedSession(db, 'm1', 6, 41);
    expect([
      ...ownedSessionIds(db, 'm1', [session(5, 40), session(6, 41), session(7, 42)]),
    ]).toEqual([5, 6]);
    // Moved to another card by someone else: no longer this orchestrator's worker.
    expect([...ownedSessionIds(db, 'm1', [session(5, 99), session(6, null)])]).toEqual([]);
    // Another orchestrator does not inherit it.
    expect(ownedSessionIds(db, 'm2', [session(5, 40)]).size).toBe(0);
    // Handing the same session a new card replaces the record.
    recordOwnedSession(db, 'm1', 5, 99);
    expect([...ownedSessionIds(db, 'm1', [session(5, 99)])]).toEqual([5]);
    db.close();
  });

  it('owns the sessions it supervises on their enrolled card', () => {
    const db = openDb(':memory:');
    setSetting(db, enrollmentKey(8), { owner: 'm1', cardId: 50, enabled: true });
    setSetting(db, enrollmentKey(9), { owner: 'm1', cardId: 51, enabled: false });
    setSetting(db, enrollmentKey(10), { owner: 'm2', cardId: 52, enabled: true });
    const sessions = [session(8, 50), session(9, 51), session(10, 52), session(11, 53)];
    expect([...ownedSessionIds(db, 'm1', sessions)]).toEqual([8]);
    expect([...ownedSessionIds(db, 'm1', [session(8, 77)])]).toEqual([]);
    db.close();
  });

  it('never counts an orchestrator chat as a worker', () => {
    const db = openDb(':memory:');
    recordOwnedSession(db, 'm1', 3, 30);
    expect(ownedSessionIds(db, 'm1', [session(3, 30, 'm1')]).size).toBe(0);
    db.close();
  });
});
