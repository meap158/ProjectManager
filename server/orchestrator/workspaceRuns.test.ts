import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { workspaceRunIds } from './workspaceRuns.js';

it('retains old actionable work and pages owned history without unrelated newest-run cutoff', () => {
  const db = openDb(':memory:');
  try {
    db.exec(`INSERT INTO projects(id,name,path,created_at) VALUES
      (1,'One','/one','now'),(2,'Two','/two','now');
      WITH RECURSIVE n(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM n WHERE id<500)
      INSERT INTO agent_runs(id,project_id,name,command_json,status,validation,created_at,log_path,orchestrator_id)
      SELECT id,CASE WHEN id=4 THEN 2 ELSE 1 END,'Worker','[]',
        CASE WHEN id=1 THEN 'running' WHEN id=2 THEN 'failed' WHEN id=4 THEN 'queued' ELSE 'succeeded' END,
        CASE WHEN id IN (1,2,4) THEN NULL ELSE 'accepted' END,'now','',
        CASE WHEN id<=5 THEN 'owner' ELSE 'other' END FROM n;`);
    const first = workspaceRunIds(db, 'owner', [1], undefined, 2);
    expect(first).toEqual({ ids: [5, 4, 2, 1], historyIds: [5, 4], nextBefore: 4 });
    // Actionable runs are retained on every page, even behind hundreds of unrelated rows.
    const second = workspaceRunIds(db, 'owner', [1], first.nextBefore!, 2);
    expect(second).toEqual({ ids: [3, 2, 1], historyIds: [3, 2], nextBefore: 2 });
    const last = workspaceRunIds(db, 'owner', [1], second.nextBefore!, 2);
    expect(last).toEqual({ ids: [2, 1], historyIds: [1], nextBefore: null });
    db.exec(
      "INSERT INTO agent_runs(id,project_id,name,command_json,status,validation,created_at,log_path,orchestrator_id) VALUES (501,1,'New','[]','succeeded','accepted','now','','owner')",
    );
    expect(workspaceRunIds(db, 'owner', [1], 4, 2).historyIds).toEqual([3, 2]);
    expect(workspaceRunIds(db, 'missing', [99])).toEqual({
      ids: [],
      historyIds: [],
      nextBefore: null,
    });
    expect(workspaceRunIds(db, 'missing', []).ids).toEqual([4, 2, 1]);
  } finally {
    db.close();
  }
});
