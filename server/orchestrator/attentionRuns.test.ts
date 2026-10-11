import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { attentionRunIds } from './attentionRuns.js';

it('selects exact card identities, skips empty scope and detects a reused ID below the global maximum', () => {
  const db = openDb(':memory:');
  try {
    db.prepare(
      "INSERT INTO projects (id, name, path, created_at) VALUES (1, 'Project', '/one', '2026-10-12')",
    ).run();
    for (const id of [1, 2])
      db.prepare(
        "INSERT INTO cards (id, project_id, title, status, position, created_at, updated_at) VALUES (?, 1, 'Task', 'todo', 0, '2026-10-12', '2026-10-12')",
      ).run(id);
    const insert = db.prepare(
      "INSERT INTO agent_runs (id, project_id, card_id, name, command_json, created_at, log_path) VALUES (?, 1, ?, 'Worker', '[]', '2026-10-12', '')",
    );
    insert.run(1, 1);
    insert.run(2, 2);
    insert.run(5, null);
    expect(attentionRunIds(db, [])).toEqual([]);
    expect(attentionRunIds(db, [1, 1])).toEqual([1]);
    const before = new Set(attentionRunIds(db, [1]));
    db.prepare('DELETE FROM agent_runs WHERE id = 5').run();
    insert.run(3, 1);
    expect(attentionRunIds(db, [1]).filter((id) => !before.has(id))).toEqual([3]);
    expect(attentionRunIds(db, [99])).toEqual([]);
  } finally {
    db.close();
  }
});
