import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
// The machine's own disk and memory must not decide these tests (PM-424 has its own).
vi.mock('./resources.js', () => ({ resourceBlock: () => undefined }));
import { openDb } from '../db.js';
import { getCard, insertCard, insertProject, updateCard } from '../store.js';
import { SopStore } from '../sops.js';
import type { AgentSupervisor } from '../agents/supervisor.js';
import type { AgentRun, AgentSession, ProjectSummary } from '../../shared/types.js';
import type { OrchestratorConfig } from '../../shared/orchestrator.js';
import type { OrchestratorService } from './service.js';
import {
  OrchestratorChat,
  briefing,
  checkPrompt,
  goalFollowUpPrompt,
  goalStatusBlock,
  parseVerdict,
  withAcceptance,
  acceptanceOf,
  pruneArtifacts,
} from './chat.js';
import { readLimits } from '../agents/limits.js';
import { OrchestratorAssignments } from './assignments.js';
import { providerStatuses } from '../agents/providers.js';

vi.mock('../agents/providers.js', () => ({
  providerStatuses: vi.fn(async () => [
    { id: 'claude', available: true },
    { id: 'codex', available: true },
  ]),
}));

vi.mock('../agents/limits.js', () => ({
  readLimits: vi.fn(() => [
    { providerId: 'codex', asOf: new Date().toISOString(), windows: [{ usedPercent: 20 }] },
  ]),
}));

