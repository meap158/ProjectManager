import { expect, it, vi } from 'vitest';
import type { AgentSupervisor } from '../agents/supervisor.js';
import { OrchestratorService } from './service.js';
import { openDb } from '../db.js';
import { situationRunIds } from './situationRuns.js';

it('keeps live, all unreviewed and latest active-card runs without unrelated history', () => {
  const db = openDb(':memory:');
  try {
    const now = new Date().toISOString();
    const project = db.prepare(
      'INSERT INTO projects (id, name, path, created_at) VALUES (?, ?, ?, ?)',
    );
    for (const id of [1, 2]) project.run(id, 'Project ' + id, '/project/' + id, now);
    const card = db.prepare(
      "INSERT INTO cards (id, project_id, title, status, position, created_at, updated_at) VALUES (?, ?, 'Task', ?, 0, ?, ?)",
    );
    card.run(1, 1, 'in_progress', now, now);
    card.run(2, 1, 'done', now, now);
    card.run(3, 2, 'review', now, now);
    card.run(4, 1, 'review', now, now); // No run: NULL projection must be omitted.
    const run = db.prepare(
      "INSERT INTO agent_runs (id, project_id, card_id, name, command_json, status, validation, created_at, log_path) VALUES (?, ?, ?, 'Worker', '[]', ?, ?, ?, '')",
    );
    run.run(1, 1, 1, 'succeeded', 'accepted', now); // Superseded active-card history.
    run.run(2, 1, 2, 'succeeded', 'accepted', now); // Closed, validated work.
    run.run(3, 1, 1, 'killed', null, now); // Latest context still matters.
    run.run(4, 1, 2, 'failed', null, now); // Review survives closed-card status.
    run.run(5, 1, null, 'succeeded', null, now); // Unlinked review survives too.
    run.run(6, 1, 1, 'failed', null, now); // Older unreviewed run must remain.
    run.run(7, 1, 1, 'running', null, now); // Latest and live: deduplicate.
    run.run(8, 2, 3, 'queued', null, now);
    run.run(9, 2, 3, 'succeeded', 'accepted', now); // Latest context outside scope.
    // Old pending runs remain visible even beyond the previous 100,000-row cutoff.
    db.exec('BEGIN');
    for (let id = 10; id < 100011; id++) run.run(id, 1, 2, 'succeeded', 'accepted', now);
    db.exec('COMMIT');
    expect(situationRunIds(db, [1])).toEqual([7, 6, 5, 4]);
    expect(situationRunIds(db, [2])).toEqual([9, 8]);
    expect(situationRunIds(db)).toEqual([9, 8, 7, 6, 5, 4]);
    expect(situationRunIds(db, [])).toEqual(situationRunIds(db));
    expect(situationRunIds(db, [99])).toEqual([]);
    db.prepare('DELETE FROM agent_runs WHERE id IN (6, 7)').run();
    expect(situationRunIds(db, [1])).toEqual([5, 4, 3]);
  } finally {
    db.close();
  }
});

it('situation hydrates selected run IDs and does not load the history list', () => {
  const db = openDb(':memory:');
  try {
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO projects (id, name, path, created_at) VALUES (1, 'One', '/one', ?)",
    ).run(now);
    db.prepare(
      "INSERT INTO agent_runs (id, project_id, name, command_json, status, created_at, log_path) VALUES (1, 1, 'Pending', '[]', 'failed', ?, '')",
    ).run(now);
    const getRun = vi.fn(() => ({
      id: 1,
      projectId: 1,
      cardId: null,
      name: 'Pending',
      status: 'failed',
      validation: null,
      changes: null,
      endedAt: now,
    }));
    const listAllRuns = vi.fn(() => {
      throw new Error('History must not be loaded');
    });
    const service = new OrchestratorService(
      db,
      { getRun, listAllRuns, listAllSessions: () => [] } as unknown as AgentSupervisor,
      null,
    );
    const situation = service.situation();
    expect(getRun).toHaveBeenCalledExactlyOnceWith(1);
    expect(listAllRuns).not.toHaveBeenCalled();
    expect(situation?.needsAttention).toEqual([
      expect.objectContaining({ kind: 'awaiting-review', runId: 1 }),
    ]);
  } finally {
    db.close();
  }
});
