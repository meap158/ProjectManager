import { describe, expect, it } from 'vitest';
import { rollOver } from '../agents/limits.js';
import type { Card, AgentRun, AgentSession } from '../../shared/types.js';
import { planOrchestration, type OrchestratorPolicy } from './planner.js';
const now = Date.parse('2026-10-10T12:00:00Z');
const policy: OrchestratorPolicy = {
  projectIds: [1],
  providers: ['claude', 'codex'],
  maxWorkers: 2,
  maxWorkersPerProject: 2,
  maxWorkersPerProvider: 1,
  reservePercent: 10,
  allowUnknownQuota: false,
  quotaMaxAgeMs: 60000,
};
const card = (id: number, projectId = 1) =>
  ({ id, projectId, position: id, status: 'todo', createdAt: new Date(now).toISOString() }) as Card;
const limits = (providerId: string, usedPercent: number) => ({
  providerId,
  asOf: new Date(now).toISOString(),
  source: 'test',
  windows: [{ label: 'Weekly', windowMinutes: 10080, usedPercent, resetsAt: null }],
});
const snapshot = () => ({
  cards: [card(1), card(2), card(3, 2)],
  runs: [] as AgentRun[],
  sessions: [],
  availableProviders: ['claude', 'codex'],
  limits: [limits('claude', 100), limits('codex', 20)],
});
describe('orchestrator planning', () => {
  it('plans CLI starts against project saved-session slots, not the run allocation', () => {
    const p = { ...policy, maxWorkers: 8, maxWorkersPerProject: 1, maxWorkersPerProvider: 8 };
    const sessions = Array.from(
      { length: 7 },
      (_, i) =>
        ({
          id: 40 + i,
          projectId: 1,
          providerId: 'codex',
          status: 'exited',
          cardId: null,
        }) as AgentSession,
    );
    const state = { ...snapshot(), sessions, workerKind: 'session' as const };
    const result = planOrchestration(p, state, now);
    expect(result[0]?.action).toBe('dispatch');
    expect(result[1]?.waitReason).toBe('project_capacity');
    expect(
      planOrchestration(p, { ...state, sessions: [] }, now).filter((d) => d.action === 'dispatch'),
    ).toHaveLength(2);
    expect(
      planOrchestration(p, { ...state, sessions: [], workerKind: 'run' }, now)[1]?.waitReason,
    ).toBe('project_capacity');
  });
  it('plans session starts past the total and per-provider run limits (PM-571)', () => {
    const p = { ...policy, maxWorkers: 1, maxWorkersPerProject: 1, maxWorkersPerProvider: 1 };
    const busy = {
      id: 40,
      projectId: 1,
      providerId: 'codex',
      status: 'running',
      cardId: 999,
    } as AgentSession;
    const state = { ...snapshot(), sessions: [busy], ownedSessionIds: new Set([40]) };
    const asRun = planOrchestration(p, { ...state, workerKind: 'run' }, now);
    expect(asRun[0]?.action).toBe('wait');
    const asSession = planOrchestration(p, { ...state, workerKind: 'session' }, now);
    expect(asSession[0]?.action).toBe('dispatch');
  });
  it("counts only orchestrators' workers toward the machine-wide cap (PM-668)", () => {
    const p = { ...policy, maxWorkers: 4, maxWorkersPerProvider: 4 };
    // 47 sessions the owner opened by hand in other projects, 4 in this one.
    const open = (id: number, projectId: number) =>
      ({ id, projectId, providerId: 'codex', status: 'running', cardId: null }) as AgentSession;
    const sessions = [
      ...Array.from({ length: 43 }, (_, i) => open(100 + i, 2)),
      ...Array.from({ length: 4 }, (_, i) => open(200 + i, 1)),
    ];
    const state = { ...snapshot(), cards: [card(1)], sessions, workerKind: 'session' as const };
    // Without the automation set every session counts, as before.
    expect(planOrchestration(p, state, now)[0]?.waitReason).toBe('global_capacity');
    // With it, the project still has CLI slots, so the session start goes ahead.
    const owned = { ...state, orchestratorSessionIds: new Set<number>() };
    expect(planOrchestration(p, owned, now)[0]?.action).toBe('dispatch');
    // Runaway automation still stops at the cap.
    const automated = { ...state, orchestratorSessionIds: new Set(sessions.map((s) => s.id)) };
    expect(planOrchestration(p, automated, now)[0]?.waitReason).toBe('global_capacity');
  });
  it('alternates projects and prefers the least recently served project across ticks', () => {
    const state = snapshot();
    state.cards = [card(1), card(2), card(3, 2), card(4, 2)];
    const fairPolicy = { ...policy, projectIds: [], maxWorkers: 2, maxWorkersPerProvider: 4 };
    expect(
      planOrchestration(fairPolicy, state, now)
        .filter((d) => d.action === 'dispatch')
        .map((d) => d.cardId),
    ).toEqual([1, 3]);
    state.runs = [
      {
        id: 20,
        cardId: 99,
        projectId: 1,
        providerId: 'codex',
        status: 'succeeded',
        validation: 'accepted',
      },
    ] as AgentRun[];
    expect(
      planOrchestration({ ...fairPolicy, maxWorkers: 1 }, state, now).find(
        (d) => d.action === 'dispatch',
      )?.cardId,
    ).toBe(3);
  });
  it('serves priority projects before the rest, rotating within each group (PM-430)', () => {
    const state = snapshot();
    state.cards = [card(1), card(2), card(3, 2), card(4, 2), card(5, 3), card(6, 3)];
    const base = { ...policy, projectIds: [], maxWorkers: 3, maxWorkersPerProvider: 4 };
    const dispatched = (p: typeof base) =>
      planOrchestration(p, state, now)
        .filter((d) => d.action === 'dispatch')
        .map((d) => d.cardId);
    expect(dispatched(base)).toEqual([1, 3, 5]);
    // Project 3 first; per-project capacity (2) still holds, then the others rotate.
    expect(dispatched({ ...base, priorityProjectIds: [3] })).toEqual([5, 6, 1]);
    expect(dispatched({ ...base, priorityProjectIds: [2, 3] })).toEqual([3, 5, 4]);
  });
  it('counts proposed dispatches against the global safety cap', () => {
    const state = snapshot();
    state.runs = Array.from({ length: 31 }, (_, i) => ({
      id: i + 1,
      projectId: 2,
      cardId: null,
      providerId: 'other',
      status: 'running',
    })) as AgentRun[];
    const decisions = planOrchestration(
      { ...policy, maxWorkers: 32, maxWorkersPerProvider: 16 },
      state,
      now,
    );
    expect(decisions.filter((decision) => decision.action === 'dispatch')).toHaveLength(1);
    expect(decisions[1]?.waitReason).toBe('global_capacity');
  });
  it('explains provider blockers without bypassing known exhaustion', () => {
    const state = snapshot();
    state.availableProviders = ['claude'];
    const decision = planOrchestration({ ...policy, allowUnknownQuota: true }, state, now)[0];
    expect(decision?.action).toBe('wait');
    expect(decision?.providerBlockers?.map((b) => b.code)).toEqual([
      'quota_reserve',
      'unavailable',
    ]);
    expect(
      planOrchestration(policy, { ...state, limits: [] }, now)[0]?.providerBlockers?.[0]?.code,
    ).toBe('quota_unknown');
  });
  it('does not let a reserved earlier task consume capacity needed by ready tasks', () => {
    const state = { ...snapshot(), blockedCardIds: new Set([1]) };
    expect(
      planOrchestration({ ...policy, maxWorkers: 1 }, state, now).map((d) => [d.cardId, d.action]),
    ).toEqual([
      [1, 'wait'],
      [2, 'dispatch'],
    ]);
  });
  it('respects scope, quota and reservations made earlier in the same tick', () => {
    expect(
      planOrchestration(policy, snapshot(), now).map((d) => [d.cardId, d.action, d.providerId]),
    ).toEqual([
      [1, 'dispatch', 'codex'],
      [2, 'wait', undefined],
    ]);
  });
  it('does not duplicate live work or reassign pending review', () => {
    const state = snapshot();
    state.runs = [
      { id: 1, cardId: 1, projectId: 1, providerId: 'codex', status: 'running' },
      {
        id: 2,
        cardId: 2,
        projectId: 1,
        providerId: 'claude',
        status: 'succeeded',
        validation: null,
      },
    ] as AgentRun[];
    expect(planOrchestration(policy, state, now).map((d) => d.action)).toEqual(['wait', 'review']);
  });
  it('treats stale or missing quotas as unknown unless explicitly allowed', () => {
    const state = snapshot();
    state.limits = [];
    expect(planOrchestration(policy, state, now).every((d) => d.action === 'wait')).toBe(true);
    expect(
      planOrchestration({ ...policy, allowUnknownQuota: true }, state, now).map(
        (d) => d.providerId,
      ),
    ).toEqual(['claude', 'codex']);
    state.limits = [limits('codex', 20)];
    expect(planOrchestration(policy, state, now + 61000).every((d) => d.action === 'wait')).toBe(
      true,
    );
  });
  it('supports all-project scope without exceeding total capacity', () => {
    const state = snapshot();
    state.limits = [limits('claude', 20), limits('codex', 20)];
    const decisions = planOrchestration({ ...policy, projectIds: [] }, state, now);
    expect(decisions).toHaveLength(3);
    expect(decisions.filter((d) => d.action === 'dispatch')).toHaveLength(2);
    expect(decisions[2]?.action).toBe('wait');
  });
});

