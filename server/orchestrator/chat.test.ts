import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { openDb } from '../db.js';
import { getCard, insertCard, insertProject } from '../store.js';
import type { AgentSupervisor } from '../agents/supervisor.js';
import type { AgentRun, AgentSession, ProjectSummary } from '../../shared/types.js';
import type { OrchestratorConfig } from '../../shared/orchestrator.js';
import type { OrchestratorService } from './service.js';
import { OrchestratorChat, briefing } from './chat.js';
import { readLimits } from '../agents/limits.js';

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

function setup(overrides: Partial<OrchestratorConfig> = {}) {
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
  const service = {
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
  );
  const call = (name: string, args: Record<string, unknown> = {}) =>
    chat.call('master-1', 5, name, args);
  return { db, a, b, mine, other, chat, call, sessions, runs, supervisor, record, instance };
}

describe('orchestrator chat tools (PM-89)', () => {
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
      maxAttempts: 1,
      canCommit: expect.any(Function),
      context: 'Instructions from the orchestrator:\nCheck the tests first',
    });
    // The project now has a live worker: its per-project limit (1) refuses another.
    runs.push({ id: 77, projectId: a, cardId: 999, status: 'running' });
    await expect(call('dispatch_worker', { card: mine.key })).rejects.toThrow(/already has 1 of 1/);
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
      const options = input as { canCommit: () => boolean };
      if (!options.canCommit()) throw new Error('Policy changed before insertion');
      inserted++;
      db.prepare(
        "INSERT INTO agent_runs(id,project_id,card_id,name,provider_id,command_json,status,created_at,log_path) VALUES (77,?,?, 'Worker','codex','[]','queued','2026-10-12','')",
      ).run(projectId, cardId);
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
    // Both requests finish provider discovery and wait at the insertion gate.
    await vi.waitFor(() => expect(supervisor.dispatchCard).toHaveBeenCalledTimes(2));
    release();
    const outcomes = await Promise.allSettled(requests);
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(inserted).toBe(1);
    db.close();
  });

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
    expect(text).toMatch(/never change files there yourself/);
    // Its own folder, its master, and a provider that can load the board tools.
    expect(createSession).toHaveBeenCalledWith(
      expect.any(Number),
      expect.objectContaining({ cwd: home, orchestratorId: 'master-1', providerId: 'codex' }),
    );
    expect(briefing({ name: 'X', providers: [], projectIds: [] } as never, [])).toContain('(none)');
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
