// Behaviour tests for agent CLI sessions and runs: the API the way its users
// (the GUI) call it, against real OS processes. `process.execPath` stands in
// for AI CLIs so the suite never depends on tools being installed.

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRun, AgentSession } from '../../shared/types.js';
import { createApp } from '../app.js';
import { openDb, type Db } from '../db.js';
import { AgentSupervisor } from './supervisor.js';
import { setSetting, getSetting, insertCard, insertProject } from '../store.js';

const HOST = { host: 'localhost:5180' };
const NODE = process.execPath;
const ECHO = `console.log('hello-agents')`;
const ECHO_STDIN = `process.stdin.on('data',d=>{process.stdout.write('echo:'+d);process.exit(0)})`;
const LONG = `setInterval(()=>{},1000)`;
const FAIL = `process.exit(1)`;
const SLEEP_20 = `setTimeout(()=>{},20000)`;

let tmp: string;
let app: ReturnType<typeof createApp>;
let call: (method: string, url: string, body?: unknown) => Promise<Response>;
let projectDir: string;
let projectId: number;
let testDb: Db;

async function waitFor<T>(
  fn: () => Promise<T>,
  pred: (v: T) => boolean,
  label: string,
): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (pred(v)) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const getSession = async (id: number): Promise<AgentSession> =>
  (await (await call('GET', `/agent-sessions/${id}`)).json()) as AgentSession;
const getRun = async (id: number): Promise<AgentRun> =>
  (await (await call('GET', `/agent-runs/${id}`)).json()) as AgentRun;

beforeAll(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'pm-agents-'));
  projectDir = path.join(tmp, 'proj');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(projectDir, { recursive: true });
  testDb = openDb(':memory:');
  app = createApp(testDb, { dataDir: tmp });
  // Mirror the real GUI client: every write carries a JSON body + content type
  // (the server rejects non-JSON writes as a CSRF guard).
  call = (method: string, url: string, body?: unknown) =>
    app.request(`/api${url}`, {
      method,
      headers: {
        ...HOST,
        ...(method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
    });
  const created = await call('POST', '/projects', { path: projectDir });
  expect(created.status).toBe(201);
  projectId = ((await created.json()) as { id: number }).id;
}, 30_000);

afterAll(async () => {
  await app.supervisor.shutdown();
  rmSync(tmp, { recursive: true, force: true });
});

