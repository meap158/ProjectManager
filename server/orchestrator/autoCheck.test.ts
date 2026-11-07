import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { openDb } from '../db.js';
import { insertProject, insertCard, updateCard, setSetting } from '../store.js';
import type { AgentSession } from '../../shared/types.js';
import type { OrchestratorConfig } from '../../shared/orchestrator.js';
import type { ProviderLimits } from '../../shared/limits.js';
import {
  AutoCheck,
  AUTO_CHECK_FALLBACK_MS,
  AUTO_CHECK_MIN_GAP_MS,
  PLAN_MAX_PER_DAY,
} from './autoCheck.js';

let limits: ProviderLimits[] = [];
vi.mock('../agents/limits.js', () => ({ readLimits: () => limits }));
const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  limits = [];
});

const MIN = 60_000;
const idleChat = { id: 99, status: 'running', tailState: 'idle', queuedInputBytes: 0 };
function setup(over: Partial<OrchestratorConfig> = {}) {
  const db = openDb(':memory:');
  databases.push(db);
  const project = insertProject(db, 'Scoped', '/scope');
  const card = insertCard(db, project, {
    title: 'Task',
    description: '',
    status: 'in_progress',
  }).id;
  const policy: OrchestratorConfig = {
    id: 'm',
    name: 'M',
    enabled: true,
    strategy: 'autonomous',
    autoCheck: true,
    projectIds: [project],
    providers: ['codex'],
    maxWorkers: 4,
    maxWorkersPerProject: 2,
    maxWorkersPerProvider: 4,
    reservePercent: 10,
    allowUnknownQuota: true,
    quotaMaxAgeMs: 10 * MIN,
    ...over,
  };
  const state = {
    policy,
    now: Date.parse('2026-11-03T10:00:00Z'),
    sessions: [] as AgentSession[],
    chat: idleChat as unknown as AgentSession | null,
    checks: 0,
    focuses: [] as string[],
    events: [] as string[],
    fail: false,
  };
  const make = () =>
    new AutoCheck({
      db,
      dataDir: null,
      listSessions: () => state.sessions,
      policy: () => state.policy,
      instances: () => [state.policy],
      chatSession: () => state.chat,
      check: async (_id, focus) => {
        if (state.fail) throw new Error('409');
        state.checks++;
        state.focuses.push(focus);
      },
      record: (_id, message) => state.events.push(message),
      now: () => state.now,
    });
  const worker = (tailState: string) =>
    ({
      id: 5,
      projectId: project,
      cardId: card,
      status: 'running',
      tailState,
      queuedInputBytes: 0,
    }) as unknown as AgentSession;
  setSetting(db, 'orchestrator-owned-sessions:m', [{ sessionId: 5, cardId: card }]);
  return { db, project, card, state, make, worker, auto: make() };
}

it('checks when an owned session goes idle, after the minimum gap', async () => {
  const t = setup();
  t.state.sessions = [t.worker('running')];
  await t.auto.tick();
  expect(t.state.checks).toBe(0);
  t.state.sessions = [t.worker('idle')];
  t.state.now += MIN;
  await t.auto.tick();
  expect(t.state.checks).toBe(0);
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  await t.auto.tick();
  expect(t.state.checks).toBe(1);
  expect(t.state.events[0]).toContain('session 5 stopped working');
});

it('checks when an owned session ends', async () => {
  const t = setup();
  t.state.sessions = [t.worker('running')];
  await t.auto.tick();
  t.state.sessions = [];
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  await t.auto.tick();
  expect(t.state.checks).toBe(1);
});

it('checks when a card moves to Review', async () => {
  const t = setup();
  await t.auto.tick();
  updateCard(t.db, t.card, { status: 'review' });
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  await t.auto.tick();
  expect(t.state.checks).toBe(1);
  expect(t.state.events[0]).toContain('moved to Review');
});