const tmp = mkdtempSync(path.join(os.tmpdir(), 'pm-orch-chat-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const counts = { backlog: 0, todo: 1, in_progress: 0, review: 0, done: 0 };
const summary = (id: number, name: string): ProjectSummary =>
  ({
    id,
    name,
    path: path.join(tmp, name),
    cardCounts: counts,
    git: null,
    missing: false,
  }) as unknown as ProjectSummary;

function setup(overrides: Partial<OrchestratorConfig> = {}, attachmentsRoot: string | null = null) {
  const db = openDb(':memory:');
  const a = insertProject(db, 'Alpha', path.join(tmp, 'Alpha'));
  const b = insertProject(db, 'Beta', path.join(tmp, 'Beta'));
  const mine = insertCard(db, a, { title: 'Add login', description: 'Spec', status: 'todo' });
  const other = insertCard(db, b, { title: 'Not mine', description: '', status: 'todo' });
  const instance: OrchestratorConfig = {
    id: 'master-1',
    name: 'Games',
    enabled: true,
    strategy: 'autonomous',
    projectIds: [a],
    providers: ['codex'],
    maxWorkers: 2,
    maxWorkersPerProject: 1,
    maxWorkersPerProvider: 2,
    reservePercent: 10,
    allowUnknownQuota: false,
    quotaMaxAgeMs: 600000,
    ...overrides,
  };
  const sessions: Partial<AgentSession>[] = [];
  const runs: Partial<AgentRun>[] = [];
  const supervisor = {
    listAllSessions: () => sessions,
    listAllRuns: () => runs,
    listRuns: () => [],
    getSession: (id: number) => sessions.find((s) => s.id === id) ?? null,
    getRun: () => null,
    sessionScreen: () => 'screen text',
    sendInput: vi.fn(),
    dispatchCard: vi.fn(async (projectId: number, cardId: number, _options?: unknown) => ({
      id: 77,
      projectId,
      cardId,
      name: 'run',
      providerId: 'codex',
      status: 'queued',
      error: null,
      validation: null,
      changes: null,
      startedAt: null,
      endedAt: null,
    })),
  };
  const record = vi.fn();
  const sessionSupervision = {
    check: vi.fn(async () => ({ canContinue: false, reason: 'test wait' })),
    enroll: vi.fn(),
    continue: vi.fn(),
    wake: vi.fn(),
    assertCanEnroll: vi.fn(),
  };
  const service = {
    sessionSupervision,
    state: () => ({ instances: [instance], events: [] }),
    situation: () => ({ generatedAt: '', needsAttention: [], beingWorkedOn: [] }),
    record,
  } as unknown as OrchestratorService;
  const chat = new OrchestratorChat(
    db,
    supervisor as unknown as AgentSupervisor,
    service,
    () => [summary(a, 'Alpha'), summary(b, 'Beta')],
    tmp,
    new SopStore(null),
    attachmentsRoot,
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    chat.call('master-1', 5, name, args);
  return {
    db,
    a,
    b,
    mine,
    other,
    chat,
    call,
    sessions,
    runs,
    supervisor,
    record,
    instance,
    sessionSupervision,
  };
}

describe('orchestrator chat tools (PM-89)', () => {
  it('audits only its own projects against the SOPs, and turns a gap there into a card (PM-316)', async () => {
    const { call, db, a, b } = setup();
    mkdirSync(path.join(tmp, 'Alpha'), { recursive: true });
    const report = (await call('sop_report')) as {
      projects: { project: string; results: { sopId: string; state: string }[] }[];
    };
    expect(report.projects.map((p) => p.project)).toEqual(['Alpha']);
    expect(report.projects[0]!.results.map((r) => r.sopId)).toContain('roadmap');
    await expect(call('sop_report', { projectId: b })).rejects.toThrow(/not in this/);
    await expect(call('sop_card', { projectId: b, sopId: 'roadmap' })).rejects.toThrow(
      /not in this/,
    );
    await expect(call('sop_card', { projectId: a, sopId: 'nope' })).rejects.toThrow(/No SOP/);
    const card = (await call('sop_card', { projectId: a, sopId: 'roadmap' })) as { id: number };
    expect(getCard(db, card.id)).toMatchObject({
      projectId: a,
      title: 'SOP: Roadmap',
      status: 'todo',
    });
  });

  it('sees only its own projects: overview, list and cards elsewhere are refused', async () => {
    const { call, mine, other, b } = setup();
    const overview = (await call('overview')) as {
      projects: { name: string }[];
      todo: { cards: { key: string }[] };
    };
    expect(overview.projects.map((p) => p.name)).toEqual(['Alpha']);
    expect(overview.todo.cards.map((c) => c.key)).toEqual([mine.key]);
    const list = (await call('list_cards', { status: 'todo' })) as { cards: { id: number }[] };
    expect(list.cards.map((c) => c.id)).toEqual([mine.id]);
    await expect(call('get_card', { card: other.key })).rejects.toThrow(/not in this orchestrator/);
    await expect(call('list_cards', { projectId: b })).rejects.toThrow(/not in this/);
    await expect(call('create_card', { projectId: b, title: 'x' })).rejects.toThrow(/not in this/);
  });

  it('owns "All projects" cards when it covers every project: list, read, annotate, create', async () => {
    const { call, db, mine, other } = setup({ projectIds: [] });
    const global = insertCard(db, 0, { title: 'Align Projects', description: '', status: 'todo' });
    const overview = (await call('overview')) as {
      todo: { cards: { key: string; project: string }[] };
    };
    expect(overview.todo.cards.map((c) => c.key).sort()).toEqual(
      [global.key, mine.key, other.key].sort(),
    );
    expect(overview.todo.cards.find((c) => c.key === global.key)?.project).toBe('All projects');
    const list = (await call('list_cards', { status: 'todo' })) as { cards: { id: number }[] };
    expect(list.cards.map((c) => c.id)).toContain(global.id);
    const onlyGlobal = (await call('list_cards', { projectId: 0 })) as { cards: { id: number }[] };
    expect(onlyGlobal.cards.map((c) => c.id)).toEqual([global.id]);
    expect(await call('get_card', { card: global.key })).toMatchObject({ key: global.key });
    await call('update_card', { card: global.key, status: 'review', note: 'Checked it' });
    expect(getCard(db, global.id)).toMatchObject({ status: 'review', projectId: 0 });
    const made = (await call('create_card', { projectId: 0, title: 'Portfolio task' })) as {
      id: number;
    };
    expect(getCard(db, made.id)?.projectId).toBe(0);
  });

  it('cannot start a worker on a card that belongs to no project, and says what to do', async () => {
    const { call, db, supervisor } = setup({ projectIds: [] });
    const global = insertCard(db, 0, { title: 'Align Projects', description: '', status: 'todo' });
    await expect(call('dispatch_worker', { card: global.key })).rejects.toThrow(
      /belongs to no project.*directly in this chat/s,
    );
    expect(supervisor.dispatchCard).not.toHaveBeenCalled();
  });

  it('leaves "All projects" cards alone when it is limited to chosen projects', async () => {
    const { call, db, mine } = setup(); // projectIds: [Alpha]
    const global = insertCard(db, 0, { title: 'Align Projects', description: '', status: 'todo' });
    const overview = (await call('overview')) as { todo: { cards: { key: string }[] } };
    expect(overview.todo.cards.map((c) => c.key)).toEqual([mine.key]);
    // "All projects" is a project it does not have, like any other project outside its scope.
    await expect(call('list_cards', { projectId: 0 })).rejects.toThrow(/not in this orchestrator/);
    await expect(call('get_card', { card: global.key })).rejects.toThrow(
      /not in this orchestrator/,
    );
    await expect(call('update_card', { card: global.key, note: 'x' })).rejects.toThrow(
      /not in this orchestrator/,
    );
    await expect(call('create_card', { projectId: 0, title: 'x' })).rejects.toThrow(/not in this/);
  });

  it('moves a card with a note, audited and recorded in Decision history', async () => {
    const { call, db, mine, record } = setup();
    await call('update_card', { card: mine.key, status: 'in_progress', note: 'Starting it' });
    const card = getCard(db, mine.id)!;
    expect(card.status).toBe('in_progress');
    expect(card.description).toMatch(/Orchestrator note .*\nStarting it$/);
    const audit = db.prepare('SELECT owner_kind, owner_id, action FROM board_agent_audit').all();
    expect(audit).toEqual([{ owner_kind: 'session', owner_id: 5, action: 'update_card' }]);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'moved', cardId: mine.id }),
    );
    await expect(call('update_card', { card: mine.id })).rejects.toThrow(/status, a note/);
  });

  it('dispatches one-time workers within its limits, with its instructions', async () => {
    const { call, mine, supervisor, runs, a } = setup();
    const result = (await call('dispatch_worker', {
      card: mine.key,
      instructions: 'Check the tests first',
    })) as { dispatched: { runId: number } };
    expect(result.dispatched.runId).toBe(77);
    expect(supervisor.dispatchCard).toHaveBeenCalledWith(a, mine.id, {
      providerId: 'codex',
      // Settings decide a run's level (PM-419); Codex has no override, so edit.
      autonomy: 'edit',
      maxAttempts: 1,
      dispatchKey: expect.any(String),
      orchestratorId: 'master-1',
      canCommit: expect.any(Function),
      context: 'Instructions from the orchestrator:\nCheck the tests first',
    });
    // A run the owner started elsewhere in the project is not this orchestrator's (PM-417).
    // Capacity lets it through; only the card's own reservation from the first dispatch remains.
    runs.push({ id: 76, projectId: a, cardId: 998, status: 'running' });
    await expect(call('dispatch_worker', { card: mine.key })).rejects.toThrow(
      /Assignment reserved/,
    );
    // Its own run fills its per-project limit (1), which refuses another.
    runs.push({ id: 77, projectId: a, cardId: 999, status: 'running', orchestratorId: 'master-1' });
    await expect(call('dispatch_worker', { card: mine.key })).rejects.toThrow(
      /already has 1 of your 1/,
    );
    await expect(call('dispatch_worker', { card: mine.key, providerId: 'claude' })).rejects.toThrow(
      /already has|one of your providers/,
    );
  });

  it('fences changed tasks and competing global workers immediately before insertion', async () => {
    const { call, mine, supervisor, db, sessions, b } = setup();
    await call('dispatch_worker', { card: mine.key });
    const options = supervisor.dispatchCard.mock.calls[0]?.[2] as unknown as {
      canCommit: () => boolean;
    };
    expect(options.canCommit()).toBe(true);
    db.prepare("UPDATE cards SET description = 'New instructions' WHERE id = ?").run(mine.id);
    expect(options.canCommit()).toBe(false);
    db.prepare('UPDATE cards SET description = ? WHERE id = ?').run(mine.description, mine.id);
    sessions.push(
      ...Array.from({ length: 32 }, (_, id) => ({
        id,
        projectId: b,
        providerId: 'other',
        status: 'running' as const,
      })),
    );
    expect(options.canCommit()).toBe(false);
    sessions.length = 0;
    expect(options.canCommit()).toBe(true);
    db.close();
  });

  it('rejects a competing request after the first run is inserted', async () => {
    const { call, mine, supervisor, db } = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inserted = 0;
    supervisor.dispatchCard.mockImplementation(async (projectId, cardId, input) => {
      await gate;
      const options = input as { canCommit: () => boolean; dispatchKey: string };
      if (!options.canCommit()) throw new Error('Policy changed before insertion');
      inserted++;
      db.prepare(
        "INSERT INTO agent_runs(id,project_id,card_id,name,provider_id,command_json,status,created_at,log_path,dispatch_key) VALUES (77,?,?, 'Worker','codex','[]','queued','2026-10-12','',?)",
      ).run(projectId, cardId, options.dispatchKey);
      return {
        id: 77,
        projectId,
        cardId,
        name: 'run',
        providerId: 'codex',
        status: 'queued',
        error: null,
        validation: null,
        changes: null,
        startedAt: null,
        endedAt: null,
      };
    });
    const requests = [
      call('dispatch_worker', { card: mine.key }),
      call('dispatch_worker', { card: mine.key }),
    ];
    const results = Promise.allSettled(requests);
    // The durable reservation blocks the second request before preparation.
    await vi.waitFor(() => expect(supervisor.dispatchCard).toHaveBeenCalledTimes(1));
    release();
    const outcomes = await results;
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(inserted).toBe(1);
    expect(
      db
        .prepare('SELECT state,run_id FROM orchestrator_assignments WHERE card_id = ?')
        .get(mine.id),
    ).toMatchObject({ state: 'assigned', run_id: 77 });
    db.close();
  });

  it('refunds a denied insertion so edited work can be dispatched immediately', async () => {
    const { call, mine, supervisor, db } = setup();
    supervisor.dispatchCard.mockImplementationOnce(async (_projectId, cardId, input) => {
      db.prepare("UPDATE cards SET description = 'Updated task' WHERE id = ?").run(cardId);
      expect((input as { canCommit: () => boolean }).canCommit()).toBe(false);
      throw new Error('Insertion denied');
    });
    await expect(call('dispatch_worker', { card: mine.key })).rejects.toThrow('Insertion denied');
    expect(
      db
        .prepare('SELECT state,attempts,retry_after FROM orchestrator_assignments WHERE card_id=?')
        .get(mine.id),
    ).toMatchObject({ state: 'error', attempts: 0, retry_after: 0 });
    await call('dispatch_worker', { card: mine.key });
    expect(supervisor.dispatchCard).toHaveBeenCalledTimes(2);
    db.close();
  });

  it.each(['success', 'failure'] as const)(
    'keeps slow chat preparation reserved and clears its heartbeat after %s',
    async (outcome) => {
      vi.useFakeTimers();
      const { call, mine, supervisor, db } = setup();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      supervisor.dispatchCard.mockImplementation(async (projectId, cardId, input) => {
        await gate;
        if (outcome === 'failure') throw new Error('Provider preparation failed');
        const options = input as { canCommit: () => boolean; dispatchKey: string };
        expect(options.canCommit()).toBe(true);
        db.prepare(
          "INSERT INTO agent_runs(id,project_id,card_id,name,provider_id,command_json,status,created_at,log_path,dispatch_key) VALUES (77,?,?, 'Worker','codex','[]','queued','2026-10-12','',?)",
        ).run(projectId, cardId, options.dispatchKey);
        return {
          id: 77,
          projectId,
          cardId,
          name: 'run',
          providerId: 'codex',
          status: 'queued',
          error: null,
          validation: null,
          changes: null,
          startedAt: null,
          endedAt: null,
        };
      });
      try {
        const result = Promise.allSettled([call('dispatch_worker', { card: mine.key })]);
        await vi.advanceTimersByTimeAsync(0);
        expect(supervisor.dispatchCard).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(1);
        const initial = Date.now();
        await vi.advanceTimersByTimeAsync(180000);
        new OrchestratorAssignments(db).reconcile(undefined, Date.now());
        expect(
          db
            .prepare('SELECT state,updated_at FROM orchestrator_assignments WHERE card_id=?')
            .get(mine.id),
        ).toMatchObject({ state: 'dispatching', updated_at: initial + 180000 });
        release();
        const [finished] = await result;
        expect(finished!.status).toBe(outcome === 'success' ? 'fulfilled' : 'rejected');
        expect(
          db.prepare('SELECT state FROM orchestrator_assignments WHERE card_id=?').get(mine.id),
        ).toMatchObject({ state: outcome === 'success' ? 'assigned' : 'error' });
        expect(vi.getTimerCount()).toBe(0);
        db.close();
        // Any leaked callback would now touch a closed database.
        await vi.advanceTimersByTimeAsync(60000);
      } finally {
        release();
        vi.useRealTimers();
      }
    },
  );

  it('rechecks quota, scope, provider policy and review before insertion without toggling manual mode', async () => {
    const { call, mine, supervisor, db, instance, b } = setup({
      enabled: false,
      strategy: 'observe',
    });
    await call('dispatch_worker', { card: mine.key });
    const options = supervisor.dispatchCard.mock.calls[0]?.[2] as { canCommit: () => boolean };
    expect(options.canCommit()).toBe(true);
    expect(instance.enabled).toBe(false);
    expect(instance.strategy).toBe('observe');
    vi.mocked(readLimits).mockReturnValueOnce([
      { providerId: 'codex', asOf: new Date().toISOString(), windows: [{ usedPercent: 100 }] },
    ]);
    expect(options.canCommit()).toBe(false);
    expect(options.canCommit()).toBe(true);
    instance.projectIds = [b];
    expect(options.canCommit()).toBe(false);
    instance.projectIds = [mine.projectId];
    instance.providers = ['claude'];
    expect(options.canCommit()).toBe(false);
    instance.providers = ['codex'];
    db.prepare(
      "INSERT INTO agent_runs(id,project_id,card_id,name,provider_id,command_json,status,created_at,log_path) VALUES (88,?,?, 'Worker','codex','[]','succeeded','2026-10-12','')",
    ).run(mine.projectId, mine.id);
    expect(options.canCommit()).toBe(false);
    db.close();
  });

  it('messages only idle workers in scope, never one working or asking the user', async () => {
    const { call, sessions, supervisor, a, b } = setup();
    sessions.push(
      { id: 11, projectId: a, name: 'w1', status: 'running', tailState: 'running', cardId: null },
      { id: 12, projectId: a, name: 'w2', status: 'running', tailState: 'input', cardId: null },
      { id: 13, projectId: a, name: 'w3', status: 'running', tailState: 'idle', cardId: null },
      { id: 14, projectId: b, name: 'w4', status: 'running', tailState: 'idle', cardId: null },
    );
    await expect(call('message_worker', { sessionId: 11, text: 'status?' })).rejects.toThrow(
      /working/,
    );
    await expect(call('message_worker', { sessionId: 12, text: 'status?' })).rejects.toThrow(
      /asking the user/,
    );
    await expect(call('message_worker', { sessionId: 14, text: 'status?' })).rejects.toThrow(
      /not a worker in your scope/,
    );
    await call('message_worker', { sessionId: 13, text: 'status?' });
    expect(supervisor.sendInput).toHaveBeenCalledWith(13, '\x1b[200~status?\x1b[201~\r', false);
    const screen = (await call('worker_output', { sessionId: 13 })) as { screen: string };
    expect(screen.screen).toBe('screen text');
  });

  it('writes a briefing with its projects, settings and rules for every CLI', async () => {
    const { chat, supervisor } = setup({ strategy: 'observe' });
    const createSession = vi.fn(async () => ({ id: 1 }) as AgentSession);
    Object.assign(supervisor, { createSession });
    await chat.open('master-1');
    const home = path.join(tmp, 'orchestrators', 'master-1');
    const text = readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
    expect(readFileSync(path.join(home, 'CLAUDE.md'), 'utf8')).toBe(text);
    expect(text).toContain('**Alpha**');
    expect(text).not.toContain('**Beta**');
    expect(text).toContain('Watch only');
    expect(text).toContain('make authorized changes directly in this chat');
    expect(text).toContain('Do not dispatch workers or delegate');
    // Its own folder, its master, and a provider that can load the board tools.
    expect(createSession).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ cwd: home, orchestratorId: 'master-1', providerId: 'codex' }),
    );
    expect(briefing({ name: 'X', providers: [], projectIds: [] } as never, [])).toContain('(none)');
  });
});