describe('providers', () => {
  it('replays recorded geometry without inferring a legacy canvas from the archive', async () => {
    const created = (await (
      await call('POST', `/projects/${projectId}/agent-sessions`, {
        command: [
          NODE,
          '-e',
          `process.stdout.write('\u001b]777;pm-size;80;24\u0007\\x1b[40;319Hlegacy-wide-text')`,
        ],
        terminal: 'pipe',
        supervise: false,
      })
    ).json()) as AgentSession;
    try {
      await waitFor(
        () => getSession(created.id),
        (s) => s.status !== 'running',
        'geometry log',
      );
      // The fixture process uses pipes so no installed/native PTY is required.
      testDb.prepare("UPDATE agent_sessions SET terminal = 'pty' WHERE id = ?").run(created.id);
      const out = app.supervisor.readSessionOutput(created.id, 0)!;
      expect(out.data).toContain('\x1b]777;pm-size;80;24\x07');
      expect(out.terminalSize).toBeUndefined();
      expect(out.nextOffset).toBe(out.logBytes);
    } finally {
      await call('DELETE', `/agent-sessions/${created.id}`);
    }
  });
  it('restarts through one endpoint and reports shared progress', async () => {
    const created = await call('POST', `/projects/${projectId}/agent-sessions`, {
      command: [NODE, '-e', LONG],
      terminal: 'pipe',
      supervise: false,
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as AgentSession;
    const restarted = await call('POST', `/agent-sessions/${session.id}/restart`);
    expect(restarted.status).toBe(200);
    const next = (await restarted.json()) as AgentSession;
    expect(next.status).toBe('running');
    expect(next.restartProgress).toBe('restoring');
    expect(next.pid).not.toBe(session.pid);
    await call('DELETE', `/agent-sessions/${session.id}`);
  });

  it('clears restoring progress once the restarted session is ready', async () => {
    const created = await call('POST', `/projects/${projectId}/agent-sessions`, {
      command: [NODE, '-e', `console.log('\\n>\\n'); setInterval(()=>{}, 1000)`],
      terminal: 'pipe',
      supervise: false,
    });
    expect(created.status).toBe(201);
    const session = (await created.json()) as AgentSession;
    await call('POST', `/agent-sessions/${session.id}/restart`);
    const restored = await waitFor(
      () => getSession(session.id),
      (s) => s.restartProgress === null,
      'readiness confirmation',
    );
    expect(restored.restartProgress).toBeNull();
    expect(restored.status).toBe('running');
    await call('DELETE', `/agent-sessions/${session.id}`);
  });

  it('keeps the saved conversation when a manual restart fails to resume', async () => {
    const created = await call('POST', `/projects/${projectId}/agent-sessions`, {
      command: [NODE, '-e', LONG],
      terminal: 'pipe',
      supervise: true,
    });
    const session = (await created.json()) as AgentSession;
    const resume = JSON.stringify([NODE, '-e', 'process.exit(1)']);
    testDb
      .prepare('UPDATE agent_sessions SET resume_json = ? WHERE id = ?')
      .run(resume, session.id);
    await call('POST', `/agent-sessions/${session.id}/restart`);
    const failed = await waitFor(
      () => getSession(session.id),
      (s) => s.restartProgress === 'failed',
      'resume failure',
    );
    expect(failed.restartError).toContain('saved conversation failed to resume');
    expect(
      testDb.prepare('SELECT resume_json FROM agent_sessions WHERE id = ?').get(session.id)
        ?.resume_json,
    ).toBe(resume);
    const retry = await call('POST', `/agent-sessions/${session.id}/restart`);
    expect(retry.status).toBe(409);
    await call('DELETE', `/agent-sessions/${session.id}`);
  });

  it('rejects managed continuation for unsupported sessions', async () => {
    const created = await call('POST', `/projects/${projectId}/agent-sessions`, {
      command: [NODE, '-e', LONG],
      terminal: 'pipe',
      supervise: false,
    });
    const session = (await created.json()) as AgentSession;
    expect(
      (await call('POST', `/agent-sessions/${session.id}/auto-continue`, { enabled: true })).status,
    ).toBe(400);
    expect(
      (await call('POST', `/agent-sessions/${session.id}/auto-continue`, { enabled: 'yes' }))
        .status,
    ).toBe(400);
    await call('DELETE', `/agent-sessions/${session.id}`);
  });
  it('lists the catalog with availability', async () => {
    const res = await call('GET', '/agents/providers');
    expect(res.status).toBe(200);
    const providers = (await res.json()) as { id: string; available: boolean }[];
    const ids = providers.map((p) => p.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'claude',
        'codex',
        'grok',
        'antigravity',
        'opencode',
        'shell',
        'custom',
      ]),
    );
    expect(ids).not.toContain('gemini'); // Removed: Antigravity replaced it.
    // Grok sits below Codex and above Antigravity; Antigravity sits above OpenCode.
    expect(ids.indexOf('grok')).toBeGreaterThan(ids.indexOf('codex'));
    expect(ids.indexOf('antigravity')).toBeGreaterThan(ids.indexOf('grok'));
    expect(ids.indexOf('antigravity')).toBeLessThan(ids.indexOf('opencode'));
    expect(providers.find((p) => p.id === 'shell')?.available).toBe(true);
    expect(providers.find((p) => p.id === 'custom')?.available).toBe(true);
  });

  it('rejects unknown providers and empty commands', async () => {
    expect(
      (await call('POST', `/projects/${projectId}/agent-sessions`, { providerId: 'nope' })).status,
    ).toBe(400);
    expect(
      (await call('POST', `/projects/${projectId}/agent-sessions`, { command: [] })).status,
    ).toBe(400);
    expect((await call('POST', `/projects/${projectId}/agent-sessions`, {})).status).toBe(400);
  });
});