it('checks when a provider quota recovers above the reserve', async () => {
  const t = setup({ allowUnknownQuota: false });
  const quota = (used: number) =>
    ({
      providerId: 'codex',
      asOf: new Date(t.state.now).toISOString(),
      windows: [{ label: '5h', usedPercent: used }],
    }) as unknown as ProviderLimits;
  limits = [quota(99)];
  await t.auto.tick();
  limits = [quota(10)];
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  limits = [{ ...quota(10), asOf: new Date(t.state.now).toISOString() }];
  await t.auto.tick();
  expect(t.state.checks).toBe(1);
  expect(t.state.events[0]).toContain('codex quota recovered');
});

it('falls back to a slow check when work is pending, and not before', async () => {
  const t = setup();
  await t.auto.tick();
  t.state.now += AUTO_CHECK_FALLBACK_MS - MIN;
  await t.auto.tick();
  expect(t.state.checks).toBe(0);
  t.state.now += MIN;
  await t.auto.tick();
  expect(t.state.checks).toBe(1);
  expect(t.state.events[0]).toContain('slow fallback');
});

it('has no fallback when nothing is pending', async () => {
  const t = setup();
  updateCard(t.db, t.card, { status: 'done' });
  await t.auto.tick();
  t.state.now += AUTO_CHECK_FALLBACK_MS * 2;
  await t.auto.tick();
  expect(t.state.checks).toBe(0);
});

it('caps automatic checks at four an hour', async () => {
  const t = setup();
  await t.auto.tick();
  for (let i = 0; i < 6; i++) {
    t.state.now += AUTO_CHECK_MIN_GAP_MS;
    const id = insertCard(t.db, t.project, { title: `r${i}`, description: '', status: 'todo' }).id;
    updateCard(t.db, id, { status: 'review' });
    await t.auto.tick();
  }
  expect(t.state.checks).toBe(4);
  t.state.now += 70 * MIN;
  await t.auto.tick();
  expect(t.state.checks).toBe(5);
});

it('keeps a trigger pending while the chat is busy, asking, queued or stopped, then sends once', async () => {
  const t = setup();
  await t.auto.tick();
  updateCard(t.db, t.card, { status: 'review' });
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  const blocked = [
    { ...idleChat, tailState: 'running' },
    { ...idleChat, tailState: 'input' },
    { ...idleChat, queuedInputBytes: 5 },
    { ...idleChat, status: 'stopped' },
    null,
  ];
  for (const chat of blocked) {
    t.state.chat = chat as unknown as AgentSession | null;
    await t.auto.tick();
    expect(t.state.checks).toBe(0);
  }
  t.state.chat = idleChat as unknown as AgentSession;
  t.state.fail = true; // chat.check's own 409 guard
  await t.auto.tick();
  expect(t.state.checks).toBe(0);
  t.state.fail = false;
  await t.auto.tick();
  await t.auto.tick();
  expect(t.state.checks).toBe(1);
});

it('does nothing when off, paused or watch-only, and restarts from a fresh look', async () => {
  const offs: Partial<OrchestratorConfig>[] = [
    { autoCheck: false },
    { enabled: false },
    { strategy: 'observe' },
  ];
  for (const off of offs) {
    const t = setup();
    await t.auto.tick();
    t.state.policy = { ...t.state.policy, ...off };
    updateCard(t.db, t.card, { status: 'review' });
    t.state.now += AUTO_CHECK_FALLBACK_MS * 2;
    await t.auto.tick();
    expect(t.state.checks).toBe(0);
    t.state.policy = { ...t.state.policy, autoCheck: true, enabled: true, strategy: 'autonomous' };
    await t.auto.tick();
    expect(t.state.checks).toBe(0);
  }
});

it('a restart neither repeats a sent check nor loses a change made while down', async () => {
  const t = setup();
  await t.auto.tick();
  updateCard(t.db, t.card, { status: 'review' });
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  await t.auto.tick();
  expect(t.state.checks).toBe(1);
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  await t.make().tick();
  expect(t.state.checks).toBe(1);
  insertCard(t.db, t.project, { title: 'later', description: '', status: 'review' });
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  await t.make().tick();
  expect(t.state.checks).toBe(2);
});