describe('orchestrator chat keeps long sessions on track (PM-400)', () => {
  it("lists a card's images and returns one as native image content, in scope only", async () => {
    const root = path.join(tmp, 'attachments-400');
    const { call, mine, other, db } = setup({}, root);
    const dir = path.join(root, String(mine.id));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, '00000000-0000-0000-0000-000000000001__shot.png'), 'png-bytes');
    const card = (await call('get_card', { card: mine.key })) as {
      attachments: { index: number; name: string }[];
    };
    expect(card.attachments).toEqual([expect.objectContaining({ index: 0, name: 'shot.png' })]);
    const image = (await call('read_image', { card: mine.key, index: 0 })) as {
      mcpContent: { type: string; mimeType: string; data: string }[];
    };
    expect(image.mcpContent[0]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(Buffer.from(image.mcpContent[0]!.data, 'base64').toString()).toBe('png-bytes');
    await expect(call('read_image', { card: mine.key, index: 3 })).rejects.toThrow(/no image 3/);
    await expect(call('read_image', { card: other.key, index: 0 })).rejects.toThrow(
      /not in this orchestrator/,
    );
    db.close();
  });

  it('briefs a reopened chat with its handover file, artefacts folder and recent activity', () => {
    const base = {
      name: 'X',
      providers: ['codex'],
      projectIds: [],
    } as unknown as OrchestratorConfig;
    const text = briefing(
      base,
      [],
      [
        {
          at: '2026-11-02T10:15:00.000Z',
          orchestratorId: 'x',
          action: 'assigned',
          message: 'PM-4 handed to session 7 (chat)',
        },
      ],
    );
    expect(text).toContain('HANDOVER.md');
    expect(text).toContain('artifacts/');
    expect(text).toContain('2026-11-02 10:15 assigned: PM-4 handed to session 7');
    expect(briefing(base, [])).not.toContain('Your recent activity');
  });

  it('keeps the artefacts folder to the newest files within its caps', () => {
    const dir = path.join(tmp, 'artifacts-400');
    mkdirSync(dir, { recursive: true });
    for (let i = 0; i < 5; i++) {
      const file = path.join(dir, `log-${i}.txt`);
      writeFileSync(file, 'x'.repeat(100));
      const at = new Date(Date.now() - (5 - i) * 60_000);
      utimesSync(file, at, at);
    }
    pruneArtifacts(dir, 3, 250);
    // Newest first: log-4 and log-3 fit in 250 bytes; log-2 would make 300.
    expect(readdirSync(dir).sort()).toEqual(['log-3.txt', 'log-4.txt']);
  });
});

