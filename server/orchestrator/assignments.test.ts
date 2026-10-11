import { afterEach, expect, it } from 'vitest';
import { openDb } from '../db.js';
import { OrchestratorAssignments } from './assignments.js';
const db = openDb(':memory:');
db.prepare(
  "INSERT INTO projects (id, name, path, created_at) VALUES (1, 'Test', '/tmp/test', '2026-10-10')",
).run();
db.prepare(
  "INSERT INTO cards (id, project_id, title, description, status, position, created_at, updated_at) VALUES (1, 1, 'Task', '', 'todo', 0, '2026-10-10', '2026-10-10')",
).run();
afterEach(() => {
  db.prepare('DELETE FROM orchestrator_assignments').run();
  db.prepare('DELETE FROM orchestrator_lease').run();
});
it('excludes overlapping owners and lets an expired lease be reclaimed', () => {
  const a = new OrchestratorAssignments(db);
  const b = new OrchestratorAssignments(db);
  expect(a.lease('a', 1000)).toBe(true);
  expect(b.lease('b', 1001)).toBe(false);
  expect(b.lease('b', 121001)).toBe(true);
  a.release('a');
  expect(a.lease('a', 121002)).toBe(false);
});
it('preserves claims on restart and reconciles a dispatch interrupted after run creation', () => {
  const a = new OrchestratorAssignments(db);
  expect(a.claim(1, 'master')).toBe(true);
  // Old claims predate durable dispatch keys and retain timestamp-based recovery.
  db.prepare('UPDATE orchestrator_assignments SET dispatch_key = NULL WHERE card_id = 1').run();
  const restored = new OrchestratorAssignments(db);
  expect(restored.claim(1, 'other')).toBe(false);
  restored.reconcile([{ id: 41, cardId: 1, createdAt: '2020-01-01T00:00:00Z' }]);
  expect(
    db.prepare('SELECT state FROM orchestrator_assignments WHERE card_id = 1').get()?.state,
  ).toBe('dispatching');
  restored.reconcile([{ id: 42, cardId: 1, createdAt: new Date(Date.now() + 1000).toISOString() }]);
  expect(
    db.prepare('SELECT state, run_id FROM orchestrator_assignments WHERE card_id = 1').get(),
  ).toMatchObject({ state: 'assigned', run_id: 42 });
  expect(restored.claim(1, 'other')).toBe(false);
});
it('enforces cooldown and retry budget', () => {
  const a = new OrchestratorAssignments(db);
  expect(a.claim(1, 'master')).toBe(true);
  a.failed(1);
  expect(a.retryPlans().get(1)).toMatchObject({
    attemptsUsed: 1,
    attemptsRemaining: 2,
    blocker: 'Retry cooldown',
  });
  expect(a.retryPlans().get(1)?.retryAt).not.toBeNull();
  expect(a.claim(1, 'master')).toBe(false);
  expect(a.claim(1, 'master', Date.now() + 300001)).toBe(true);
  a.failed(1);
  expect(a.claim(1, 'master', Date.now() + 300001)).toBe(true);
  a.failed(1);
  expect(a.claim(1, 'master', Date.now() + 600001)).toBe(false);
});
it('matches keyed intents exactly and ignores unrelated later runs', () => {
  const a = new OrchestratorAssignments(db);
  a.claim(1, 'master');
  const key = a.dispatchKey(1)!;
  a.reconcile([{ id: 999, cardId: 1, createdAt: new Date(Date.now() + 1000).toISOString() }]);
  expect(
    db.prepare('SELECT state FROM orchestrator_assignments WHERE card_id = 1').get()?.state,
  ).toBe('dispatching');
  const id = Number(
    db
      .prepare(
        `INSERT INTO agent_runs (project_id, card_id, name, command_json, created_at, log_path, dispatch_key)
    VALUES (1, 1, 'Recovered', '[]', ?, 'test.log', ?)`,
      )
      .run(new Date().toISOString(), key).lastInsertRowid,
  );
  try {
    // Recovery does not depend on the caller's bounded history snapshot.
    new OrchestratorAssignments(db).reconcile([]);
    expect(
      db.prepare('SELECT state, run_id FROM orchestrator_assignments WHERE card_id = 1').get(),
    ).toMatchObject({ state: 'assigned', run_id: id });
  } finally {
    db.prepare('DELETE FROM agent_runs WHERE id = ?').run(id);
  }
});
it('exposes reserved and cooling-down claims without blocking eligible retries', () => {
  const a = new OrchestratorAssignments(db);
  expect(a.blockedCards().has(1)).toBe(false);
  a.claim(1, 'master');
  expect(a.blockedCards().has(1)).toBe(true);
  a.failed(1);
  expect(a.blockedCards().has(1)).toBe(true);
  expect(a.blockedCards(Date.now() + 300001).has(1)).toBe(false);
});
it('releases validated rejected work returned to Todo but preserves pending review', () => {
  const a = new OrchestratorAssignments(db);
  a.claim(1, 'master');
  a.assigned(1, 41);
  const run = {
    id: 41,
    cardId: 1,
    createdAt: new Date().toISOString(),
    status: 'failed',
    validation: null as string | null,
  };
  a.reconcile([run]);
  expect(a.blockedCards().has(1)).toBe(true);
  a.reconcile([{ ...run, validation: 'rejected' }]);
  expect(a.blockedCards().has(1)).toBe(false);
  expect(a.claim(1, 'master')).toBe(true);
  a.assigned(1, 42);
  db.prepare("UPDATE cards SET status = 'review' WHERE id = 1").run();
  a.reconcile([{ ...run, id: 42, validation: 'accepted' }]);
  expect(a.blockedCards().has(1)).toBe(true);
  db.prepare("UPDATE cards SET status = 'todo' WHERE id = 1").run();
  a.reconcile([{ ...run, id: 42, validation: 'accepted' }]);
  expect(a.blockedCards().has(1)).toBe(false);
});