it.each(['not-a-date', new Date(now + 86400000).toISOString()])(
  'treats invalid or future report time %s as unknown quota',
  (asOf) => {
    const state = snapshot();
    state.cards = [card(1)];
    state.limits = [{ ...limits('codex', 20), asOf }];
    const scoped = { ...policy, providers: ['codex'] };
    expect(planOrchestration(scoped, state, now)[0]).toMatchObject({
      action: 'wait',
      waitReason: 'quota_unknown',
      providerBlockers: [{ providerId: 'codex', code: 'quota_unknown' }],
    });
    expect(planOrchestration({ ...scoped, allowUnknownQuota: true }, state, now)[0]).toMatchObject({
      action: 'dispatch',
      providerId: 'codex',
    });
  },
);
it('accepts the exact freshness boundary and rejects the next millisecond', () => {
  const state = snapshot();
  state.cards = [card(1)];
  state.limits = [limits('codex', 20)];
  const scoped = { ...policy, providers: ['codex'] };
  expect(planOrchestration(scoped, state, now + policy.quotaMaxAgeMs)[0]?.action).toBe('dispatch');
  expect(planOrchestration(scoped, state, now + policy.quotaMaxAgeMs + 1)[0]?.waitReason).toBe(
    'quota_unknown',
  );
});

