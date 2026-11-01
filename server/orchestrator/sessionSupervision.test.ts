import { afterEach, expect, it, vi } from 'vitest';
import { openDb } from '../db.js';
import { insertProject, insertCard, updateCard, getSetting, setSetting } from '../store.js';
import type { AgentSupervisor } from '../agents/supervisor.js';
import type { AgentSession } from '../../shared/types.js';
import type { OrchestratorConfig } from '../../shared/orchestrator.js';
import { SessionSupervision, sessionQuota } from './sessionSupervision.js';
const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.restoreAllMocks();
});
function setup() {
  const db = openDb(':memory:');
  databases.push(db);
  const project = insertProject(db, 'Scoped', '/scope');
  const other = insertProject(db, 'Other', '/other');
  const card = insertCard(db, project, {
    title: 'Unfinished task',
    description: '',
    status: 'in_progress',
  });
  const policy: OrchestratorConfig = {
    id: 'master',
    name: 'Master',
    enabled: true,
    strategy: 'autonomous',
    superviseSessions: true,
    delegateToSessions: true,
    projectIds: [project],
    providers: ['codex', 'claude'],
    maxWorkers: 4,
    maxWorkersPerProject: 2,
    maxWorkersPerProvider: 4,
    reservePercent: 10,
    allowUnknownQuota: true,
    quotaMaxAgeMs: 60000,
  };
  const session = {
    id: 7,
    projectId: project,
    cardId: card.id,
    cardKey: card.key,
    name: 'Worker',
    providerId: 'codex',
    codexAccountId: 'saved',
    status: 'running',
    tailState: 'idle',
    queuedInputBytes: 0,
    question: null,
    startedAt: new Date().toISOString(),
    lastOutputAt: null,
  } as AgentSession;
  let screen = 'Implemented first part\n\u203a ';
  const limits = {
    providerId: 'codex',
    asOf: new Date().toISOString(),
    source: 'test',
    windows: [{ label: '5-hour', windowMinutes: 300, usedPercent: 20, resetsAt: null }],
  };
  const supervisor = {
    getSession: (id: number) => (id === 7 ? session : null),
    listAllSessions: () => [session],
    sessionScreen: () => screen,
    codexAccountsState: () => ({
      accounts: [{ id: 'saved', usageStatus: 'fresh', limits }],
      defaultAccount: {
        usageStatus: 'fresh',
        limits: { ...limits, windows: [{ ...limits.windows[0], usedPercent: 0 }] },
      },
    }),
    claudeAccountsState: () => ({
      defaultAccount: { usageStatus: 'fresh', limits: { ...limits, providerId: 'claude' } },
    }),
    refreshCodexAccountsUsage: vi.fn(async () => undefined),
    refreshClaudeAccountsUsage: vi.fn(async () => undefined),
    sendInput: vi.fn((_id: number, _text: string, _record: boolean) => ({ queued: false })),
    startSession: vi.fn(async () => {
      session.status = 'running';
      return session;
    }),
  };
  const events = vi.fn();
  const make = () =>
    new SessionSupervision(
      db,
      supervisor as unknown as AgentSupervisor,
      null,
      (id) => (['master', 'second'].includes(id) ? { ...policy, id } : undefined),
      events,
    );
  return {
    db,
    project,
    other,
    card,
    policy,
    session,
    limits,
    supervisor,
    events,
    control: make(),
    make,
    setScreen: (value: string) => {
      screen = value;
    },
  };
}
it('continues enrolled unfinished sessions once per progress state, including after restart', async () => {
  const t = setup();
  t.control.enroll('master', 7, true);
  await t.control.tick('master');
  expect(t.supervisor.sendInput).toHaveBeenCalledTimes(1);
  expect(t.supervisor.sendInput.mock.calls[0]?.[1]).toContain(t.card.key);
  await t.control.tick('master');
  expect(t.supervisor.sendInput).toHaveBeenCalledTimes(1);
  const later = Date.now() + 61000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  t.limits.asOf = new Date(later).toISOString();
  expect(t.make().inspect('master', 7).reason).toContain('No new progress');
  t.setScreen('Implemented next part\n\u203a ');
  await t.make().tick('master');
  expect(t.supervisor.sendInput).toHaveBeenCalledTimes(2);
  updateCard(t.db, t.card.id, { status: 'review' });
  expect(t.control.inspect('master', 7).canContinue).toBe(false);
});
it.each(['working', 'input', 'question', 'queue', 'draft', 'quota', 'reset', 'stale', 'native'])(
  'waits for %s without sending',
  async (reason) => {
    const t = setup();
    t.control.enroll('master', 7, true);
    if (reason === 'working') t.session.tailState = 'running';
    if (reason === 'input') t.session.tailState = 'input';
    if (reason === 'question') t.session.question = 'Choose an approach?';
    if (reason === 'queue') t.session.queuedInputBytes = 5;
    if (reason === 'draft') t.setScreen('reply\n\u203a owner draft');
    if (reason === 'quota') t.limits.windows[0]!.usedPercent = 100;
    if (reason === 'reset')
      t.limits.windows[0]!.resetsAt = new Date(Date.now() - 1000).toISOString() as never;
    if (reason === 'stale') t.limits.asOf = new Date(Date.now() - 120000).toISOString();
    if (reason === 'native')
      t.session.autoContinue = {
        enabled: true,
        resumesAt: new Date(Date.now() + 60000).toISOString(),
        message: 'wait',
      };
    await t.control.tick('master');
    expect(t.supervisor.sendInput).not.toHaveBeenCalled();
    expect(t.control.inspect('master', 7).canContinue).toBe(false);
  },
);
it('uses the session account rather than healthy default quota and fails closed for unknown identity', () => {
  const t = setup();
  t.limits.windows[0]!.usedPercent = 99;
  expect(t.control.inspect('master', 7).reason).toContain('reserve');
  t.session.codexAccountId = 'missing';
  expect(t.control.inspect('master', 7).reason).toContain('missing');
});
it('blocks paused, watch-only, off, completed, provider and project scope changes', async () => {
  for (const mode of ['paused', 'observe', 'off', 'delegation', 'scope', 'provider', 'done']) {
    const t = setup();
    t.control.enroll('master', 7, true);
    if (mode === 'paused') t.policy.enabled = false;
    if (mode === 'observe') t.policy.strategy = 'observe';
    if (mode === 'off') t.policy.superviseSessions = false;
    if (mode === 'delegation') t.policy.delegateToSessions = false;
    if (mode === 'scope') t.policy.projectIds = [t.other];
    if (mode === 'provider') t.policy.providers = ['claude'];
    if (mode === 'done') updateCard(t.db, t.card.id, { status: 'done' });
    await t.control.tick('master');
    expect(t.supervisor.sendInput).not.toHaveBeenCalled();
  }
});
it('enforces single-owner enrollment, release and card identity', async () => {
  const t = setup();
  t.control.enroll('master', 7, true);
  expect(() => t.control.enroll('second', 7, true)).toThrow(/another/);
  expect(() => t.control.continue('second', 7)).toThrow(/Another/);
  const newCard = insertCard(t.db, t.project, {
    title: 'Other task',
    description: '',
    status: 'in_progress',
  });
  t.session.cardId = newCard.id;
  await t.control.tick('master');
  expect(t.supervisor.sendInput).not.toHaveBeenCalled();
  t.control.enroll('master', 7, false);
  expect(t.control.inspect('master', 7).supervised).toBe(false);
});
it('never automatically wakes stopped sessions and explicitly wakes without sending', async () => {
  const t = setup();
  t.control.enroll('master', 7, true);
  t.session.status = 'exited';
  await t.control.tick('master');
  expect(t.supervisor.startSession).not.toHaveBeenCalled();
  expect(t.control.inspect('master', 7).canWake).toBe(true);
  await t.control.wake('master', 7);
  expect(t.supervisor.startSession).toHaveBeenCalledWith(7);
  expect(t.supervisor.sendInput).not.toHaveBeenCalled();
});
it('respects lease cancellation across asynchronous quota refresh', async () => {
  const t = setup();
  t.control.enroll('master', 7, true);
  t.limits.asOf = new Date(Date.now() - 120000).toISOString();
  let active = true;
  t.supervisor.refreshCodexAccountsUsage.mockImplementationOnce(async () => {
    active = false;
    t.limits.asOf = new Date().toISOString();
  });
  await t.control.tick('master', () => active);
  expect(t.supervisor.sendInput).not.toHaveBeenCalled();
});
it('persists uncertain sends before delivery so they cannot be replayed', async () => {
  const t = setup();
  t.control.enroll('master', 7, true);
  t.supervisor.sendInput.mockImplementationOnce(() => {
    throw new Error('Unknown acknowledgement');
  });
  expect(() => t.control.continue('master', 7)).toThrow(/acknowledgement/);
  expect(getSetting(t.db, 'orchestrator-session-supervision:7')).toMatchObject({
    owner: 'master',
    enabled: true,
  });
  expect(() => t.make().continue('master', 7)).toThrow(/previous continuation/);
});
it('does not assume reset or malformed quota is usable', () => {
  const t = setup();
  t.limits.windows[0]!.usedPercent = NaN;
  expect(sessionQuota(t.policy, 'codex', [t.limits], Date.now())).toContain('fresh');
});

