import { expect, it, vi } from 'vitest';
import { openDb } from '../db.js';
import {
  workspaceRunIds,
  workspaceRunCounts,
  workspaceActionablePage,
  workspaceLiveAssignments,
} from './workspaceRuns.js';

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
    expect(workspaceLiveAssignments(db, 'owner', [1])).toEqual([
      { id: 4, projectId: 2, cardId: null },
      { id: 1, projectId: 1, cardId: null },
    ]);
    expect(workspaceLiveAssignments(db, 'missing', [99])).toEqual([]);
    expect(workspaceRunCounts(db, 'owner', [1])).toEqual({
      total: 3,
      live: 2,
      awaitingReview: 1,
      failedReview: 1,
      ownedLive: 2,
      ownedReview: 1,
    });
    expect(workspaceRunCounts(db, 'missing', [99])).toEqual({
      total: 0,
      live: 0,
      awaitingReview: 0,
      failedReview: 0,
      ownedLive: 0,
      ownedReview: 0,
    });
    expect(workspaceActionablePage(db, 'owner', [1], undefined, 1)).toEqual({
      ids: [4],
      nextBefore: 4,
    });
    expect(workspaceActionablePage(db, 'owner', [1], 4, 1)).toEqual({ ids: [2], nextBefore: 2 });
    expect(workspaceActionablePage(db, 'owner', [1], 2, 1)).toEqual({ ids: [1], nextBefore: null });
    expect(workspaceActionablePage(db, 'missing', [99])).toEqual({ ids: [], nextBefore: null });
    expect(workspaceActionablePage(db, 'owner', [1], undefined, 2, 'live')).toEqual({
      ids: [4, 1],
      nextBefore: null,
    });
    expect(workspaceActionablePage(db, 'owner', [1], undefined, 2, 'review')).toEqual({
      ids: [2],
      nextBefore: null,
    });
    expect(workspaceRunIds(db, 'owner', [1], undefined, 1, undefined, false)).toEqual({
      ids: [5],
      historyIds: [5],
      nextBefore: 5,
    });
    const first = workspaceRunIds(db, 'owner', [1], undefined, 2);
    expect(first).toEqual({ ids: [5, 4, 2, 1], historyIds: [5, 4], nextBefore: 4 });
    // Actionable runs are retained on every page, even behind hundreds of unrelated rows.
    const second = workspaceRunIds(db, 'owner', [1], first.nextBefore!, 2);
    expect(second).toEqual({ ids: [4, 3, 2, 1], historyIds: [3, 2], nextBefore: 2 });
    const last = workspaceRunIds(db, 'owner', [1], second.nextBefore!, 2);
    expect(last).toEqual({ ids: [4, 2, 1], historyIds: [1], nextBefore: null });
    db.exec(
      "INSERT INTO agent_runs(id,project_id,name,command_json,status,validation,created_at,log_path,orchestrator_id) VALUES (501,1,'New','[]','succeeded','accepted','now','','owner')",
    );
    expect(workspaceRunIds(db, 'owner', [1], 4, 2).historyIds).toEqual([3, 2]);
    expect(workspaceRunIds(db, 'missing', [99])).toEqual({
      ids: [],
      historyIds: [],
      nextBefore: null,
    });
    expect(workspaceRunIds(db, 'owner', [1], undefined, 1, 3)).toMatchObject({
      ids: [501, 4, 3, 2, 1],
      focusFound: true,
    });
    expect(workspaceRunIds(db, 'owner', [1], undefined, 1, 500)).toMatchObject({
      ids: [501, 4, 2, 1],
      focusFound: false,
    });
    expect(workspaceRunIds(db, 'owner', [1], undefined, 1, 999)).toMatchObject({
      focusFound: false,
    });
    expect(workspaceRunIds(db, 'missing', []).ids).toEqual([4, 2, 1]);
  } finally {
    db.close();
  }
});

it('retains owned live and review work after scope changes without retaining unrelated old work', () => {
  const db = openDb(':memory:');
  try {
    db.exec(`INSERT INTO projects(id,name,path,created_at) VALUES (1,'One','/one','now'),(2,'Two','/two','now');
      INSERT INTO agent_runs(id,project_id,name,command_json,status,validation,created_at,log_path,orchestrator_id) VALUES
      (1,2,'Owned live','[]','running',NULL,'now','','owner'),
      (2,2,'Owned review','[]','failed',NULL,'now','','owner'),
      (3,2,'Other live','[]','running',NULL,'now','','other'),
      (4,2,'Other review','[]','succeeded',NULL,'now','','other'),
      (5,1,'Owned history','[]','succeeded','accepted','now','','owner');`);
    expect(workspaceRunIds(db, 'owner', [1], undefined, 1)).toMatchObject({
      ids: [5, 2, 1],
      historyIds: [5],
    });
    expect(workspaceRunIds(db, 'owner', [1], 2, 1)).toMatchObject({ ids: [2, 1], historyIds: [1] });
    db.exec(
      "UPDATE agent_runs SET status='succeeded', validation='accepted' WHERE id=1; UPDATE agent_runs SET validation='rejected' WHERE id=2;",
    );
    expect(workspaceRunIds(db, 'owner', [1], undefined, 1)).toMatchObject({
      ids: [5],
      historyIds: [5],
    });
  } finally {
    db.close();
  }
});

it('uses live and pending-review partial indexes rather than reading all scoped history', () => {
  const db = openDb(':memory:');
  try {
    const prepare = vi.spyOn(db, 'prepare');
    workspaceRunIds(db, 'owner', [1], 100, 20);
    const queries = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    const plan = db.prepare('EXPLAIN QUERY PLAN ' + queries[0]).all(1, 1, 'owner') as {
      detail: string;
    }[];
    expect(plan.some((row) => row.detail.includes('agent_runs_live_projects'))).toBe(true);
    expect(plan.some((row) => row.detail.includes('agent_runs_pending_review'))).toBe(true);
    const historyPlan = db.prepare('EXPLAIN QUERY PLAN ' + queries[1]).all('owner', 100, 21) as {
      detail: string;
    }[];
    expect(
      historyPlan.some((row) => row.detail.includes('COVERING INDEX agent_runs_orchestrator')),
    ).toBe(true);
  } finally {
    db.close();
  }
});