it.each([-1, 101, NaN, Infinity, -Infinity])(
  'treats invalid percentage %s as unknown and never masks a known exhausted window',
  (usedPercent) => {
    const state = snapshot();
    state.cards = [card(1)];
    state.limits = [limits('codex', usedPercent)];
    const scoped = { ...policy, providers: ['codex'] };
    expect(planOrchestration(scoped, state, now)[0]?.waitReason).toBe('quota_unknown');
    expect(planOrchestration({ ...scoped, allowUnknownQuota: true }, state, now)[0]?.action).toBe(
      'dispatch',
    );
    state.limits[0]!.windows.push(limits('codex', 100).windows[0]!);
    expect(
      planOrchestration({ ...scoped, allowUnknownQuota: true }, state, now)[0]?.waitReason,
    ).toBe('quota_exceeded');
  },
);

it('requires fresh verification after estimated quota rollover unless unknown quota is explicitly allowed', () => {
  const report = limits('codex', 100);
  report.windows[0]!.resetsAt = new Date(now - 1).toISOString();
  const rolled = rollOver(report, now);
  const state = { ...snapshot(), cards: [card(1)], limits: [rolled] };
  const scoped = { ...policy, providers: ['codex'] };
  // The old reading is kept, flagged stale; it is not "exhausted" and not assumed to be 0%.
  expect(rolled.windows[0]).toMatchObject({ usedPercent: 100, resetSinceReport: true });
  expect(planOrchestration(scoped, state, now)[0]?.waitReason).toBe('quota_unknown');
  expect(planOrchestration({ ...scoped, allowUnknownQuota: true }, state, now)[0]?.action).toBe(
    'dispatch',
  );
  rolled.windows.push(limits('codex', 100).windows[0]!);
  expect(planOrchestration({ ...scoped, allowUnknownQuota: true }, state, now)[0]?.waitReason).toBe(
    'quota_exceeded',
  );
  state.limits = [limits('codex', 20)];
  expect(planOrchestration(scoped, state, now)[0]?.action).toBe('dispatch');
});
describe('orchestrator worker limits count its own workers (PM-417)', () => {
  const session = (id: number, projectId: number, providerId: string, cardId: number | null) =>
    ({ id, projectId, providerId, cardId, status: 'running' }) as AgentSession;
  const own = { ...policy, id: 'm1', maxWorkers: 1, maxWorkersPerProject: 1 };
  const dispatched = (state: ReturnType<typeof snapshot>, p = own) =>
    planOrchestration(p, state, now)
      .filter((d) => d.action === 'dispatch')
      .map((d) => d.cardId);

  it('ignores the owner sessions for every limit', () => {
    const state = {
      ...snapshot(),
      sessions: [
        session(1, 1, 'codex', null),
        session(2, 1, 'codex', 50),
        session(3, 2, 'codex', 51),
      ],
      ownedSessionIds: new Set<number>(),
    };
    // Without ownership, those sessions fill the limit of 1 as before.
    expect(dispatched({ ...state, ownedSessionIds: undefined })).toEqual([]);
    expect(dispatched(state)).toEqual([1]);
  });

  it('counts sessions it owns and runs carrying its id', () => {
    const state = {
      ...snapshot(),
      sessions: [session(1, 1, 'codex', 50)],
      ownedSessionIds: new Set([1]),
    };
    const decisions = planOrchestration(own, state, now);
    expect(decisions[0]?.waitReason).toBe('managed_capacity');
    expect(decisions[0]?.occupancy).toMatchObject({ managedWorkers: 1, externalWorkers: 0 });

    const runs = [
      {
        id: 7,
        projectId: 1,
        cardId: 60,
        providerId: 'codex',
        status: 'running',
        orchestratorId: 'm1',
      },
      {
        id: 8,
        projectId: 1,
        cardId: 61,
        providerId: 'codex',
        status: 'running',
        orchestratorId: 'm2',
      },
    ] as AgentRun[];
    const byRuns = planOrchestration(own, { ...snapshot(), runs, ownedSessionIds: new Set() }, now);
    expect(byRuns[0]?.waitReason).toBe('managed_capacity');
    expect(byRuns[0]?.occupancy).toMatchObject({ managedWorkers: 1, externalWorkers: 1 });
  });

  it('applies the per-provider limit to its own workers only', () => {
    const state = {
      ...snapshot(),
      sessions: [session(1, 1, 'codex', 50)],
      ownedSessionIds: new Set<number>(),
    };
    const p = { ...own, maxWorkers: 2, maxWorkersPerProject: 2, maxWorkersPerProvider: 1 };
    expect(dispatched(state, p)).toEqual([1]);
    expect(dispatched({ ...state, ownedSessionIds: new Set([1]) }, p)).toEqual([]);
  });

  it('still waits on a card any session works on, and keeps the global cap', () => {
    const state = {
      ...snapshot(),
      cards: [card(1)],
      sessions: [session(1, 1, 'codex', 1)],
      ownedSessionIds: new Set<number>(),
    };
    expect(planOrchestration(own, state, now)[0]?.waitReason).toBe('active_worker');

    const crowded = {
      ...snapshot(),
      cards: [card(1)],
      sessions: Array.from({ length: 32 }, (_, i) => session(i + 1, 2, 'other', null)),
      ownedSessionIds: new Set<number>(),
    };
    expect(planOrchestration(own, crowded, now)[0]?.waitReason).toBe('global_capacity');
  });
});