it('does not repeat the fallback on a board that has not changed since its last check', async () => {
  const t = setup();
  await t.auto.tick();
  t.state.now += AUTO_CHECK_FALLBACK_MS;
  await t.auto.tick();
  expect(t.state.checks).toBe(1);
  // Everything is still waiting on the owner: hours pass, no more checks.
  for (let i = 0; i < 4; i++) {
    t.state.now += AUTO_CHECK_FALLBACK_MS;
    await t.auto.tick();
  }
  expect(t.state.checks).toBe(1);
  // A new To do card changes the board; the next fallback looks again.
  insertCard(t.db, t.project, { title: 'New work', description: '', status: 'todo' });
  t.state.now += AUTO_CHECK_FALLBACK_MS;
  await t.auto.tick();
  expect(t.state.checks).toBe(2);
  expect(t.state.events[1]).toContain('board changed');
});

it('skips quota recovery when nothing is to do and the board has not moved since its last check', async () => {
  const t = setup({ allowUnknownQuota: false });
  const quota = (used: number) =>
    [
      {
        providerId: 'codex',
        asOf: new Date(t.state.now).toISOString(),
        windows: [{ label: '5h', usedPercent: used }],
      },
    ] as unknown as ProviderLimits[];
  limits = quota(10);
  await t.auto.tick();
  t.state.now += AUTO_CHECK_FALLBACK_MS;
  limits = quota(10);
  await t.auto.tick(); // the fallback looks once and records the board
  expect(t.state.checks).toBe(1);
  // Quota runs out and comes back, twice: the same board, nothing to hand out.
  for (let i = 0; i < 2; i++) {
    t.state.now += AUTO_CHECK_MIN_GAP_MS;
    limits = quota(99);
    await t.auto.tick();
    t.state.now += AUTO_CHECK_MIN_GAP_MS;
    limits = quota(10);
    await t.auto.tick();
  }
  expect(t.state.checks).toBe(1);
  // With a To do card waiting, recovered quota is worth a look.
  insertCard(t.db, t.project, { title: 'Ready', description: '', status: 'todo' });
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  limits = quota(99);
  await t.auto.tick();
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  limits = quota(10);
  await t.auto.tick();
  expect(t.state.checks).toBe(2);
  expect(t.state.events[1]).toContain('codex quota recovered');
});