it('keeps delivery deduplication across repeated enrollment and release', () => {
  const t = setup();
  t.control.enroll('master', 7, true);
  t.control.continue('master', 7);
  t.control.enroll('master', 7, true);
  expect(() => t.control.continue('master', 7)).toThrow(/previous continuation/);
  t.control.enroll('master', 7, false);
  t.control.enroll('second', 7, true);
  expect(() => t.control.continue('second', 7)).toThrow(/previous continuation/);
  expect(t.supervisor.sendInput).toHaveBeenCalledTimes(1);
});
it('serializes concurrent wake requests', async () => {
  const t = setup();
  t.session.status = 'exited';
  let release!: (s: AgentSession) => void;
  t.supervisor.startSession.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = t.control.wake('master', 7);
  await expect(t.control.wake('master', 7)).rejects.toThrow(/already in progress/);
  release(t.session);
  await first;
  expect(t.supervisor.startSession).toHaveBeenCalledTimes(1);
});
it('checks Claude prompts and quota without taking over native waits', async () => {
  const t = setup();
  t.session.providerId = 'claude';
  t.setScreen('Work remains\n\u276f ');
  t.control.enroll('master', 7, true);
  await t.control.tick('master');
  expect(t.supervisor.sendInput).toHaveBeenCalledTimes(1);
  t.session.usageLimit = { message: 'Usage limit' } as AgentSession['usageLimit'];
  expect(t.control.inspect('master', 7).canContinue).toBe(false);
});

it('allows taking over enrollment left by a deleted orchestrator', () => {
  const t = setup();
  setSetting(t.db, 'orchestrator-session-supervision:7', {
    owner: 'deleted-master',
    enabled: true,
    cardId: t.card.id,
  });
  expect(t.control.enroll('master', 7, true).supervised).toBe(true);
});
