import { describe, expect, it } from 'vitest';
import { rollOver } from '../agents/limits.js';
import type { Card, AgentRun } from '../../shared/types.js';
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
