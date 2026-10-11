import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db.js';
import { OrchestratorService } from './service.js';
import type { AgentSupervisor } from '../agents/supervisor.js';
import { providerStatuses } from '../agents/providers.js';
vi.mock('../agents/providers.js', () => ({
  providerStatuses: vi.fn(async () => [{ id: 'codex', available: true }]),
}));
vi.mock('../agents/limits.js', () => ({
  readLimits: () => [
    { providerId: 'codex', asOf: new Date().toISOString(), windows: [{ usedPercent: 20 }] },
  ],
}));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pm-orchestrator-'));
afterEach(() => vi.clearAllMocks());
describe('orchestrator service', () => {
  it('does not reload full history for every waiting card', async () => {
    const db = openDb(':memory:');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (1, ?, ?, ?)').run(
      'Wait',
      tmp,
      now,
    );
    const insert = db.prepare(
      "INSERT INTO cards (project_id, title, description, status, position, created_at, updated_at) VALUES (1, ?, '', 'review', ?, ?, ?)",
    );
    for (let i = 0; i < 100; i++) insert.run(`Review ${i}`, i, now, now);
    const listAllRuns = vi.fn(() => []);
    const dispatchCard = vi.fn();
    const service = new OrchestratorService(
      db,
      { listAllRuns, listAllSessions: () => [], dispatchCard } as unknown as AgentSupervisor,
      null,
    );
    service.save({
      name: 'Wait',
      enabled: true,
      projectIds: [1],
      providers: ['codex'],
      maxWorkers: 1,
      maxWorkersPerProject: 1,
      maxWorkersPerProvider: 1,
      reservePercent: 10,
      allowUnknownQuota: false,
      quotaMaxAgeMs: 60000,
    });
    try {
      await service.tick();
      expect(listAllRuns).toHaveBeenCalledTimes(2);
      expect(dispatchCard).not.toHaveBeenCalled();
      expect(service.state().events.filter((event) => event.action === 'review')).toHaveLength(100);
      const transitions = service.state().events;
      await service.tick();
      expect(service.state().events).toEqual(transitions);
      // Changing state must still produce a new transition for this card.
      db.prepare("UPDATE cards SET status = 'todo' WHERE position = 0").run();
      service.save({ ...service.state().instances[0]!, strategy: 'observe' });
      await service.tick();
      expect(service.state().events.some((event) => event.action === 'observe')).toBe(true);
    } finally {
      await service.stop();
      db.close();
    }
  });
  it('keeps a slow provider check leased and releases its heartbeat on completion', async () => {
    vi.useFakeTimers();
    const db = openDb(':memory:');
    const supervisor = {
      listAllRuns: () => [],
      listAllSessions: () => [],
    } as unknown as AgentSupervisor;
    const service = new OrchestratorService(db, supervisor, null);
    service.save({
      name: 'Slow',
      enabled: true,
      projectIds: [],
      providers: ['codex'],
      maxWorkers: 1,
      maxWorkersPerProject: 1,
      maxWorkersPerProvider: 1,
      reservePercent: 10,
      allowUnknownQuota: false,
      quotaMaxAgeMs: 60000,
    });
    let release!: () => void;
    vi.mocked(providerStatuses).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const pending = service.tick();
    try {
      await vi.advanceTimersByTimeAsync(180000);
      const { OrchestratorAssignments } = await import('./assignments.js');
      const competitor = new OrchestratorAssignments(db);
      expect(competitor.lease('competitor')).toBe(false);
      release();
      await pending;
      expect(competitor.lease('competitor')).toBe(true);
      await vi.advanceTimersByTimeAsync(60000);
      expect(competitor.currentLease()?.owner).toBe('competitor');
    } finally {
      release();
      await pending;
      await service.stop();
      db.close();
      vi.useRealTimers();
    }
  });
  it('skips provider checks and run-history scans with no enabled masters', async () => {
    const db = openDb(':memory:');
    const listAllRuns = vi.fn();
    const service = new OrchestratorService(
      db,
      { listAllRuns } as unknown as AgentSupervisor,
      null,
    );
    try {
      await service.tick();
      expect(listAllRuns).not.toHaveBeenCalled();
      expect(providerStatuses).not.toHaveBeenCalled();
      expect(db.prepare('SELECT COUNT(*) AS n FROM orchestrator_lease').get()?.n).toBe(0);
    } finally {
      await service.stop();
      db.close();
    }
  });
  it('does not enqueue recurring ticks while an earlier tick is pending', async () => {
    vi.useFakeTimers();
    const db = openDb(':memory:');
    const service = new OrchestratorService(db, {} as AgentSupervisor, null);
    let finish!: () => void;
    const tick = vi.spyOn(service, 'tick').mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      service.start();
      service.start();
      await vi.advanceTimersByTimeAsync(120000);
      expect(tick).toHaveBeenCalledTimes(1);
      finish();
      await vi.advanceTimersByTimeAsync(30000);
      expect(tick).toHaveBeenCalledTimes(2);
      await service.stop();
      finish();
      await vi.advanceTimersByTimeAsync(120000);
      expect(tick).toHaveBeenCalledTimes(2);
    } finally {
      await service.stop();
      db.close();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
  it('does not revive an old timer chain after stop and restart during a slow tick', async () => {
    vi.useFakeTimers();
    const db = openDb(':memory:');
    const service = new OrchestratorService(db, {} as AgentSupervisor, null);
    let finish!: () => void;
    const tick = vi
      .spyOn(service, 'tick')
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    try {
      service.start();
      await vi.advanceTimersByTimeAsync(30000);
      await service.stop();
      service.start();
      finish();
      await vi.advanceTimersByTimeAsync(90000);
      expect(tick).toHaveBeenCalledTimes(4);
      await service.stop();
      await vi.advanceTimersByTimeAsync(90000);
      expect(tick).toHaveBeenCalledTimes(4);
    } finally {
      await service.stop();
      db.close();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
  it('persists instances and serializes overlapping ticks without duplicate live assignment', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (1, ?, ?, ?)').run(
      'Test',
      tmp,
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO cards (id, project_id, title, description, status, position, created_at, updated_at) VALUES (1, 1, 'Task', '', 'todo', 0, ?, ?)",
    ).run(new Date().toISOString(), new Date().toISOString());
    const runs: {
      id: number;
      cardId: number;
      projectId: number;
      providerId: string;
      status: string;
    }[] = [];
    const dispatch = vi.fn(
      async (projectId: number, cardId: number, input: { canCommit?: () => boolean }) => {
        await Promise.resolve();
        expect(input.canCommit?.()).toBe(true);
        // Same timestamp simulates fast edits: content identity must also be checked.
        db.prepare("UPDATE cards SET description = 'New instructions' WHERE id = ?").run(cardId);
        expect(input.canCommit?.()).toBe(false);
        db.prepare("UPDATE cards SET description = '' WHERE id = ?").run(cardId);
        expect(input.canCommit?.()).toBe(true);
        db.prepare("UPDATE cards SET updated_at = 'new-revision' WHERE id = ?").run(cardId);
        expect(input.canCommit?.()).toBe(false);
        db.prepare('UPDATE cards SET updated_at = created_at WHERE id = ?').run(cardId);
        expect(input.canCommit?.()).toBe(true);
        runs.push(
          { id: 90, projectId, cardId: 90, providerId: 'codex', status: 'running' },
          { id: 91, projectId, cardId: 91, providerId: 'codex', status: 'running' },
        );
        expect(input.canCommit?.()).toBe(false);
        runs.length = 0;
        expect(input.canCommit?.()).toBe(true);
        const run = { id: 1, projectId, cardId, providerId: 'codex', status: 'running' };
        runs.push(run);
        return run;
      },
    );
    const supervisor = {
      listAllRuns: () => runs,
      listAllSessions: () => [],
      dispatchCard: dispatch,
    } as unknown as AgentSupervisor;
    const service = new OrchestratorService(db, supervisor, null);
    const saved = service.save({
      name: 'Master',
      enabled: true,
      projectIds: [1],
      providers: ['codex'],
      maxWorkers: 2,
      maxWorkersPerProject: 2,
      maxWorkersPerProvider: 2,
      reservePercent: 10,
      allowUnknownQuota: false,
      quotaMaxAgeMs: 60000,
    });
    service.save({ ...saved, strategy: 'observe' });
    const beforePreview = service.state();
    const preview = await service.preview(saved.id);
    expect(preview?.decisions.some((d) => d.action === 'dispatch')).toBe(true);
    expect(preview?.decisions[0]?.retry).toMatchObject({
      attemptsUsed: 0,
      attemptsRemaining: 3,
      blocker: null,
    });
    expect(preview?.decisions[0]?.execution).toEqual({
      autonomy: 'edit',
      supervisorAttempts: 1,
      requiresReview: true,
    });
    expect(preview?.total).toBe(1);
    expect(preview?.summary).toEqual({ dispatch: 1, review: 0, wait: 0 });
    const beyond = await service.preview(saved.id, 1, 1);
    expect(beyond?.decisions).toEqual([]);
    expect(beyond?.total).toBe(1);
    expect(beyond?.summary).toEqual(preview?.summary);
    expect(service.state()).toEqual(beforePreview);
    expect(dispatch).not.toHaveBeenCalled();
    await service.tick(saved.id);
    expect(dispatch).not.toHaveBeenCalled();
    expect(service.state().events.some((e) => e.action === 'observe')).toBe(true);
    service.save({ ...saved, strategy: 'autonomous' });
    const excluded = service.save({
      ...saved,
      id: undefined,
      name: 'Different scope',
      projectIds: [2],
    });
    await service.tick(excluded.id);
    expect(dispatch).not.toHaveBeenCalled();
    await Promise.all([service.tick(saved.id), service.tick(saved.id)]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(service.state().events.some((e) => e.action === 'dispatched' && e.runId === 1)).toBe(
      true,
    );
    const restored = new OrchestratorService(db, supervisor, null);
    expect(restored.state().instances[0]?.id).toBe(saved.id);
    restored.save({ ...saved, enabled: false });
    restored.save({ ...excluded, enabled: false });
    runs.length = 0;
    await restored.tick();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(service.state().events.length).toBeGreaterThan(0);
    service.clearEvents();
    expect(service.state().events).toEqual([]);
    expect(restored.delete(saved.id)).toBe(true);
    expect(restored.delete(excluded.id)).toBe(true);
    expect(restored.state().instances).toHaveLength(0);
    expect(restored.delete(saved.id)).toBe(false);
    await restored.stop();
    db.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('resolves and prunes project attention', async () => {
    const db = openDb(':memory:');
    db.prepare('INSERT INTO projects (id, name, path, created_at) VALUES (1, ?, ?, ?)').run(
      'Test Proj',
      tmp,
      new Date().toISOString(),
    );
    const runs: {
      id: number;
      cardId: number;
      projectId: number;
      providerId: string;
      status: string;
    }[] = [];
    const dispatch = vi.fn(async (projectId: number, cardId: number) => {
      const run = { id: 10, projectId, cardId, providerId: 'codex', status: 'running' };
      runs.push(run);
      return run;
    });
    const supervisor = {
      listAllRuns: () => runs,
      listAllSessions: () => [],
      dispatchCard: dispatch,
    } as unknown as AgentSupervisor;
    const projectSummary = {
      id: 1,
      name: 'Test Proj',
      path: tmp,
      createdAt: new Date().toISOString(),
      lastScannedAt: null,
      code: null,
      disk: null,
      git: {
        isRepo: true,
        branch: 'main',
        dirtyFiles: 2,
        ahead: 0,
        behind: 0,
        totalCommits: 1,
        firstCommitAt: '2026-01-01',
        lastCommitAt: new Date().toISOString(),
        contributors: [],
        dailyCommits: {},
        recentCommits: [],
        remoteUrl: null,
      },
      boardPreset: 'full' as const,
      runningSessions: 0,
      missing: false,
      scan: { status: 'idle' as const, error: null, startedAt: null, moves: [] },
      cardCounts: { todo: 0, in_progress: 0, review: 0, done: 0, backlog: 0 },
    };
    const service = new OrchestratorService(db, supervisor, null, () => [projectSummary]);
    const saved = service.save({
      name: 'Master',
      enabled: true,
      projectIds: [1],
      providers: ['codex'],
      maxWorkers: 2,
      maxWorkersPerProject: 2,
      maxWorkersPerProvider: 2,
      reservePercent: 10,
      allowUnknownQuota: false,
      quotaMaxAgeMs: 60000,
      followDashboardAttention: true,
      pruneDashboardAttention: true,
    });

    service.save({ ...saved, enabled: false });
    const paused = await service.resolveAttention(saved.id, 1);
    expect(paused.resolvedCards).toHaveLength(1);
    expect(paused.dispatchedRuns).toEqual([]);
    expect(dispatch).not.toHaveBeenCalled();
    service.save({ ...saved, strategy: 'observe' });
    await service.resolveAttention(saved.id, 1);
    expect(dispatch).not.toHaveBeenCalled();
    // An unrelated available CLI cannot replace the master's configured provider.
    service.save({ ...saved, providers: ['claude'] });
    await service.resolveAttention(saved.id, 1);
    expect(dispatch).not.toHaveBeenCalled();
    service.save(saved);
    const res = await service.resolveAttention(saved.id, 1);
    expect(res.resolvedCards.length).toBeGreaterThan(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(res.dispatchedRuns).toEqual([10]);
    expect(
      db
        .prepare('SELECT state, run_id FROM orchestrator_assignments WHERE card_id = ?')
        .get(res.resolvedCards[0]),
    ).toMatchObject({ state: 'assigned', run_id: 10 });
    expect(service.state().events.some((e) => e.action === 'dispatched')).toBe(true);

    // Prune attention when project becomes clean
    projectSummary.git.dirtyFiles = 0;
    const pruneRes = service.pruneAttention(saved.id, 1);
    expect(pruneRes.prunedCards.length).toBeGreaterThan(0);

    await service.stop();
    db.close();
  });

  it('coalesces multiple overlapping manual tick requests and reports execution status', async () => {
    const db = openDb(':memory:');
    const supervisor = {
      listAllRuns: () => [],
      listAllSessions: () => [],
      dispatchCard: vi.fn(),
    } as unknown as AgentSupervisor;

    const service = new OrchestratorService(db, supervisor, null);
    const executeSpy = vi.spyOn(
      service as unknown as { execute: (id?: string) => Promise<void> },
      'execute',
    );
    service.save({
      name: 'Coalesce Master',
      enabled: true,
      projectIds: [],
      providers: ['codex'],
      maxWorkers: 1,
      maxWorkersPerProject: 1,
      maxWorkersPerProvider: 1,
      reservePercent: 10,
      allowUnknownQuota: false,
      quotaMaxAgeMs: 60000,
    });

    // Before any tick
    expect(service.state().status).toMatchObject({ executing: false, lastTickAt: null });

    // Start tick 1
    const t1 = service.tick();
    expect(service.state().status?.executing).toBe(true);
    expect(service.state().status?.lastTickAt).not.toBeNull();

    // Trigger 3 concurrent ticks while tick 1 is executing
    const t2 = service.tick();
    const t3 = service.tick();
    const t4 = service.tick();

    await Promise.all([t1, t2, t3, t4]);

    // Exactly 2 executions ran (the initial execution + 1 coalesced execution for t2, t3, t4)
    expect(executeSpy).toHaveBeenCalledTimes(2);
    expect(service.state().status?.executing).toBe(false);

    await service.stop();
    db.close();
  });
});

it('replans an edited pre-launch task without consuming worker retry budget', async () => {
  const db = openDb(':memory:');
  const at = new Date().toISOString();
  db.prepare("INSERT INTO projects (id, name, path, created_at) VALUES (1, 'Test', ?, ?)").run(
    tmp,
    at,
  );
  db.prepare(
    "INSERT INTO cards (id, project_id, title, description, status, position, created_at, updated_at) VALUES (1, 1, 'Task', '', 'todo', 0, ?, ?)",
  ).run(at, at);
  let edit = true;
  const dispatch = vi.fn(
    async (_project: number, _card: number, input: { canCommit?: () => boolean }) => {
      if (edit) {
        edit = false;
        db.prepare("UPDATE cards SET description = 'Updated task' WHERE id = 1").run();
        expect(input.canCommit?.()).toBe(false);
        throw new Error('Dispatch rejected');
      }
      expect(input.canCommit?.()).toBe(true);
      return { id: 1 };
    },
  );
  const service = new OrchestratorService(
    db,
    {
      listAllRuns: () => [],
      listAllSessions: () => [],
      dispatchCard: dispatch,
    } as unknown as AgentSupervisor,
    null,
  );
  try {
    const master = service.save({
      name: 'Master',
      enabled: true,
      projectIds: [1],
      providers: ['codex'],
      maxWorkers: 1,
      maxWorkersPerProject: 1,
      maxWorkersPerProvider: 1,
      reservePercent: 10,
      allowUnknownQuota: false,
      quotaMaxAgeMs: 60000,
    });
    await service.tick(master.id);
    expect(
      db
        .prepare(
          'SELECT attempts, retry_after, state FROM orchestrator_assignments WHERE card_id = 1',
        )
        .get(),
    ).toMatchObject({ attempts: 0, retry_after: 0, state: 'error' });
    expect(
      service.state().events.some((e) => e.action === 'wait' && e.message.includes('Task changed')),
    ).toBe(true);
    await service.tick(master.id);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(
      db.prepare('SELECT attempts, state FROM orchestrator_assignments WHERE card_id = 1').get(),
    ).toMatchObject({ attempts: 1, state: 'assigned' });
  } finally {
    await service.stop();
    db.close();
  }
});