describe('orchestrator chat hands cards to CLI sessions (PM-399)', () => {
  const live = (s: Partial<AgentSession>): Partial<AgentSession> => ({
    status: 'running',
    tailState: 'idle',
    cardId: null,
    cardKey: null,
    queuedInputBytes: 0,
    providerId: 'codex',
    ...s,
  });
  it("reports capacity so the owner's sessions cannot read as a full limit (PM-417)", async () => {
    const { call, sessions, a } = setup();
    sessions.push(
      live({ id: 40, projectId: a, name: 'owner idle' }),
      live({ id: 41, projectId: a, name: 'owner busy', tailState: 'running' }),
    );
    const { capacity } = (await call('overview')) as { capacity: Record<string, unknown> };
    expect(capacity).toMatchObject({
      yourWorkers: 0,
      maxWorkers: 2,
      freeWorkerSlots: 2,
      notCountedWorkers: 2,
    });
    expect(capacity).not.toHaveProperty('liveWorkers');
    expect(capacity.maxSessionsPerProject).toBe(8);
    expect(capacity.note).toMatch(/All saved project CLI sessions/);
  });
  const withSessionTools = (supervisor: Record<string, unknown>) => {
    const attachCard = vi.fn((id: number, cardId: number) => ({
      session: { id, cardId } as AgentSession,
      queued: false,
      sent: true,
    }));
    const createSession = vi.fn(
      async (projectId: number, input: { cardId?: number; providerId?: string }) =>
        ({ id: 90, projectId, cardId: input.cardId, providerId: input.providerId }) as AgentSession,
    );
    Object.assign(supervisor, { attachCard, createSession });
    return { attachCard, createSession };
  };

  it('is on by default; turned off, every hand-over tool is refused', async () => {
    const { call, mine, sessions, a, db } = setup({ delegateToSessions: false });
    sessions.push(live({ id: 21, projectId: a, name: 'idle' }));
    await expect(call('assign_card', { card: mine.key, sessionId: 21 })).rejects.toThrow(
      /turned off/,
    );
    await expect(call('start_session', { card: mine.key })).rejects.toThrow(/turned off/);
    await expect(call('dispatch_worker', { card: mine.key })).rejects.toThrow(/turned off/);
    db.close();
  });

  it('assigns a card only to an idle session in its project with no other card', async () => {
    const { call, mine, sessions, supervisor, a, b, record, db } = setup();
    const { attachCard } = withSessionTools(supervisor);
    sessions.push(
      live({ id: 31, projectId: b, name: 'elsewhere' }),
      live({ id: 32, projectId: a, name: 'busy', tailState: 'running' }),
      live({ id: 33, projectId: a, name: 'asking', tailState: 'input' }),
      live({ id: 34, projectId: a, name: 'taken', cardId: 999, cardKey: 'PM-999' }),
      live({ id: 35, projectId: a, name: 'queued', queuedInputBytes: 12 }),
      live({ id: 36, projectId: a, name: 'free' }),
      live({ id: 37, projectId: a, name: 'chat', orchestratorId: 'master-1' }),
    );
    const assign = (sessionId: number) => call('assign_card', { card: mine.key, sessionId });
    await expect(assign(31)).rejects.toThrow(/not a CLI session in your scope/);
    await expect(assign(32)).rejects.toThrow(/is working/);
    await expect(assign(33)).rejects.toThrow(/asking the user/);
    await expect(assign(34)).rejects.toThrow(/working on PM-999/);
    await expect(assign(35)).rejects.toThrow(/input waiting/);
    await expect(assign(37)).rejects.toThrow(/not a CLI session in your scope/);
    expect(attachCard).not.toHaveBeenCalled();
    const result = (await call('assign_card', {
      card: mine.key,
      sessionId: 36,
      instructions: 'Start with the form',
    })) as { delivery: string };
    expect(result.delivery).toMatch(/not confirmed/);
    expect(attachCard).toHaveBeenCalledWith(
      36,
      mine.id,
      expect.objectContaining({
        send: true,
        prompt: expect.stringContaining('Start with the form'),
      }),
    );
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ action: 'assigned' }));
    db.close();
  });

  it('treats a session whose linked card is in Review or Done as free (PM-437)', async () => {
    const { call, mine, sessions, supervisor, a, db } = setup();
    const { attachCard } = withSessionTools(supervisor);
    const reviewed = insertCard(db, a, { title: 'Old', description: '', status: 'review' });
    const working = insertCard(db, a, { title: 'Busy', description: '', status: 'in_progress' });
    sessions.push(
      live({ id: 41, projectId: a, name: 'busy', cardId: working.id, cardKey: working.key }),
      live({ id: 42, projectId: a, name: 'finished', cardId: reviewed.id, cardKey: reviewed.key }),
    );
    await expect(call('assign_card', { card: mine.key, sessionId: 41 })).rejects.toThrow(
      new RegExp(`working on ${working.key}`),
    );
    const result = (await call('assign_card', { card: mine.key, sessionId: 42 })) as {
      unlinked: string;
    };
    expect(result.unlinked).toBe(`${reviewed.key} (Review) is no longer linked to session 42`);
    expect(attachCard).toHaveBeenCalledWith(42, mine.id, expect.anything());
    db.close();
  });

  it('starts a session on a card within its limits, and replays a request ID', async () => {
    const { call, mine, sessions, supervisor, a, db } = setup();
    const { createSession } = withSessionTools(supervisor);
    const first = (await call('start_session', { card: mine.key, requestId: 'r1' })) as {
      started: { id: number };
    };
    expect(first.started.id).toBe(90);
    expect(createSession).toHaveBeenCalledWith(
      a,
      expect.objectContaining({ providerId: 'codex', cardId: mine.id }),
    );
    // The session now counts as the card's live worker.
    sessions.push(live({ id: 90, projectId: a, name: 'started', cardId: mine.id }));
    const again = (await call('start_session', { card: mine.key, requestId: 'r1' })) as {
      replayed: boolean;
      session: { id: number };
    };
    expect(again).toMatchObject({ replayed: true, session: { id: 90 } });
    await expect(
      call('start_session', { card: mine.key, requestId: 'r1', instructions: 'other' }),
    ).rejects.toThrow(/different work/);
    await expect(call('start_session', { card: mine.key })).rejects.toThrow(
      /already has a live worker/,
    );
    expect(createSession).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('starts another project CLI despite a per-project run allocation of one', async () => {
    const t = setup({ maxWorkers: 4, maxWorkersPerProject: 1, maxWorkersPerProvider: 4 });
    const { createSession } = withSessionTools(t.supervisor);
    t.sessions.push(live({ id: 41, projectId: t.a, name: 'existing worker', cardId: 999 }));
    const { recordOwnedSession } = await import('./ownedWorkers.js');
    recordOwnedSession(t.db, 'master-1', 41, 999);
    await t.call('start_session', { card: t.mine.key });
    expect(createSession).toHaveBeenCalledOnce();
    t.db.close();
  });

  it('messages and assigns an existing CLI at full project capacity without adding a slot', async () => {
    const t = setup({ maxWorkers: 4, maxWorkersPerProject: 1 });
    const { attachCard, createSession } = withSessionTools(t.supervisor);
    for (let i = 0; i < 8; i++) t.sessions.push(live({ id: 40 + i, projectId: t.a }));
    await t.call('message_worker', { sessionId: 40, text: 'Check progress' });
    expect(t.supervisor.sendInput).toHaveBeenCalledOnce();
    await t.call('assign_card', { card: t.mine.key, sessionId: 40 });
    expect(attachCard).toHaveBeenCalledOnce();
    expect(createSession).not.toHaveBeenCalled();
    t.db.close();
  });

  it('counts stopped and owner CLI sessions at the real project limit, excluding chats', async () => {
    const t = setup({ maxWorkers: 4, maxWorkersPerProject: 1 });
    const { createSession } = withSessionTools(t.supervisor);
    for (let i = 0; i < 8; i++)
      t.sessions.push(live({ id: 40 + i, projectId: t.a, status: 'exited' }));
    await expect(t.call('start_session', { card: t.mine.key })).rejects.toThrow(
      /CLI session limit/,
    );
    expect(createSession).not.toHaveBeenCalled();
    t.sessions[0]!.orchestratorId = 'another-chat';
    await t.call('start_session', { card: t.mine.key });
    expect(createSession).toHaveBeenCalledOnce();
    t.db.close();
  });

  it('lists only the CLI sessions in its projects', async () => {
    const { call, sessions, a, b, db } = setup();
    sessions.push(
      live({ id: 41, projectId: a, name: 'mine' }),
      live({ id: 42, projectId: b, name: 'theirs' }),
      live({ id: 43, projectId: a, name: 'chat', orchestratorId: 'master-1' }),
    );
    const result = (await call('list_sessions')) as { sessions: { id: number }[] };
    expect(result.sessions.map((s) => s.id)).toEqual([41]);
    await expect(call('list_sessions', { projectId: b })).rejects.toThrow(/not in your scope/);
    db.close();
  });

  it('prompts follow the setting: hand over when on, direct work when off', () => {
    const base = {
      name: 'X',
      providers: ['codex'],
      projectIds: [],
    } as unknown as OrchestratorConfig;
    expect(checkPrompt(base, 'todo')).toContain('assign_card');
    expect(briefing(base, [])).toContain('Handing work to CLI sessions is on');
    const off = { ...base, delegateToSessions: false };
    expect(checkPrompt(off, 'todo')).toContain('do not dispatch workers or delegate');
    expect(briefing(off, [])).toContain('Do not dispatch workers or delegate');
  });

  it('accepts or rejects finished runs with the card, with evidence, only when on (PM-427)', async () => {
    const run = { id: 3, status: 'succeeded', validation: null };
    const withRuns = (t: ReturnType<typeof setup>) => {
      const validateRun = vi.fn();
      Object.assign(t.supervisor, { listRuns: () => [run], validateRun });
      return validateRun;
    };
    const off = setup();
    const offValidate = withRuns(off);
    await off.call('update_card', { card: off.mine.key, status: 'done', note: 'Looks done' });
    expect(offValidate).not.toHaveBeenCalled();

    const on = setup({ acceptReviews: true });
    const validate = withRuns(on);
    await expect(on.call('update_card', { card: on.mine.key, status: 'done' })).rejects.toThrow(
      /evidence/,
    );
    await on.call('update_card', { card: on.mine.key, status: 'review', note: 'Built' });
    await expect(on.call('update_card', { card: on.mine.key, status: 'todo' })).rejects.toThrow(
      /missing/,
    );
    await on.call('update_card', { card: on.mine.key, status: 'todo', note: 'No test' });
    expect(validate).toHaveBeenLastCalledWith(3, 'rejected', undefined);
    await on.call('update_card', {
      card: on.mine.key,
      status: 'done',
      note: 'Tests pass, 4caa321',
    });
    expect(validate).toHaveBeenLastCalledWith(3, 'accepted', 'done');
    expect(getCard(on.db, on.mine.id)?.status).toBe('done');
    expect(checkPrompt(on.instance, 'review')).toContain('verify it against its requirements');
    expect(checkPrompt(off.instance, 'review')).toContain('ready for me to accept');
  });

  it('runs git only with Git on its own, in scope, and says so in its rules (PM-428)', async () => {
    const off = setup();
    await expect(
      off.call('git', { projectId: off.a, program: 'git', args: ['status'] }),
    ).rejects.toThrow(/Git on its own is off/);
    expect(briefing(off.instance, [])).toContain('Never push, merge');
    expect(checkPrompt(off.instance, 'attention')).toContain('Do not push, merge');

    const on = setup({ gitAutonomy: true });
    await expect(
      on.call('git', { projectId: on.b, program: 'git', args: ['status'] }),
    ).rejects.toThrow(/not in this/);
    await expect(
      on.call('git', { projectId: on.a, program: 'git', args: ['push', '--force'] }),
    ).rejects.toThrow(/Force/);
    expect(briefing(on.instance, [])).toContain('Git on its own is on');
    expect(briefing(on.instance, [])).not.toContain('Never push, merge');
    expect(checkPrompt(on.instance, 'attention')).toContain('push verified unpushed work');
    expect(checkPrompt(on.instance, 'all')).not.toContain('Do not push, merge');
    const watch = setup({ gitAutonomy: true, strategy: 'observe' });
    await expect(
      watch.call('git', { projectId: watch.a, program: 'git', args: ['status'] }),
    ).rejects.toThrow(/off/);
  });

  it('plans idle projects only with planFromGoals, never watch-only (PM-426)', () => {
    const base = {
      name: 'X',
      providers: ['codex'],
      projectIds: [],
    } as unknown as OrchestratorConfig;
    expect(checkPrompt(base, 'all')).not.toContain('Plan next work');
    expect(briefing(base, [])).not.toContain('- Plan:');
    const on = { ...base, planFromGoals: true };
    expect(checkPrompt(on, 'all')).toContain('Plan next work');
    expect(checkPrompt(on, 'plan')).toMatch(/Backlog, not To do/);
    expect(briefing(on, [])).toContain('- Plan:');
    const watch = { ...on, strategy: 'observe' as const };
    expect(checkPrompt(watch, 'all')).not.toContain('Plan next work');
  });
});

