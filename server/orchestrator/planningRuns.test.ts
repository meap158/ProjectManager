import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { planningRuns } from './planningRuns.js';
import { planOrchestration, type PlanningRun } from './planner.js';
import type { Card } from '../../shared/types.js';

it('preserves planner decisions with global live workers, card review and project fairness', () => {
  const db = openDb(':memory:');
  try {
    const now = new Date().toISOString();
    for (const id of [1, 2, 3])
      db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        id,
        'Project ' + id,
        '/' + id,
        now,
      );
    const cards = [1, 2, 3, 4].map(
      (id) =>
        ({
          id,
          projectId: id === 4 ? 2 : 1,
          title: 'Task',
          status: id === 3 ? 'done' : 'todo',
          position: id,
          createdAt: now,
        }) as Card,
    );
    for (const c of cards)
      db.prepare(
        "INSERT INTO cards (id, project_id, title, status, position, created_at, updated_at) VALUES (?, ?, 'Task', ?, ?, ?, ?)",
      ).run(c.id, c.projectId, c.status, c.position, now, now);
    const runs: PlanningRun[] = [
      {
        id: 1,
        projectId: 1,
        cardId: 1,
        providerId: 'codex',
        status: 'succeeded',
        validation: 'accepted',
      },
      { id: 2, projectId: 1, cardId: 1, providerId: 'codex', status: 'failed', validation: null },
      {
        id: 3,
        projectId: 3,
        cardId: null,
        providerId: 'codex',
        status: 'running',
        validation: null,
      },
      {
        id: 4,
        projectId: 1,
        cardId: 3,
        providerId: 'codex',
        status: 'succeeded',
        validation: 'accepted',
      },
      { id: 5, projectId: 2, cardId: 4, providerId: 'codex', status: 'killed', validation: null },
    ];
    for (const r of runs)
      db.prepare(
        "INSERT INTO agent_runs (id, project_id, card_id, provider_id, name, command_json, status, validation, created_at, log_path) VALUES (?, ?, ?, ?, 'Worker', '[]', ?, ?, ?, '')",
      ).run(r.id, r.projectId, r.cardId, r.providerId, r.status, r.validation, now);
    const policy = {
      projectIds: [1, 2],
      providers: ['codex'],
      maxWorkers: 4,
      maxWorkersPerProject: 2,
      maxWorkersPerProvider: 4,
      reservePercent: 10,
      allowUnknownQuota: true,
      quotaMaxAgeMs: 60000,
    };
    const base = { cards, sessions: [], availableProviders: ['codex'], limits: [] };
    const selected = planningRuns(db, policy.projectIds);
    expect(selected.map((r) => r.id)).toEqual([5, 4, 3, 2]);
    expect(planOrchestration(policy, { ...base, runs: selected })).toEqual(
      planOrchestration(policy, { ...base, runs }),
    );
    expect(planningRuns(db, [1]).map((r) => r.id)).toEqual([4, 3, 2]);
    expect(planningRuns(db, [99]).map((r) => r.id)).toEqual([3]);
    expect(planningRuns(db)).toEqual(selected);
  } finally {
    db.close();
  }
});