describe('orchestrator recovers only In progress cards that were its own work (PM-420)', () => {
  const own = { ...policy, id: 'm1', maxWorkers: 2, maxWorkersPerProvider: 2 };
  const inProgress = (id: number) => ({ ...card(id), status: 'in_progress' }) as Card;
  const state = (ownedCardIds?: ReadonlySet<number>) => ({
    ...snapshot(),
    cards: [inProgress(1), card(2)],
    ownedSessionIds: new Set<number>(),
    ...(ownedCardIds ? { ownedCardIds } : {}),
  });

  it('leaves a foreign In progress card to the chat and still starts To do work', () => {
    const decisions = planOrchestration(own, state(new Set()), now);
    expect(decisions[0]).toMatchObject({ cardId: 1, action: 'wait', waitReason: 'foreign_work' });
    expect(decisions[1]).toMatchObject({ cardId: 2, action: 'dispatch' });
  });

  it('recovers an In progress card it worked on before', () => {
    expect(planOrchestration(own, state(new Set([1])), now)[0]).toMatchObject({
      cardId: 1,
      action: 'dispatch',
      reason: 'Recover work with no live worker',
    });
  });

  it('recovers every In progress card when ownership is not given, as before', () => {
    expect(planOrchestration(own, state(), now)[0]?.action).toBe('dispatch');
  });
});