it('asks an idle project to plan once per change of its roadmap or cards (PM-426)', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-plan-'));
  try {
    const t = setup({ planFromGoals: true });
    t.db.prepare('UPDATE projects SET path = ? WHERE id = ?').run(dir, t.project);
    writeFileSync(path.join(dir, 'ROADMAP.md'), '# Roadmap\n- Phase 1: ship it\n');
    await t.auto.tick(); // baseline
    t.state.now += AUTO_CHECK_MIN_GAP_MS;
    await t.auto.tick();
    expect(t.state.checks).toBe(0); // a card is in progress: not idle
    updateCard(t.db, t.card, { status: 'done' });
    t.state.now += AUTO_CHECK_MIN_GAP_MS;
    await t.auto.tick();
    expect(t.state.focuses).toEqual(['plan']);
    expect(t.state.events.at(-1)).toContain('has nothing to do');
    // Nothing changed: the same answer is not asked for again.
    t.state.now += AUTO_CHECK_FALLBACK_MS * 2;
    await t.auto.tick();
    expect(t.state.checks).toBe(1);
    // The roadmap moved on: plan again.
    writeFileSync(path.join(dir, 'ROADMAP.md'), '# Roadmap\n- Phase 2: grow it\n');
    t.state.now += AUTO_CHECK_MIN_GAP_MS;
    await t.auto.tick();
    expect(t.state.focuses).toEqual(['plan', 'plan']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('never plans while the setting is off, watch-only, or past the daily bound', async () => {
  const off = setup();
  updateCard(off.db, off.card, { status: 'done' });
  await off.auto.tick();
  off.state.now += AUTO_CHECK_MIN_GAP_MS;
  await off.auto.tick();
  expect(off.state.checks).toBe(0);

  const t = setup({ planFromGoals: true });
  updateCard(t.db, t.card, { status: 'done' });
  await t.auto.tick();
  for (let i = 0; i < PLAN_MAX_PER_DAY + 2; i++) {
    insertCard(t.db, t.project, { title: `Done ${i}`, description: '', status: 'done' });
    t.state.now += 16 * MIN; // inside the hourly bound
    await t.auto.tick();
  }
  expect(t.state.checks).toBe(PLAN_MAX_PER_DAY);
});

it('keeps bringing an active goal back, hourly once it goes quiet, never blocking it (PM-433, PM-459)', async () => {
  const { addGoal, listGoals, GOAL_NUDGE_MS, GOAL_QUIET_NUDGE_MS, GOAL_STALL_CHECKS } =
    await import('./goals.js');
  const t = setup();
  await t.auto.tick(); // baseline
  addGoal(t.db, 'm', { title: 'Ship login', objective: 'o', doneWhen: 'd' });
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  await t.auto.tick();
  expect(t.state.focuses).toEqual(['goal']);
  expect(t.state.events.at(-1)).toContain('goal "Ship login" continues');
  // Not again before the interval.
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  await t.auto.tick();
  expect(t.state.checks).toBe(1);
  for (let i = 1; i < GOAL_STALL_CHECKS; i++) {
    t.state.now += GOAL_NUDGE_MS;
    await t.auto.tick();
  }
  expect(t.state.checks).toBe(GOAL_STALL_CHECKS);
  expect(listGoals(t.db, 'm')[0]!.status).toBe('active');
  expect(t.state.events.some((e) => e.includes('stays active'))).toBe(true);
  t.state.now += GOAL_NUDGE_MS;
  await t.auto.tick();
  expect(t.state.checks).toBe(GOAL_STALL_CHECKS); // quiet: not every 15 minutes any more
  t.state.now += GOAL_QUIET_NUDGE_MS;
  await t.auto.tick();
  expect(t.state.checks).toBe(GOAL_STALL_CHECKS + 1); // but hourly
});

it('asks the chat to close a goal once every linked card is Done, once per card set (PM-454)', async () => {
  const { addGoal, GOAL_NUDGE_MS } = await import('./goals.js');
  const { updateCard } = await import('../store.js');
  const t = setup();
  await t.auto.tick(); // baseline
  addGoal(t.db, 'm', { title: 'Ship login', objective: 'o', doneWhen: 'd', cardIds: [t.card] });
  t.state.now += AUTO_CHECK_MIN_GAP_MS;
  await t.auto.tick(); // the ordinary goal check
  updateCard(t.db, t.card, { status: 'done' });
  t.state.now += AUTO_CHECK_MIN_GAP_MS; // well before the next 15-minute nudge
  await t.auto.tick();
  expect(t.state.checks).toBe(2);
  expect(t.state.events.at(-1)).toContain('goal "Ship login" has every linked card Done');
  t.state.now += GOAL_NUDGE_MS;
  await t.auto.tick();
  expect(t.state.events.at(-1)).not.toContain('has every linked card Done');
});

it('does not block a goal whose linked card is being worked on (PM-456)', async () => {
  const { addGoal, listGoals, GOAL_NUDGE_MS, GOAL_STALL_CHECKS } = await import('./goals.js');
  const t = setup();
  t.state.sessions = [
    { id: 5, status: 'running', tailState: 'running', cardId: t.card } as unknown as AgentSession,
  ];
  await t.auto.tick(); // baseline
  addGoal(t.db, 'm', { title: 'Ship login', objective: 'o', doneWhen: 'd', cardIds: [t.card] });
  for (let i = 0; i < GOAL_STALL_CHECKS + 1; i++) {
    t.state.now += GOAL_NUDGE_MS;
    await t.auto.tick();
  }
  expect(listGoals(t.db, 'm')[0]!.status).toBe('active');
  expect(listGoals(t.db, 'm')[0]!.nudgesWithoutProgress).toBe(0);
});
