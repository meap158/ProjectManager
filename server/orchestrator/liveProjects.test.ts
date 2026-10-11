import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { liveRunProjects } from './liveProjects.js';

it('counts only live occupancy, including old and unlinked workers, without duplicates', () => {
  const db = openDb(':memory:');
  try {
    for (const id of [1, 2, 3])
      db.prepare(
        "INSERT INTO projects (id, name, path, created_at) VALUES (?, 'Project', ?, '2026-10-12')",
      ).run(id, '/' + id);
    const insert = db.prepare(
      "INSERT INTO agent_runs (project_id, name, command_json, status, created_at, log_path) VALUES (?, 'Worker', '[]', ?, '2026-10-12', '')",
    );
    insert.run(1, 'running');
    insert.run(1, 'queued');
    insert.run(2, 'queued');
    for (const status of ['failed', 'killed', 'succeeded']) insert.run(3, status);
    expect(liveRunProjects(db).sort()).toEqual([1, 2]);
    db.prepare("UPDATE agent_runs SET status = 'succeeded' WHERE project_id = 1").run();
    expect(liveRunProjects(db)).toEqual([2]);
  } finally {
    db.close();
  }
});