describe('board tools endpoint (PM-89)', () => {
  it("gives an orchestrator's chat its tools, and every other session the card tools", async () => {
    const { Hono } = await import('hono');
    const { registerBoardMcp, issueBoardGrant, BOARD_TOOLS } = await import('../boardMcp.js');
    const { db, a } = setup();
    const insert = db.prepare(
      `INSERT INTO agent_sessions (project_id, name, command_json, cwd, created_at, started_at, log_path, orchestrator_id)
       VALUES (?, 'x', '{"command":[]}', '.', '', '', ?, ?)`,
    );
    const chatId = Number(insert.run(a, 'chat.log', 'master-1').lastInsertRowid);
    const workerId = Number(insert.run(a, 'worker.log', null).lastInsertRowid);
    const host = { tools: [{ name: 'overview' }], call: vi.fn(async () => ({ ok: 1 })) };
    const app = new Hono();
    registerBoardMcp(app, db, tmp, host);
    const rpc = (owner: number, log: string, method: string, params?: unknown) =>
      app.request('/board-mcp', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${issueBoardGrant(db, { kind: 'session', id: owner, logPath: log })}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
    const tools = async (owner: number, log: string) =>
      ((await (await rpc(owner, log, 'tools/list')).json()) as { result: { tools: unknown[] } })
        .result.tools;
    expect(await tools(chatId, 'chat.log')).toEqual(host.tools);
    expect(await tools(workerId, 'worker.log')).toEqual(BOARD_TOOLS);
    await rpc(chatId, 'chat.log', 'tools/call', { name: 'overview', arguments: {} });
    expect(host.call).toHaveBeenCalledWith('master-1', chatId, 'overview', {});
  });
});

it('replays simultaneous chat requests and rejects conflicting request ID reuse', async () => {
  const { call, mine, supervisor, db } = setup();
  try {
    const args = { card: mine.key, requestId: 'same-request', instructions: 'Check tests' };
    const results = await Promise.all([
      call('dispatch_worker', args),
      call('dispatch_worker', args),
    ]);
    expect(supervisor.dispatchCard).toHaveBeenCalledTimes(1);
    expect(results).toContainEqual(
      expect.objectContaining({
        replayed: true,
        request: expect.objectContaining({ status: 'pending' }),
      }),
    );
    await expect(
      call('dispatch_worker', { ...args, instructions: 'Different work' }),
    ).rejects.toThrow(/different dispatch arguments/);
    expect(supervisor.dispatchCard).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});

it('recovers the completed run after a lost response without dispatching a done card', async () => {
  const { call, mine, supervisor, db, a } = setup();
  try {
    const args = { card: mine.key, requestId: 'completed-request' };
    await call('dispatch_worker', args);
    const key = db
      .prepare('SELECT dispatch_key FROM orchestrator_dispatch_requests WHERE request_id = ?')
      .get(args.requestId)!.dispatch_key as string;
    db.prepare(
      "INSERT INTO agent_runs(id,project_id,card_id,name,command_json,status,created_at,log_path,dispatch_key) VALUES(77,?,?,'Worker','[]','succeeded','2026-10-12','',?)",
    ).run(a, mine.id, key);
    db.prepare("UPDATE cards SET status='done' WHERE id=?").run(mine.id);
    expect(await call('dispatch_worker', args)).toMatchObject({
      replayed: true,
      request: { runId: 77, status: 'succeeded' },
      card: { status: 'done' },
    });
    expect(supervisor.dispatchCard).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});

it('rechecks provider policy after waiting for a restarted chat', async () => {
  const { chat, db, instance, sessions, supervisor } = setup();
  try {
    const stopped = { id: 10, providerId: 'codex', status: 'killed' } as AgentSession;
    const live = { ...stopped, status: 'running' } as AgentSession;
    sessions.push(live);
    vi.spyOn(chat, 'session').mockReturnValue(stopped);
    vi.spyOn(chat, 'open').mockResolvedValue(live);
    vi.spyOn(
      chat as unknown as { waitUntilReady: (id: number) => Promise<void> },
      'waitUntilReady',
    ).mockImplementation(async () => {
      instance.providers = ['claude'];
    });
    await expect(chat.check(instance.id, 'review')).rejects.toThrow(/agent was removed/);
    expect(supervisor.sendInput).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('does not send checks to a chat provider removed from configuration', async () => {
  const { chat, db, supervisor, instance } = setup();
  try {
    vi.spyOn(chat, 'session').mockReturnValue({
      id: 10,
      providerId: 'claude',
      status: 'running',
    } as AgentSession);
    const replacement = { id: 11, providerId: 'codex', status: 'running' } as AgentSession;
    const open = vi.spyOn(chat, 'open').mockResolvedValue(replacement);
    expect(await chat.check(instance.id, 'review')).toBe(replacement);
    expect(open).toHaveBeenCalledWith(instance.id, undefined, expect.stringContaining('Review'));
    expect(supervisor.sendInput).not.toHaveBeenCalled();
  } finally {
    db.close();
  }
});

it('does not hide a running chat by switching to another provider', async () => {
  const { chat, db, instance } = setup({ providers: ['codex', 'claude'] });
  try {
    vi.spyOn(chat, 'session').mockReturnValue({
      id: 10,
      providerId: 'codex',
      status: 'running',
    } as AgentSession);
    await expect(chat.open(instance.id, 'claude')).rejects.toThrow(/Stop the current/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get()!.n).toBe(0);
  } finally {
    db.close();
  }
});

it('rejects overlapping chat opens and releases the startup guard after failure', async () => {
  const { chat, db, instance } = setup();
  try {
    vi.spyOn(chat, 'session').mockReturnValue(null);
    let release!: () => void;
    vi.mocked(providerStatuses).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      instance.providers = ['grok'];
      return [];
    });
    const first = chat.open(instance.id);
    const failed = expect(first).rejects.toThrow(/chat needs/);
    await expect(chat.open(instance.id)).rejects.toThrow(/chat is opening/);
    release();
    await failed;
    await expect(chat.open(instance.id)).rejects.toThrow(/chat needs/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get()!.n).toBe(0);
  } finally {
    db.close();
  }
});

it('rechecks configured chat providers after asynchronous discovery', async () => {
  const { chat, db, instance } = setup();
  try {
    vi.spyOn(chat, 'session').mockReturnValue(null);
    vi.mocked(providerStatuses).mockImplementationOnce(async () => {
      instance.providers = ['claude'];
      return [{ id: 'codex', available: true }] as Awaited<ReturnType<typeof providerStatuses>>;
    });
    await expect(chat.open(instance.id, 'codex')).rejects.toThrow(/configured provider/);
    expect(db.prepare('SELECT COUNT(*) AS n FROM agent_sessions').get()!.n).toBe(0);
  } finally {
    db.close();
  }
});

it('rejects chat providers outside configured scope and does not fall back to unconfigured agents', async () => {
  const { chat, db, instance } = setup();
  try {
    await expect(chat.open(instance.id, 'claude')).rejects.toThrow(/configured provider/);
    instance.providers = ['grok'];
    await expect(chat.open(instance.id)).rejects.toThrow(/chat needs/);
  } finally {
    db.close();
  }
});

it('creates one chat on overlapping opens and reuses it after successful startup', async () => {
  const { chat, db, instance, supervisor } = setup();
  try {
    let current: AgentSession | null = null;
    vi.spyOn(chat, 'session').mockImplementation(() => current);
    const created = { id: 10, providerId: 'codex', status: 'running' } as AgentSession;
    const createSession = vi.fn(async () => {
      current = created;
      return created;
    });
    Object.assign(supervisor, { createSession });
    let release!: () => void;
    vi.mocked(providerStatuses).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return [{ id: 'codex', available: true }] as Awaited<ReturnType<typeof providerStatuses>>;
    });
    const first = chat.open(instance.id, 'codex');
    await expect(chat.open(instance.id, 'codex')).rejects.toThrow(/chat is opening/);
    release();
    expect(await first).toBe(created);
    expect(await chat.open(instance.id, 'codex')).toBe(created);
    expect(createSession).toHaveBeenCalledTimes(1);
  } finally {
    db.close();
  }
});

it('keeps every chat check in direct execution mode when hand-over is off, and includes dashboard alert context (PM-179, PM-172, PM-399)', () => {
  const instance = {
    name: 'All',
    strategy: 'autonomous',
    delegateToSessions: false,
  } as OrchestratorConfig;
  for (const focus of ['all', 'todo', 'in_progress', 'review', 'attention'] as const) {
    const prompt = checkPrompt(instance, focus);
    expect(prompt).toContain('do not dispatch workers or delegate');
    expect(prompt).not.toContain('Start workers');
    expect(checkPrompt({ ...instance, delegateToSessions: true }, focus)).not.toContain(
      'do not dispatch workers',
    );
  }
  expect(checkPrompt(instance, 'attention')).toContain('uncommitted and unpushed');
  expect(checkPrompt(instance, 'attention')).toContain('Do not push, merge, discard files');
  const scoped = checkPrompt(instance, 'attention', ['Unpushed']);
  expect(scoped).toContain('Handle only these alert kinds: Unpushed');
  expect(checkPrompt(instance, 'attention')).not.toContain('Handle only');
  expect(checkPrompt({ ...instance, strategy: 'observe' }, 'todo')).toContain(
    'do not edit files or move cards unless',
  );
});

it('tracks scoped direct chat work and hides replaced, stopped or reviewed tasks (PM-174)', async () => {
  const { chat, call, sessions, mine, other, db } = setup();
  const session = { id: 5, orchestratorId: 'master-1', status: 'running' } as AgentSession;
  sessions.push(session);
  vi.spyOn(chat, 'session').mockReturnValue(session);
  await call('report_work', { card: mine.key });
  expect(chat.currentWork('master-1')?.cardId).toBe(mine.id);
  await expect(call('report_work', { card: other.key })).rejects.toThrow(
    /not in this orchestrator/,
  );
  await call('report_work', { clear: true });
  expect(chat.currentWork('master-1')).toBeNull();
  await call('report_work', { projectId: mine.projectId, title: 'Inspect uncommitted changes' });
  expect(chat.currentWork('master-1')?.title).toBe('Inspect uncommitted changes');
  session.status = 'killed';
  expect(chat.currentWork('master-1')).toBeNull();
  db.close();
});

it('sends one in-scope card to a running, idle chat and refuses every other case (PM-202)', () => {
  const { chat, sessions, supervisor, mine, other, db } = setup();
  const session = {
    id: 5,
    orchestratorId: 'master-1',
    providerId: 'codex',
    status: 'running',
    tailState: 'idle',
  } as AgentSession;
  sessions.push(session);
  vi.spyOn(chat, 'session').mockReturnValue(session);
  expect(chat.chatState('master-1')).toEqual({ running: true, state: 'idle' });

  expect(() => chat.sendCard('master-1', other.id)).toThrow(/not found in this orchestrator/);
  expect(supervisor.sendInput).not.toHaveBeenCalled();

  session.tailState = 'input';
  expect(() => chat.sendCard('master-1', mine.id)).toThrow(/asking you something/);
  session.tailState = 'running';
  expect(() => chat.sendCard('master-1', mine.id)).toThrow(/busy/);
  expect(supervisor.sendInput).not.toHaveBeenCalled();

  session.tailState = 'idle';
  chat.sendCard('master-1', mine.id);
  const [id, text, echo] = supervisor.sendInput.mock.calls[0] as [number, string, boolean];
  expect([id, echo]).toEqual([5, false]);
  expect(text).toContain(mine.key);
  expect(text).toContain('Add login');
  // Handing work to sessions is on by default (PM-399).
  expect(text).toContain('assign_card');

  session.status = 'killed';
  expect(chat.chatState('master-1')).toEqual({ running: false, state: null });
  expect(() => chat.sendCard('master-1', mine.id)).toThrow(/stopped/);
  expect(supervisor.sendInput).toHaveBeenCalledTimes(1);
  expect(getCard(db, mine.id)?.status).toBe('todo');
  db.close();
});

it('routes scoped supervision tools and allows release when delegation is disabled', async () => {
  const t = setup({ superviseSessions: true });
  await t.call('check_session', { sessionId: 7 });
  expect(t.sessionSupervision.check).toHaveBeenCalledWith('master-1', 7);
  await t.call('supervise_session', { sessionId: 7, enabled: true });
  expect(t.sessionSupervision.enroll).toHaveBeenCalledWith('master-1', 7, true);
  await t.call('continue_session', { sessionId: 7 });
  expect(t.sessionSupervision.continue).toHaveBeenCalledWith('master-1', 7);
  await t.call('wake_session', { sessionId: 7 });
  expect(t.sessionSupervision.wake).toHaveBeenCalledWith('master-1', 7);
  t.instance.delegateToSessions = false;
  await t.call('supervise_session', { sessionId: 7, enabled: false });
  expect(t.sessionSupervision.enroll).toHaveBeenCalledWith('master-1', 7, false);
  await expect(t.call('continue_session', { sessionId: 7 })).rejects.toThrow(/turned off/);
  await expect(t.call('check_session', { sessionId: -1 })).rejects.toThrow();
  t.db.close();
});

describe('cross-project priority (PM-430)', () => {
  it('marks priority projects in overview and lists their To do cards first', async () => {
    const { call, other, db } = setup({ projectIds: [1, 2], priorityProjectIds: [2] });
    const view = (await call('overview', {})) as {
      projects: { id: number; priority?: boolean }[];
      todo: { cards: { key: string }[] };
    };
    expect(view.projects.find((p) => p.id === 2)?.priority).toBe(true);
    expect(view.projects.find((p) => p.id === 1)?.priority).toBeUndefined();
    expect(view.todo.cards[0]?.key).toBe(other.key);
    db.close();
  });

  it('tells the chat to serve priority projects first only when some are set', () => {
    const base = {
      name: 'X',
      providers: ['codex'],
      projectIds: [],
    } as unknown as OrchestratorConfig;
    const project = {
      id: 3,
      name: 'Sparkline',
      path: 'S:/Sparkline',
      cardCounts: { backlog: 0, todo: 1, in_progress: 0, review: 0, done: 0 },
    } as unknown as ProjectSummary;
    expect(briefing(base, [project])).not.toContain('Priority projects');
    const text = briefing({ ...base, priorityProjectIds: [3] }, [project]);
    expect(text).toContain('Priority projects');
    expect(text).toContain('**Sparkline** (project 3) (priority)');
  });
});

describe('worker messages and goals (PM-432, PM-433)', () => {
  const worker = (over: Partial<AgentSession> = {}) =>
    ({
      id: 7,
      projectId: 1,
      cardId: 1,
      cardKey: 'PM-1',
      name: 'Login worker',
      status: 'running',
      tailState: 'running',
      queuedInputBytes: 0,
      orchestratorId: null,
      ...over,
    }) as AgentSession;

  it('takes a message from a session it owns, refuses others, and queues the reply', async () => {
    const { chat, call, sessions, db, mine } = setup();
    sessions.push(worker({ cardId: mine.id }));
    expect(() => chat.fromWorker(7, { kind: 'question', text: 'Which DB?' })).toThrow(
      /No orchestrator looks after this session/,
    );
    const { recordOwnedSession } = await import('./ownedWorkers.js');
    recordOwnedSession(db, 'master-1', 7, mine.id);
    const sent = chat.fromWorker(7, { kind: 'question', text: 'Which DB?' }) as {
      messageId: number;
    };
    const view = (await call('overview')) as {
      workerMessages: { new: { id: number; text: string }[]; openQuestions: unknown[] };
    };
    expect(view.workerMessages.new.map((m) => m.text)).toEqual(['Which DB?']);
    expect(view.workerMessages.openQuestions).toHaveLength(1);
    // Read through overview: not new any more.
    expect(((await call('overview')) as typeof view).workerMessages.new).toEqual([]);
    const reply = (await call('reply_worker', { messageId: sent.messageId, text: 'SQLite' })) as {
      queued: boolean;
    };
    expect(reply.queued).toBe(true);
    expect(((await call('overview')) as typeof view).workerMessages.openQuestions).toEqual([]);
    await expect(call('reply_worker', { messageId: 999, text: 'x' })).rejects.toThrow(/No message/);
    for (let i = 1; i < 6; i++) chat.fromWorker(7, { kind: 'status', text: `step ${i}` });
    expect(() => chat.fromWorker(7, { kind: 'status', text: 'too many' })).toThrow(/this hour/);
    db.close();
  });

  it('queues a message for a busy session instead of refusing it, when asked', async () => {
    const { call, sessions, supervisor, db } = setup();
    sessions.push(worker());
    await expect(call('message_worker', { sessionId: 7, text: 'Status?' })).rejects.toThrow(
      /working/,
    );
    const queued = (await call('message_worker', {
      sessionId: 7,
      text: 'Status?',
      queue: true,
    })) as {
      queued: boolean;
    };
    expect(queued.queued).toBe(true);
    expect(supervisor.sendInput).not.toHaveBeenCalled();
    db.close();
  });

  it('records goals, lists them in overview and adds the goal step to checks', async () => {
    const { call, db } = setup({ autoCheck: true, delegateToSessions: true });
    const set = (await call('set_goal', {
      title: 'Ship login',
      objective: 'Users can sign in',
      doneWhen: 'Login e2e test passes on main',
    })) as { goal: { id: number; status: string }; note: string };
    expect(set.goal.status).toBe('active');
    expect(set.note).toContain('automatic checks');
    await call('update_goal', { goalId: set.goal.id, note: 'PR #3 open' });
    const view = (await call('overview')) as {
      goals: { id: number; recentProgress: { note: string }[] }[];
    };
    expect(view.goals[0]!.recentProgress.at(-1)!.note).toBe('PR #3 open');
    const instance = {
      name: 'X',
      providers: ['codex'],
      projectIds: [],
      delegateToSessions: true,
    } as unknown as OrchestratorConfig;
    expect(checkPrompt(instance, 'all')).not.toContain('Goals:');
    expect(checkPrompt(instance, 'all', [], true)).toContain('Goals:');
    expect(checkPrompt(instance, 'goal')).toContain('dispatch_worker for a self-contained task');
    const off = setup({ autoCheck: false });
    const note = (
      (await off.call('set_goal', {
        title: 't',
        objective: 'o',
        doneWhen: 'd',
      })) as { note: string }
    ).note;
    expect(note).toContain('"Check on its own" is off');
    off.db.close();
    db.close();
  });
});

describe('goals in routine checks (PM-461)', () => {
  it("carry every active goal's card status, and the goal step staffs cards in parallel", async () => {
    const { call, chat, mine, db } = setup({ autoCheck: true, delegateToSessions: true });
    await call('set_goal', {
      title: 'Ship',
      objective: 'o',
      doneWhen: 'login works',
      cards: [mine.key],
    });
    const block = goalStatusBlock(chat.goals('master-1'));
    expect(block).toContain('Goal 1 "Ship" (0 of 1 cards done)');
    expect(block).toContain(`- ${mine.key} "Add login": todo, no worker`);
    const step = checkPrompt(
      {
        name: 'X',
        providers: ['codex'],
        projectIds: [],
        delegateToSessions: true,
      } as unknown as OrchestratorConfig,
      'goal',
    );
    expect(step).toContain('Staff in parallel');
    expect(step).toContain('never put two workers on one card');
    db.close();
  });
});

describe('goal acceptance checklist (PM-471)', () => {
  it('closes a goal only when every criterion passes, and passing needs evidence', async () => {
    const { call, chat, db } = setup({ autoCheck: true });
    await call('set_goal', {
      title: 'Ship',
      objective: 'o',
      doneWhen: 'login works',
      criteria: ['e2e login test passes', 'PR merged with checks green'],
    });
    expect(chat.goals('master-1')[0]!.criteria!.map((c) => c.state)).toEqual(['open', 'open']);
    await expect(
      call('update_goal', { goalId: 1, note: 'n', criteria: [{ id: 1, state: 'passing' }] }),
    ).rejects.toThrow(/needs evidence/);
    await call('update_goal', {
      goalId: 1,
      note: 'tests green',
      criteria: [{ id: 1, state: 'passing', evidence: 'npm run e2e: 12 passed' }],
    });
    await expect(
      call('update_goal', { goalId: 1, note: 'done?', status: 'achieved' }),
    ).rejects.toThrow(/#2 "PR merged with checks green" .open./);
    const closed = (await call('update_goal', {
      goalId: 1,
      note: 'merged',
      status: 'achieved',
      criteria: [{ id: 2, state: 'passing', evidence: 'PR #9 merged, checks green' }],
      // Verification runs are covered in their own tests (PM-472).
      closeUnverified: 'covered by the verification tests',
    })) as { goal: { status: string; criteria: { state: string }[] } };
    expect(closed.goal.status).toBe('achieved');
    expect(closed.goal.criteria.every((c) => c.state === 'passing')).toBe(true);
    expect(chat.goals('master-1')[0]!.criteria![1]!.checkedBy).toBe('chat');
    db.close();
  });
});

describe('criteria that wait for the owner (PM-524)', () => {
  it('pauses checks, tells the owner once, and lets the owner confirm', async () => {
    const { call, chat, db } = setup({ autoCheck: true });
    await call('set_goal', {
      title: 'Polish',
      objective: 'o',
      doneWhen: 'd',
      criteria: ['captures merged', 'owner accepts the result screen'],
    });
    await expect(
      call('update_goal', { goalId: 1, note: 'n', criteria: [{ id: 2, state: 'owner' }] }),
    ).rejects.toThrow(/what the owner has to do/);
    await call('update_goal', {
      goalId: 1,
      note: 'captures in; screen needs the owner',
      criteria: [
        { id: 1, state: 'passing', evidence: 'PR #9 merged' },
        {
          id: 2,
          state: 'owner',
          evidence: 'Open /play/neon on a phone and accept the result screen',
        },
      ],
    });
    const { goalsDue, listGoals } = await import('./goals.js');
    expect(goalsDue(listGoals(db, 'master-1'), Date.now() + 10 * 3_600_000)).toEqual([]);
    const goal = chat.goals('master-1')[0]!;
    expect(goal.followUp.note).toContain('Waiting for you: 1 criterion needs you');
    expect(chat.goalEvents()).toMatchObject([
      { status: 'waiting', note: 'Open /play/neon on a phone and accept the result screen' },
    ]);
    chat.updateOwnerGoal('master-1', 1, { confirmCriteria: [2] });
    const confirmed = chat.goals('master-1')[0]!.criteria![1]!;
    expect(confirmed).toMatchObject({ state: 'passing', checkedBy: 'owner' });
    expect(confirmed.evidence).toContain('Confirmed by the owner');
    expect(chat.goalEvents()).toEqual([]);
    db.close();
  });
});

describe('goal outcome measures (PM-475)', () => {
  it('counts checks, owner notes and reopenings, and freezes the time when the goal closes', async () => {
    const { call, chat, db } = setup({ autoCheck: true });
    await call('set_goal', { title: 'Ship', objective: 'o', doneWhen: 'd' });
    const { noteGoalCheck } = await import('./goals.js');
    noteGoalCheck(db, 'master-1', Date.now());
    noteGoalCheck(db, 'master-1', Date.now() + 1);
    chat.updateOwnerGoal('master-1', 1, { note: 'Focus on the phone layout' });
    chat.updateOwnerGoal('master-1', 1, { status: 'achieved' });
    chat.updateOwnerGoal('master-1', 1, { status: 'active' });
    const outcome = chat.goals('master-1')[0]!.outcome;
    expect(outcome).toMatchObject({
      checks: 2,
      runs: 0,
      ownerNotes: 3, // the note, "Marked achieved" and "Resumed"
      reopenings: 1,
      verifications: { passed: 0, failed: 0 },
    });
    expect(outcome.days).toBeGreaterThanOrEqual(0);
    db.close();
  });
});

describe('acceptance checks on cards (PM-474)', () => {
  it('keeps one Acceptance line first in the notes, replacing an older one', () => {
    const notes = withAcceptance('Some notes.', 'tests pass');
    expect(notes).toBe('Acceptance: tests pass\n\nSome notes.');
    expect(acceptanceOf(notes)).toBe('tests pass');
    const replaced = withAcceptance(notes, 'tests pass on a phone');
    expect(replaced).toBe('Acceptance: tests pass on a phone\n\nSome notes.');
    expect(acceptanceOf('No check here')).toBeNull();
  });

  it('sets a check with update_card and leads the hand-over with it', async () => {
    const { call, mine, supervisor, db } = setup({ autoCheck: true });
    await call('update_card', { card: mine.key, acceptance: 'the login form renders' });
    expect(acceptanceOf(getCard(db, mine.id)!.description)).toBe('the login form renders');
    await call('dispatch_worker', { card: mine.key });
    const options = supervisor.dispatchCard.mock.calls.at(-1)![2] as { context?: string };
    expect(options.context).toContain('This card is done when: the login form renders');
    db.close();
  });
});

describe('independent verification before a goal closes (PM-472)', () => {
  const passAll = async (call: (name: string, args: unknown) => Promise<unknown>) => {
    await call('set_goal', {
      title: 'Ship',
      objective: 'o',
      doneWhen: 'login works',
      criteria: ['e2e passes', 'PR merged'],
    });
    await call('update_goal', {
      goalId: 1,
      note: 'all green',
      criteria: [
        { id: 1, state: 'passing', evidence: 'npm run e2e: 12 passed' },
        { id: 2, state: 'passing', evidence: 'PR #9 merged' },
      ],
    });
  };

  it('starts a verifier run instead of closing, and closes when it confirms every criterion', async () => {
    const { call, chat, supervisor, db } = setup({ autoCheck: true });
    await passAll(call);
    const result = (await call('update_goal', { goalId: 1, note: 'done', status: 'achieved' })) as {
      goal: { status: string };
      verification: string;
    };
    expect(result.goal.status).toBe('active');
    expect(result.verification).toContain('Run #77');
    const prompt = (supervisor.dispatchCard.mock.calls[0]![2] as { prompt: string }).prompt;
    expect(prompt).toContain('Do not modify, commit, push or merge anything');
    expect(chat.goals('master-1')[0]!.verification).toMatchObject({ runId: 77 });
    // A second close attempt waits for the running check.
    await expect(
      call('update_goal', { goalId: 1, note: 'again', status: 'achieved' }),
    ).rejects.toThrow(/still checking/);

    const output =
      'Checked both.\nVERDICT: {"criteria":[{"id":1,"pass":true,"evidence":"12 passed"},{"id":2,"pass":true,"evidence":"#9 merged"}]}\n';
    Object.assign(supervisor, {
      getRun: () => ({ id: 77, status: 'succeeded', validation: null }),
      readRunOutput: () => ({ data: output, nextOffset: output.length, logBytes: output.length }),
      validateRun: vi.fn(),
    });
    chat.collectVerifications();
    const goal = chat.goals('master-1')[0]!;
    expect(goal.status).toBe('achieved');
    expect(goal.verification?.result).toBe('passed');
    expect(goal.criteria!.every((c) => c.checkedBy === 'verifier')).toBe(true);
    db.close();
  });

  it('keeps the goal going when the verifier finds a criterion not met', async () => {
    const { call, chat, supervisor, db } = setup({ autoCheck: true });
    await passAll(call);
    await call('update_goal', { goalId: 1, note: 'done', status: 'achieved' });
    const output =
      'VERDICT: {"criteria":[{"id":1,"pass":true,"evidence":"ok"},{"id":2,"pass":false,"evidence":"PR #9 still open"}]}';
    Object.assign(supervisor, {
      getRun: () => ({ id: 77, status: 'succeeded', validation: null }),
      readRunOutput: () => ({ data: output, nextOffset: output.length, logBytes: output.length }),
      validateRun: vi.fn(),
    });
    chat.collectVerifications();
    const goal = chat.goals('master-1')[0]!;
    expect(goal.status).toBe('active');
    expect(goal.criteria![1]).toMatchObject({ state: 'failing' });
    expect(goal.criteria![1]!.evidence).toContain('PR #9 still open');
    expect(goal.progress.at(-1)!.note).toContain('not met: #2');
    db.close();
  });

  it('reads the last VERDICT line, past terminal codes, and ignores malformed ones', () => {
    expect(parseVerdict('no verdict here')).toBeNull();
    expect(
      parseVerdict('VERDICT: {"criteria":[{"id":1,"pass":false,"evidence":"x"}]}\nVERDICT: oops'),
    ).toEqual([{ id: 1, pass: false, evidence: 'x' }]);
    expect(parseVerdict('[1mVERDICT: {"criteria":[{"id":2,"pass":true}]}[0m')).toEqual([
      { id: 2, pass: true, evidence: '' },
    ]);
  });
});

describe('following up on a goal (PM-456)', () => {
  it('builds a follow-up prompt from the goal, and notes owner status changes', async () => {
    const { call, chat, mine, db } = setup({ autoCheck: true });
    await call('set_goal', {
      title: 'Ship',
      objective: 'o',
      doneWhen: 'login works',
      cards: [mine.key],
    });
    const prompt = goalFollowUpPrompt(chat.goals('master-1')[0]!);
    expect(prompt).toContain('follow up on goal 1 "Ship"');
    expect(prompt).toContain(`- ${mine.key} "Add login": todo, no live worker`);
    expect(prompt).toContain('update_goal with the full picture');
    chat.updateOwnerGoal('master-1', 1, { status: 'paused' });
    chat.updateOwnerGoal('master-1', 1, { status: 'active' });
    expect(chat.goals('master-1')[0]!.progress.at(-1)!.note).toBe('Resumed by the owner.');
    await expect(chat.check('master-1', 'goal', [], 99)).rejects.toThrow(/No goal 99/);
    db.close();
  });
});

describe('closing goals with linked cards (PM-454)', () => {
  it('refuses achieved while linked cards are open, unless the chat says why or the owner confirms', async () => {
    const { call, chat, mine, a, db, supervisor } = setup({ autoCheck: true });
    Object.assign(supervisor, { validateRun: vi.fn() });
    const review = insertCard(db, a, { title: 'Review me', description: '', status: 'review' });
    await call('set_goal', {
      title: 'G',
      objective: 'o',
      doneWhen: 'd',
      cards: [mine.key, review.key],
      criteria: ['works'],
    });
    await call('update_goal', {
      goalId: 1,
      note: 'checked',
      criteria: [{ id: 1, state: 'passing', evidence: 'seen working' }],
    });
    await expect(
      call('update_goal', { goalId: 1, note: 'done', status: 'achieved' }),
    ).rejects.toThrow(/still open/);
    const view = chat.goals('master-1')[0]!;
    expect(view.followUp.note).toContain('chat is closed'); // no chat session in this setup
    expect(() => chat.updateOwnerGoal('master-1', 1, { status: 'achieved' })).toThrow(/still open/);
    chat.updateOwnerGoal('master-1', 1, { status: 'achieved', force: true, acceptReview: true });
    expect(getCard(db, review.id)!.status).toBe('done');
    expect(getCard(db, mine.id)!.status).toBe('todo'); // not in Review: left where it is
    expect(chat.goals('master-1')[0]!.status).toBe('achieved');
    await call('set_goal', {
      title: 'H',
      objective: 'o',
      doneWhen: 'd',
      cards: [mine.key],
      criteria: ['shipped'],
    });
    const closed = (await call('update_goal', {
      goalId: 2,
      note: 'shipped',
      status: 'achieved',
      criteria: [{ id: 1, state: 'passing', evidence: 'released' }],
      closeWithOpenCards: 'the card is a follow-up',
      closeUnverified: 'covered by the verification tests',
    })) as { goal: { status: string } };
    expect(closed.goal.status).toBe('achieved');
    db.close();
  });
});

describe('Activity details (PM-452)', () => {
  it('keeps the full text behind a cut-off entry, readable by its detailId', async () => {
    const { call, chat, record, db } = setup({ autoCheck: true });
    await call('set_goal', { title: 'G', objective: 'o', doneWhen: 'd' });
    const note = 'Merged #573. '.repeat(30).trim();
    await call('update_goal', { goalId: 1, note });
    const event = record.mock.calls
      .map((c) => c[0] as { action: string; detailId?: number; message: string })
      .find((e) => e.action === 'goal-progress')!;
    expect(event.message.length).toBeLessThan(note.length);
    expect(chat.eventDetail(event.detailId!)).toBe(note);
    expect(chat.eventDetail(999)).toBeNull();
    db.close();
  });

  it("finds an older entry's full text in the goal store", async () => {
    const { call, chat, db } = setup({ autoCheck: true });
    const doneWhen = 'All of it is merged. '.repeat(12).trim();
    await call('set_goal', { title: 'Ship', objective: 'Ship it all', doneWhen });
    const note = 'Merged #573 and #574. '.repeat(12).trim();
    await call('update_goal', { goalId: 1, note });
    const summary = (text: string) => `Goal 1 "Ship": ${text.slice(0, 120)}`;
    expect(chat.eventFullText('master-1', 'goal-set', summary(doneWhen))).toBe(
      `Ship it all

Done when: ${doneWhen}`,
    );
    expect(chat.eventFullText('master-1', 'goal-progress', summary(note))).toBe(note);
    expect(chat.eventFullText('master-1', 'git', 'TiemNet: gh pr merge 1')).toBeNull();
    db.close();
  });
});

describe('goals as epics (PM-448)', () => {
  it('tags projects, links cards (named in the text too) and reports how many are done', async () => {
    const { call, chat, mine, other, a, db } = setup({ autoCheck: true });
    const set = (await call('set_goal', {
      title: 'Login',
      objective: 'Ship login',
      doneWhen: `${mine.key} is merged`,
      projects: ['Alpha'],
    })) as { goal: { projects: string[]; cards: { key: string }[]; cardsDone: string } };
    expect(set.goal.projects).toEqual(['Alpha']);
    expect(set.goal.cards.map((c) => c.key)).toEqual([mine.key]); // named in doneWhen
    expect(set.goal.cardsDone).toBe('0 of 1');
    await expect(
      call('update_goal', { goalId: 1, note: 'x', linkCards: [other.key] }),
    ).rejects.toThrow(/not in this orchestrator/);
    // A goal card needs its acceptance check (PM-474).
    await expect(call('create_card', { projectId: a, title: 'API', goalId: 1 })).rejects.toThrow(
      /needs acceptance/,
    );
    const created = (await call('create_card', {
      projectId: a,
      title: 'API',
      goalId: 1,
      notes: 'Wire the login endpoint.',
      acceptance: 'POST /login returns 200 for a valid user',
    })) as { key: string };
    expect(getCard(db, Number(created.key.split('-')[1]))!.description).toBe(
      'Acceptance: POST /login returns 200 for a valid user\n\nWire the login endpoint.',
    );
    updateCard(db, mine.id, { status: 'done' });
    const view = chat.goals('master-1')[0]!;
    expect(view.cards.map((c) => [c.key, c.status])).toEqual([
      [mine.key, 'done'],
      [created.key, 'todo'],
    ]);
    expect(view.projects).toEqual([{ id: a, name: 'Alpha' }]);
    // The card side of the link (PM-467): which goals a card delivers.
    expect(chat.goalsForCard(mine.id)).toEqual([
      {
        orchestratorId: 'master-1',
        orchestratorName: 'Games',
        goalId: 1,
        title: 'Login',
        status: 'active',
      },
    ]);
    expect(chat.goalsForCard(other.id)).toEqual([]);
    const after = (await call('update_goal', {
      goalId: 1,
      note: 'split',
      unlinkCards: [created.key],
    })) as { goal: { cardsDone: string } };
    expect(after.goal.cardsDone).toBe('1 of 1');
    await expect(
      call('set_goal', { title: 'x', objective: 'o', doneWhen: 'd', projects: ['Beta'] }),
    ).rejects.toThrow(/not in this orchestrator/);
    db.close();
  });
});

describe('goal events for notifications (PM-436)', () => {
  it('lists goals achieved or blocked in the last day, newest first', async () => {
    const { chat, call, db } = setup({ autoCheck: true });
    for (const title of ['A', 'B', 'C'])
      await call('set_goal', { title, objective: 'o', doneWhen: 'd' });
    // The owner closes it: the chat would need a checklist and a verification run (PM-471/472).
    chat.updateOwnerGoal('master-1', 1, { status: 'achieved', note: 'Merged PR #2' });
    await call('update_goal', { goalId: 2, note: 'Needs a secret', status: 'blocked' });
    const events = chat.goalEvents();
    expect(events.map((e) => [e.title, e.status])).toEqual([
      ['B', 'blocked'],
      ['A', 'achieved'],
    ]);
    expect(events[0]).toMatchObject({ orchestratorName: 'Games', note: 'Needs a secret' });
    // A day on, the closed goals are old news; C is still active and nothing continues it.
    expect(chat.goalEvents(Date.now() + 25 * 3_600_000).map((e) => [e.title, e.status])).toEqual([
      ['C', 'stuck'],
    ]);
    db.close();
  });

  it('flags an active goal nothing continues, once it has sat for two nudge intervals (PM-437)', async () => {
    const paused = setup({ autoCheck: true, enabled: false });
    const set = (await paused.call('set_goal', { title: 'G', objective: 'o', doneWhen: 'd' })) as {
      note: string;
    };
    expect(set.note).toContain('paused');
    expect(paused.chat.goalEvents()).toEqual([]); // just set
    const later = Date.now() + 31 * 60_000;
    expect(paused.chat.goalEvents(later)).toMatchObject([
      { title: 'G', status: 'stuck', note: expect.stringContaining('paused') },
    ]);
    paused.db.close();

    const running = setup({ autoCheck: true });
    await running.call('set_goal', { title: 'G', objective: 'o', doneWhen: 'd' });
    expect(running.chat.goalEvents(later)[0]!.note).toContain('chat is closed');
    vi.spyOn(running.chat, 'session').mockReturnValue({ status: 'running' } as AgentSession);
    expect(running.chat.goalEvents(later)).toEqual([]);
    running.db.close();
  });
});
