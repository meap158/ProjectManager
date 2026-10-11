import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { OrchestratorAssignments } from './assignments.js';

function fixture() {
  const db = openDb(':memory:');
  db.prepare(
    "INSERT INTO projects (id, name, path, created_at) VALUES (1, 'Test', '/test', '2026-10-11')",
  ).run();
  db.prepare(
    "INSERT INTO cards (id, project_id, title, description, status, position, created_at, updated_at) VALUES (1, 1, 'Task', '', 'todo', 0, '2026-10-11', '2026-10-11')",
  ).run();
  return db;
}
it('recovers keyed insertion and validated Todo lifecycle in the same database-backed pass', () => {
  const db = fixture();
  try {
    const a = new OrchestratorAssignments(db);
    a.claim(1, 'master', 1000);
    const key = a.dispatchKey(1);
    db.prepare(
      "INSERT INTO agent_runs (id, project_id, card_id, name, command_json, status, validation, created_at, log_path, dispatch_key) VALUES (1, 1, 1, 'Worker', '[]', 'succeeded', 'accepted', ?, '', ?)",
    ).run(new Date(1001).toISOString(), key);
    a.reconcile(undefined, 2000);
    expect(
      db
        .prepare(
          'SELECT state, run_id, retry_after FROM orchestrator_assignments WHERE card_id = 1',
        )
        .get(),
    ).toMatchObject({ state: 'error', run_id: 1, retry_after: 0 });
    expect(a.claim(1, 'master', 2001)).toBe(true);
  } finally {
    db.close();
  }
});
it('recovers the earliest eligible legacy run regardless of snapshot limits and preserves pending review', () => {
  const db = fixture();
  try {
    const a = new OrchestratorAssignments(db);
    a.claim(1, 'master', 1000);
    db.prepare('UPDATE orchestrator_assignments SET dispatch_key = NULL WHERE card_id = 1').run();
    const insert = db.prepare(
      "INSERT INTO agent_runs (id, project_id, card_id, name, command_json, status, created_at, log_path) VALUES (?, 1, ?, 'Worker', '[]', 'failed', ?, '')",
    );
    insert.run(1, 1, new Date(999).toISOString());
    insert.run(4, 1, new Date(1001).toISOString());
    insert.run(3, 1, new Date(1002).toISOString());
    insert.run(2, 1, 'invalid timestamp');
    db.exec(`
      WITH RECURSIVE history(id) AS (
        SELECT 5 UNION ALL SELECT id + 1 FROM history WHERE id < 100005
      )
      INSERT INTO agent_runs (id, project_id, card_id, name, command_json, status, created_at, log_path)
      SELECT id, 1, NULL, 'Worker', '[]', 'failed', '1970-01-01T00:00:01.003Z', '' FROM history
    `);
    a.reconcile(undefined, 2000);
    expect(
      db.prepare('SELECT state, run_id FROM orchestrator_assignments WHERE card_id = 1').get(),
    ).toMatchObject({ state: 'assigned', run_id: 3 });
    a.reconcile(undefined, 3000);
    expect(a.blockedCards(3000).has(1)).toBe(true);
    db.prepare("UPDATE agent_runs SET validation = 'rejected' WHERE id = 3").run();
    a.reconcile(undefined, 4000);
    expect(a.blockedCards(4000).has(1)).toBe(false);
  } finally {
    db.close();
  }
});
