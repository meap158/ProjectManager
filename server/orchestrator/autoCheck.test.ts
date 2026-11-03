import { afterEach, expect, it, vi } from 'vitest';
import { openDb } from '../db.js';
import { insertProject, insertCard, updateCard, setSetting } from '../store.js';
import type { AgentSession } from '../../shared/types.js';
import type { OrchestratorConfig } from '../../shared/orchestrator.js';
import type { ProviderLimits } from '../../shared/limits.js';
import { AutoCheck, AUTO_CHECK_FALLBACK_MS, AUTO_CHECK_MIN_GAP_MS } from './autoCheck.js';

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
      check: async () => {
        if (state.fail) throw new Error('409');
        state.checks++;
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