describe('sessions', () => {
  it('cancels persisted continuation on real input, but preserves it for terminal reports', async () => {
    const created = await call('POST', `/projects/${projectId}/agent-sessions`, {
      command: [NODE, '-e', LONG],
      terminal: 'pipe',
      supervise: false,
    });
    const session = (await created.json()) as AgentSession;
    const key = `session-auto-continue:${session.id}`;
    setSetting(testDb, key, {
      enabled: true,
      resumesAt: '2099-01-01T00:00:00Z',
      message: 'Waiting',
    });
    await call('POST', `/agent-sessions/${session.id}/input`, { data: '\x1b[1;1R' });
    expect(getSetting<{ enabled: boolean }>(testDb, key)?.enabled).toBe(true);
    await call('POST', `/agent-sessions/${session.id}/input`, { data: 'x' });
    expect(getSetting<{ enabled: boolean }>(testDb, key)?.enabled).toBe(false);
    setSetting(testDb, key, {
      enabled: true,
      resumesAt: '2099-01-01T00:00:00Z',
      message: 'Waiting',
    });
    await call('POST', `/agent-sessions/${session.id}/stop`);
    expect(getSetting<{ enabled: boolean }>(testDb, key)?.enabled).toBe(false);
    await call('DELETE', `/agent-sessions/${session.id}`);
    expect(getSetting(testDb, key)).toBeNull();
  });

  it('remembers when you last sent a message: Enter, not each keystroke (PM-94)', async () => {
    const created = await call('POST', `/projects/${projectId}/agent-sessions`, {
      command: [NODE, '-e', LONG],
      terminal: 'pipe',
      supervise: false,
    });
    const session = (await created.json()) as AgentSession;
    const lastInput = async () =>
      ((await (await call('GET', `/agent-sessions/${session.id}`)).json()) as AgentSession)
        .lastInputAt;
    expect(session.lastInputAt).toBeNull();
    await call('POST', `/agent-sessions/${session.id}/input`, { data: 'fix the bug' });
    await call('POST', `/agent-sessions/${session.id}/input`, { data: '\x1b[1;1R' });
    expect(await lastInput()).toBeNull();
    await call('POST', `/agent-sessions/${session.id}/input`, { data: '\r' });
    expect(Date.parse((await lastInput())!)).toBeGreaterThan(Date.now() - 60_000);
    await call('DELETE', `/agent-sessions/${session.id}`);
  });
  it('runs a one-shot command and serves its output', async () => {
    const res = await call('POST', `/projects/${projectId}/agent-sessions`, {
      providerId: 'custom',
      command: [NODE, '-e', ECHO],
      supervise: false,
      name: 'echo',
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as AgentSession;
    const done = await waitFor(
      () => getSession(created.id),
      (s) => s.status !== 'running',
      'session to exit',
    );
    expect(done.status).toBe('exited');
    expect(done.exitCode).toBe(0);
    const caches = app.supervisor as unknown as { logs: Map<string, { chunks: unknown[] }> };
    expect(caches.logs.get(`session:${created.id}`)?.chunks).toHaveLength(0);
    const out = (await (
      await call('GET', `/agent-sessions/${created.id}/output?after=0`)
    ).json()) as { data: string; nextOffset: number };
    expect(out.data).toContain('hello-agents');
    expect(out.nextOffset).toBeGreaterThan(0);
    // Offset polling: nothing new after the end.
    const tail = (await (
      await call('GET', `/agent-sessions/${created.id}/output?after=${out.nextOffset}`)
    ).json()) as { data: string };
    expect(tail.data).toBe('');
    expect((await call('DELETE', `/agent-sessions/${created.id}`)).status).toBe(204);
    expect((await call('GET', `/agent-sessions/${created.id}`)).status).toBe(404);
  }, 20_000);

  it('writes stdin to a live session', async () => {
    const created = (await (
      await call('POST', `/projects/${projectId}/agent-sessions`, {
        providerId: 'custom',
        command: [NODE, '-e', ECHO_STDIN],
        supervise: false,
        terminal: 'pipe',
      })
    ).json()) as AgentSession;
    const sent = await call('POST', `/agent-sessions/${created.id}/input`, { data: 'ping\n' });
    expect(sent.status).toBe(200);
    expect(((await sent.json()) as { queued: boolean }).queued).toBe(false);
    await waitFor(
      async () =>
        (
          (await (await call('GET', `/agent-sessions/${created.id}/output?after=0`)).json()) as {
            data: string;
          }
        ).data,
      (data) => data.includes('echo:ping'),
      'stdin echo',
    );
    await call('DELETE', `/agent-sessions/${created.id}`);
  }, 20_000);

  it('queues stdin while stopped and flushes on start', async () => {
    const created = (await (
      await call('POST', `/projects/${projectId}/agent-sessions`, {
        providerId: 'custom',
        command: [NODE, '-e', ECHO_STDIN],
        supervise: false,
        terminal: 'pipe',
      })
    ).json()) as AgentSession;
    expect((await call('POST', `/agent-sessions/${created.id}/stop`)).status).toBe(200);
    await waitFor(
      () => getSession(created.id),
      (s) => s.status !== 'running',
      'session to stop',
    );
    const queued = await call('POST', `/agent-sessions/${created.id}/input`, { data: 'hello\n' });
    expect(((await queued.json()) as { queued: boolean }).queued).toBe(true);
    expect((await getSession(created.id)).queuedInputBytes).toBeGreaterThan(0);
    expect((await call('POST', `/agent-sessions/${created.id}/start`)).status).toBe(200);
    await waitFor(
      async () =>
        (
          (await (await call('GET', `/agent-sessions/${created.id}/output?after=0`)).json()) as {
            data: string;
          }
        ).data,
      (data) => data.includes('echo:hello'),
      'queued stdin flush',
    );
    await call('DELETE', `/agent-sessions/${created.id}`);
  }, 20_000);

  it('stops and restarts a long-running session', async () => {
    const created = (await (
      await call('POST', `/projects/${projectId}/agent-sessions`, {
        providerId: 'custom',
        command: [NODE, '-e', LONG],
        supervise: true,
      })
    ).json()) as AgentSession;
    const running = await waitFor(
      () => getSession(created.id),
      (s) => s.pid !== null,
      'pid',
    );
    expect(running.status).toBe('running');
    const stopped = (await (
      await call('POST', `/agent-sessions/${created.id}/stop`)
    ).json()) as AgentSession;
    expect(stopped.desiredState).toBe('stopped');
    await waitFor(
      () => getSession(created.id),
      (s) => s.status === 'killed',
      'killed',
    );
    const started = (await (
      await call('POST', `/agent-sessions/${created.id}/start`)
    ).json()) as AgentSession;
    expect(started.status).toBe('running');
    expect(started.restarts).toBe(0);
    // Rename + supervise toggle ride the same PATCH route.
    const patched = (await (
      await call('PATCH', `/agent-sessions/${created.id}`, { name: 'camper', supervise: false })
    ).json()) as AgentSession;
    expect(patched.name).toBe('camper');
    expect(patched.supervise).toBe(false);
    await call('DELETE', `/agent-sessions/${created.id}`);
  }, 30_000);

  it('starts a real OS shell session', async () => {
    const created = (await (
      await call('POST', `/projects/${projectId}/agent-sessions`, { providerId: 'shell' })
    ).json()) as AgentSession;
    expect(created.status).toBe('running');
    await call('POST', `/agent-sessions/${created.id}/stop`);
    await call('DELETE', `/agent-sessions/${created.id}`);
  }, 20_000);
});

describe('runs and card lifecycle', () => {
  it('reuses a durable dispatch key without creating another worker', async () => {
    const card = (await (
      await call('POST', `/projects/${projectId}/cards`, { title: 'Idempotent task' })
    ).json()) as { id: number };
    const input = { command: [NODE, '-e', ECHO], dispatchKey: `test-dispatch-${card.id}` };
    await expect(
      app.supervisor.dispatchCard(projectId, card.id, { ...input, canCommit: () => false }),
    ).rejects.toThrow('ownership or policy changed');
    expect(
      testDb
        .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE dispatch_key = ?')
        .get(input.dispatchKey)?.n,
    ).toBe(0);
    const first = await app.supervisor.dispatchCard(projectId, card.id, input);
    const again = await app.supervisor.dispatchCard(projectId, card.id, input);
    expect(again.id).toBe(first.id);
    expect(
      testDb
        .prepare('SELECT COUNT(*) AS n FROM agent_runs WHERE dispatch_key = ?')
        .get(input.dispatchKey)?.n,
    ).toBe(1);
    await waitFor(
      () => getRun(first.id),
      (r) => r.status === 'succeeded',
      'idempotent run',
    );
    expect((await app.supervisor.dispatchCard(projectId, card.id, input)).id).toBe(first.id);
  });
  it('dispatches a card, succeeds it, and validates it to Review', async () => {
    const card = (await (
      await call('POST', `/projects/${projectId}/cards`, { title: 'Agent task' })
    ).json()) as { id: number; status: string };
    const dispatched = await call('POST', `/projects/${projectId}/cards/${card.id}/dispatch`, {
      command: [NODE, '-e', `console.log('work done')`],
    });
    expect(dispatched.status).toBe(201);
    const run = (await dispatched.json()) as AgentRun;
    // Dispatching starts the work: backlog moves to In progress.
    const moved = (await (await call('GET', `/projects/${projectId}/cards`)).json()) as {
      id: number;
      status: string;
    }[];
    expect(moved.find((c) => c.id === card.id)?.status).toBe('in_progress');

    const done = await waitFor(
      () => getRun(run.id),
      (r) => r.status !== 'running' && r.status !== 'queued',
      'run',
    );
    expect(done.status).toBe('succeeded');
    expect(done.exitCode).toBe(0);
    const caches = app.supervisor as unknown as { logs: Map<string, { chunks: unknown[] }> };
    expect(caches.logs.get(`run:${run.id}`)?.chunks).toHaveLength(0);
    const out = (await (await call('GET', `/agent-runs/${run.id}/output?after=0`)).json()) as {
      data: string;
    };
    expect(out.data).toContain('work done');

    const summary = (await (
      await call('GET', `/projects/${projectId}/agent-runs/summary`)
    ).json()) as { cardId: number; awaitingValidation: number }[];
    expect(summary.find((s) => s.cardId === card.id)?.awaitingValidation).toBe(1);

    // Validating a still-running run is rejected.
    const longCard = (await (
      await call('POST', `/projects/${projectId}/cards`, { title: 'Long task' })
    ).json()) as { id: number };
    const longRun = (await (
      await call('POST', `/projects/${projectId}/cards/${longCard.id}/dispatch`, {
        command: [NODE, '-e', LONG],
      })
    ).json()) as AgentRun;
    expect(
      (await call('POST', `/agent-runs/${longRun.id}/validate`, { decision: 'accepted' })).status,
    ).toBe(409);
    await call('POST', `/agent-runs/${longRun.id}/stop`);

    const validated = (await (
      await call('POST', `/agent-runs/${run.id}/validate`, { decision: 'accepted' })
    ).json()) as AgentRun;
    expect(validated.validation).toBe('accepted');
    expect(validated.validatedMove).toBe('review');
    const cards = (await (await call('GET', `/projects/${projectId}/cards`)).json()) as {
      id: number;
      status: string;
    }[];
    expect(cards.find((c) => c.id === card.id)?.status).toBe('review');
    // Double validation is rejected.
    expect(
      (await call('POST', `/agent-runs/${run.id}/validate`, { decision: 'accepted' })).status,
    ).toBe(409);
    // Retry clones the run.
    const retried = await call('POST', `/agent-runs/${run.id}/retry`);
    expect(retried.status).toBe(201);
    const retry = (await retried.json()) as AgentRun;
    await waitFor(
      () => getRun(retry.id),
      (r) => r.status === 'succeeded',
      'retry',
    );
    await call('DELETE', `/agent-runs/${run.id}`);
    await call('DELETE', `/agent-runs/${retry.id}`);
    await call('DELETE', `/agent-runs/${longRun.id}`);
  }, 60_000);

  it('rejects a failed run back to To do', async () => {
    const card = (await (
      await call('POST', `/projects/${projectId}/cards`, { title: 'Failing task' })
    ).json()) as { id: number };
    const run = (await (
      await call('POST', `/projects/${projectId}/cards/${card.id}/dispatch`, {
        command: [NODE, '-e', FAIL],
      })
    ).json()) as AgentRun;
    const failed = await waitFor(
      () => getRun(run.id),
      (r) => r.status === 'failed',
      'failure',
    );
    expect(failed.error).toContain('code 1');
    const rejected = (await (
      await call('POST', `/agent-runs/${run.id}/validate`, { decision: 'rejected' })
    ).json()) as AgentRun;
    expect(rejected.validation).toBe('rejected');
    const cards = (await (await call('GET', `/projects/${projectId}/cards`)).json()) as {
      id: number;
      status: string;
    }[];
    expect(cards.find((c) => c.id === card.id)?.status).toBe('todo');
    await call('DELETE', `/agent-runs/${run.id}`);
  }, 30_000);

  it('times out a hung run', async () => {
    const card = (await (
      await call('POST', `/projects/${projectId}/cards`, { title: 'Hung task' })
    ).json()) as { id: number };
    const run = (await (
      await call('POST', `/projects/${projectId}/cards/${card.id}/dispatch`, {
        command: [NODE, '-e', SLEEP_20],
        timeoutMin: 0.02,
      })
    ).json()) as AgentRun;
    const timedOut = await waitFor(
      () => getRun(run.id),
      (r) => r.status === 'failed',
      'timeout',
    );
    expect(timedOut.error).toContain('Timed out');
    await call('DELETE', `/agent-runs/${run.id}`);
  }, 30_000);
});

describe('reboot persistence', () => {
  let dbFile: string;
  let db: Db;
  let logs: string;
  let sup1: AgentSupervisor | null = null;
  let sup2: AgentSupervisor | null = null;

  beforeAll(() => {
    dbFile = path.join(tmp, 'reboot');
    logs = path.join(tmp, 'reboot-logs');
  });

  afterAll(async () => {
    await sup1?.shutdown();
    await sup2?.shutdown();
    db?.close();
  });

  it('relaunches supervised sessions and requeues runs across a restart', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dbFile, { recursive: true });
    db = openDb(dbFile);
    const pid = Number(
      db
        .prepare(`INSERT INTO projects (name, path, created_at) VALUES (?, ?, ?)`)
        .run('camper', projectDir, new Date().toISOString()).lastInsertRowid,
    );
    sup1 = new AgentSupervisor(db, logs);
    const session = await sup1.createSession(pid, {
      providerId: 'custom',
      command: [NODE, '-e', LONG],
      name: 'camper',
    });
    expect(session.status).toBe('running');
    // A one-shot run in flight at shutdown time.
    const runId = Number(
      db
        .prepare(
          `INSERT INTO agent_runs
           (project_id, card_id, name, provider_id, command_json, prompt, status,
            attempts, max_attempts, created_at, log_path)
         VALUES (?, NULL, ?, 'custom', ?, '', 'running', 1, 3, ?, ?)`,
        )
        .run(
          pid,
          'inflight',
          JSON.stringify({ command: [NODE, '-e', LONG], timeoutMs: 600_000 }),
          new Date().toISOString(),
          path.join(logs, 'run-reboot.log'),
        ).lastInsertRowid,
    );

    // "Reboot": shut the old supervisor down, boot a new one on the same data.
    await sup1.shutdown();
    sup1 = null;
    sup2 = new AgentSupervisor(db, logs);

    const relaunched = await waitFor(
      async () => sup2!.getSession(session.id)!,
      (s) => s.status === 'running' && s.pid !== null,
      'session relaunch',
    );
    expect(relaunched.desiredState).toBe('running');
    const output = sup2.readSessionOutput(session.id, 0)!;
    expect(output.data).toContain('relaunched after restart');
    const rerun = await waitFor(
      async () => sup2!.getRun(runId)!,
      (r) => r.status === 'running' && r.attempts === 2,
      'run relaunch',
    );
    expect(rerun.attempts).toBe(2);
    await sup2.stopRun(runId);
    await sup2.removeSession(session.id);
  }, 30_000);

  it('starts fresh when resuming fails right away (no crash loop)', async () => {
    const pid = Number(
      db
        .prepare(`INSERT INTO projects (name, path, created_at) VALUES (?, ?, ?)`)
        .run('resumer', mkdtempSync(path.join(tmp, 'resumer-')), new Date().toISOString())
        .lastInsertRowid,
    );
    sup1 = new AgentSupervisor(db, logs);
    const session = await sup1.createSession(pid, {
      providerId: 'custom',
      command: [NODE, '-e', LONG],
      name: 'resumer',
    });
    // A resume target that dies at once, like `claude --resume <id>` -> "No conversation found".
    db.prepare('UPDATE agent_sessions SET resume_json = ? WHERE id = ?').run(
      JSON.stringify([NODE, '-e', 'process.exit(1)']),
      session.id,
    );
    await sup1.shutdown();
    sup1 = null;
    sup2 = new AgentSupervisor(db, logs);

    const log = await waitFor(
      async () => sup2!.readSessionOutput(session.id, 0)!.data,
      (data) => data.includes('the last resume failed right away'),
      'fresh relaunch after a failed resume',
    );
    // Only the normal launch command runs after the note, then it stays up: no loop.
    expect(log.split('the last resume failed right away')[1]).toContain(LONG);
    const back = await waitFor(
      async () => sup2!.getSession(session.id)!,
      (s) => s.status === 'running' && s.pid !== null,
      'session running',
    );
    await new Promise((r) => setTimeout(r, 1500));
    expect(sup2.getSession(session.id)!.restarts).toBe(back.restarts);
    expect(back.restarts).toBe(1);
    await sup2.removeSession(session.id);
  }, 30_000);
});

describe('parallel run limit', () => {
  it('queues runs beyond the host-wide limit and starts them as slots free up', async () => {
    const db = openDb(':memory:');
    const sup = new AgentSupervisor(db, path.join(tmp, 'limit-logs'), { maxParallelRuns: 1 });
    try {
      const pid = insertProject(db, 'limited', projectDir);
      const dispatch = (title: string) =>
        sup.dispatchCard(pid, insertCard(db, pid, { title, description: '', status: 'todo' }).id, {
          command: [NODE, '-e', LONG],
        });
      const first = await dispatch('First');
      const second = await dispatch('Second');
      await waitFor(
        async () => sup.getRun(first.id)!,
        (r) => r.status === 'running',
        'first run start',
      );
      expect(sup.getRun(second.id)!.status).toBe('queued');
      expect(sup.readRunOutput(second.id, 0)!.data).toContain('1 of 1 parallel runs are busy');

      await sup.stopRun(first.id);
      await waitFor(
        async () => sup.getRun(second.id)!,
        (r) => r.status === 'running',
        'queued run start',
      );
      await sup.stopRun(second.id);
    } finally {
      await sup.shutdown();
      db.close();
    }
  }, 30_000);
});