it('tracks owner epoch, renews heartbeats and fences assignments against stale owners', () => {
  const a = new OrchestratorAssignments(db);
  const b = new OrchestratorAssignments(db);
  expect(a.lease('owner-a', 1000)).toBe(true);
  expect(a.currentLease()).toMatchObject({ owner: 'owner-a', epoch: 1 });

  // Renewal maintains epoch
  expect(a.renew('owner-a', 1, 5000)).toBe(true);
  expect(a.currentLease()).toMatchObject({ owner: 'owner-a', epoch: 1 });

  // Fenced claim succeeds with current owner and epoch
  expect(a.claim(1, 'master', 5000, 'owner-a', 1)).toBe(true);

  // Time elapses past expiration: owner-b takes over lease -> epoch increments to 2
  expect(b.lease('owner-b', 126000)).toBe(true);
  expect(b.currentLease()).toMatchObject({ owner: 'owner-b', epoch: 2 });

  // Owner-a's fenced renew and assignment updates fail with stale epoch
  expect(a.renew('owner-a', 1, 126001)).toBe(false);
  expect(a.assigned(1, 99, 'owner-a', 1, 126001)).toBe(false);
  // Stale claim also rejected
  expect(a.claim(1, 'master', 126001, 'owner-a', 1)).toBe(false);

  // Owner-b successfully performs fenced assigned
  expect(b.assigned(1, 100, 'owner-b', 2, 126001)).toBe(true);
  expect(
    db.prepare('SELECT state, run_id FROM orchestrator_assignments WHERE card_id = 1').get(),
  ).toMatchObject({
    state: 'assigned',
    run_id: 100,
  });
});

it('recovers orphan dispatches older than 120s into retry cooldown instead of permanent stranding', () => {
  const a = new OrchestratorAssignments(db);
  expect(a.claim(1, 'master', 1000)).toBe(true);
  expect(
    db.prepare('SELECT state FROM orchestrator_assignments WHERE card_id = 1').get()?.state,
  ).toBe('dispatching');

  // Reconcile within 120s timeout without a run preserves dispatching
  a.reconcile([], 60000);
  expect(
    db.prepare('SELECT state FROM orchestrator_assignments WHERE card_id = 1').get()?.state,
  ).toBe('dispatching');

  // Reconcile past 120s timeout (e.g. process crashed before run insertion) recovers claim to error with cooldown
  a.reconcile([], 130000);
  expect(
    db.prepare('SELECT state FROM orchestrator_assignments WHERE card_id = 1').get()?.state,
  ).toBe('error');
  expect(a.retryPlans(130000).get(1)).toMatchObject({
    attemptsUsed: 1,
    attemptsRemaining: 2,
    blocker: 'Retry cooldown',
  });
});

it('preserves fencing epochs across release and rejects expired renewal and stale failures', () => {
  const a = new OrchestratorAssignments(db);
  expect(a.lease('same-owner', 1000)).toBe(true);
  expect(a.claim(1, 'master', 1001, 'same-owner', 1)).toBe(true);
  a.release('same-owner', 1);
  expect(a.renew('same-owner', 1, 1002)).toBe(false);
  expect(a.lease('same-owner', 1002)).toBe(true);
  expect(a.currentLease()?.epoch).toBe(2);
  a.release('same-owner', 1);
  expect(a.isLeaseValid('same-owner', 2, 1003)).toBe(true);
  expect(a.failed(1, 1003, 'same-owner', 1)).toBe(false);
  expect(
    db.prepare('SELECT state FROM orchestrator_assignments WHERE card_id = 1').get()?.state,
  ).toBe('dispatching');
  expect(a.renew('same-owner', 2, 121002)).toBe(false);
  expect(a.lease('same-owner', 121002)).toBe(true);
  expect(a.currentLease()?.epoch).toBe(3);
});
