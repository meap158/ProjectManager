import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { openDb } from './db.js';
import { insertCard, insertProject, getCard } from './store.js';
import { boardConnection, issueBoardGrant, registerBoardMcp } from './boardMcp.js';
import { SopStore } from './sops.js';

function setup() {
  const db = openDb(':memory:');
  const project = insertProject(db, 'Test', process.cwd());
  const card = insertCard(db, project, { title: 'Task', description: '', status: 'todo' });
  const other = insertCard(db, project, { title: 'Other', description: '', status: 'todo' });
  db.prepare(
    `INSERT INTO agent_sessions (project_id, card_id, name, provider_id, command_json, cwd, status, desired_state, supervise, created_at, started_at, log_path)
    VALUES (?, ?, 'Agent', 'codex', '{}', ?, 'running', 'running', 1, '2026-10-06', '2026-10-06', 'test-log')`,
  ).run(project, card.id, process.cwd());
  const token = issueBoardGrant(db, { kind: 'session', id: 1, logPath: 'test-log' });
  const app = new Hono();
  registerBoardMcp(app, db, 'unused', undefined, new SopStore(null));
  const call = (name: string, args: object = {}, auth = token) =>
    app.request('/board-mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
  return { db, card, other, call };
}

describe('card-scoped board MCP', () => {
  it("audits the session's own project against the SOPs, card or not (PM-316)", async () => {
    const { db, call } = setup();
    db.prepare('UPDATE agent_sessions SET card_id = NULL WHERE id = 1').run();
    const res = (await (await call('sop_check')).json()).result;
    expect(res.isError).toBeUndefined();
    const value = JSON.parse(res.content[0].text);
    expect(value.project).toBe('Test');
    expect(value.results.map((r: { sopId: string }) => r.sopId)).toContain('agent-instructions');
    expect((await (await call('sop_check', { projectId: 99 })).json()).result.isError).toBe(true);
    db.close();
  });
  it('rejects missing capabilities and never accepts caller-selected card ids', async () => {
    const { db, other, call } = setup();
    expect((await call('get_card', {}, '')).status).toBe(403);
    expect(
      (await (await call('update_status', { status: 'done', cardId: other.id })).json()).result
        .isError,
    ).toBe(true);
    expect(getCard(db, other.id)?.status).toBe('todo');
    db.close();
  });
  it('follows reattachment, denies detached/deleted owners, and audits mutations', async () => {
    const { db, card, other, call } = setup();
    await call('update_status', { status: 'review' });
    await call('add_note', { note: 'Tests passed' });
    expect(getCard(db, card.id)?.status).toBe('review');
    expect(getCard(db, card.id)?.description).toContain('Tests passed');
    expect(db.prepare('SELECT * FROM board_agent_audit').all()).toHaveLength(2);
    db.prepare('UPDATE agent_sessions SET card_id = ? WHERE id = 1').run(other.id);
    const current = await (await call('get_card')).json();
    expect(JSON.parse(current.result.content[0].text).id).toBe(other.id);
    db.prepare('UPDATE agent_sessions SET card_id = NULL WHERE id = 1').run();
    expect((await (await call('add_note', { note: 'No' })).json()).result.isError).toBe(true);
    db.prepare("UPDATE agent_sessions SET log_path = 'reused-id' WHERE id = 1").run();
    expect((await call('get_card')).status).toBe(403);
    db.close();
  });
  it('lets a session without a card create one, then scopes it to that card', async () => {
    const { db, call } = setup();
    db.prepare('UPDATE agent_sessions SET card_id = NULL WHERE id = 1').run();
    const result = async (name: string, args: object = {}) =>
      (await (await call(name, args)).json()).result as {
        isError?: boolean;
        content: { text: string }[];
      };

    expect((await result('get_card')).content[0]!.text).toMatch(/create_card/);
    const created = await result('create_card', {
      title: 'Fix flaky login',
      notes: 'From terminal',
    });
    expect(created.isError).toBeUndefined();
    const card = JSON.parse(created.content[0]!.text) as { id: number; status: string };
    expect(card.status).toBe('in_progress');
    // Assigned to the session, audited, and now the card its other tools act on.
    expect(
      (db.prepare('SELECT card_id FROM agent_sessions WHERE id = 1').get() as { card_id: number })
        .card_id,
    ).toBe(card.id);
    expect(
      db.prepare('SELECT action FROM board_agent_audit WHERE card_id = ?').all(card.id),
    ).toEqual([{ action: 'create_card' }]);
    expect((await result('update_status', { status: 'review' })).isError).toBeUndefined();
    expect(getCard(db, card.id)?.status).toBe('review');
    // No hopping: with a card assigned, create_card is refused.
    expect((await result('create_card', { title: 'Another' })).isError).toBe(true);
  });

  it('keeps tokens out of argv and preserves existing CLI configuration', () => {
    const { db } = setup();
    const owner = { kind: 'session' as const, id: 1, logPath: 'test-log' };
    // A throwaway data folder and Claude home: a Claude session records which login it uses, and
    // with the repo as data folder and the real ~/.claude it wrote the owner's login into the repo.
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pm-board-conn-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(dataDir, 'claude-home');
    try {
      for (const provider of ['claude', 'codex', 'opencode', 'antigravity']) {
        const bin = provider === 'antigravity' ? 'agy' : provider;
        const result = boardConnection(db, dataDir, owner, provider, [bin, 'hello'], {
          OPENCODE_CONFIG_CONTENT: '{"model":"existing"}',
        });
        expect(result.env.PM_BOARD_TOKEN).toHaveLength(64);
        expect(result.command.join(' ')).not.toContain(result.env.PM_BOARD_TOKEN);
        if (provider === 'opencode')
          expect(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT!).model).toBe('existing');
        if (provider === 'antigravity') {
          const mcpDir = path.join(dataDir, 'antigravity-mcp');
          const addDir = mcpDir.replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
          expect(result.command).toEqual(['agy', '--add-dir', addDir, 'hello']);
          if (/^[A-Za-z]:/.test(dataDir)) expect(result.command[2]).toMatch(/^[a-z]:/);
          const rawConfig = readFileSync(path.join(mcpDir, '.agents', 'mcp_config.json'), 'utf8');
          expect(rawConfig).not.toContain(result.env.PM_BOARD_TOKEN);
          const parsed = JSON.parse(rawConfig) as {
            mcpServers: { projectmanager: { command: string; args: string[]; env?: unknown } };
          };
          expect(parsed.mcpServers.projectmanager.command).toBe(process.execPath);
          expect(parsed.mcpServers.projectmanager.args[0]).toMatch(/board-mcp\.mjs$/);
          expect(parsed.mcpServers.projectmanager.args[1]).toBe(dataDir);
          expect(parsed.mcpServers.projectmanager.env).toBeUndefined();
          expect(readdirSync(path.join(mcpDir, '.agents'))).toEqual(['mcp_config.json']);
        }
      }
    } finally {
      db.close();
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('allows its own board tools up front for a one-shot Claude run, not a session (PM-419)', () => {
    const { db } = setup();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pm-board-allow-'));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = path.join(dataDir, 'claude-home');
    try {
      const command = (kind: 'run' | 'session') =>
        boardConnection(db, dataDir, { kind, id: 1, logPath: `log-${kind}` }, 'claude', [
          'claude',
          '-p',
          'task',
        ]).command;
      const run = command('run');
      expect(run[run.indexOf('--allowedTools') + 1]).toBe('mcp__projectmanager');
      expect(run.slice(-2)).toEqual(['-p', 'task']);
      expect(command('session')).not.toContain('--allowedTools');
    } finally {
      db.close();
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('allows projectmanager MCP tools for one-shot Antigravity runs without altering existing settings', () => {
    const { db } = setup();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pm-board-agy-allow-'));
    try {
      const mcpDir = path.join(dataDir, 'antigravity-mcp');
      const addDir = mcpDir.replace(/^([A-Z]):/, (_, d: string) => `${d.toLowerCase()}:`);
      const run = boardConnection(
        db,
        dataDir,
        { kind: 'run', id: 1, logPath: 'log-run' },
        'antigravity',
        ['agy', '-p', 'task'],
        {},
      ).command;
      expect(run.slice(0, 3)).toEqual(['agy', '--add-dir', addDir]);
      expect(JSON.parse(run[run.indexOf('--settings') + 1]!)).toEqual({
        permissions: { allow: ['mcp(projectmanager/*)'] },
      });
      expect(run.slice(-2)).toEqual(['-p', 'task']);

      const session = boardConnection(
        db,
        dataDir,
        { kind: 'session', id: 1, logPath: 'log-session' },
        'antigravity',
        ['agy', '-i', 'hello'],
        {},
      ).command;
      expect(session).toEqual(['agy', '--add-dir', addDir, '-i', 'hello']);
      expect(session).not.toContain('--settings');

      const custom = boardConnection(
        db,
        dataDir,
        { kind: 'run', id: 1, logPath: 'log-custom' },
        'antigravity',
        ['agy', '--settings', '{"custom":true}', '-p', 'task'],
        {},
      ).command;
      expect(custom).toEqual([
        'agy',
        '--add-dir',
        addDir,
        '--settings',
        '{"custom":true}',
        '-p',
        'task',
      ]);
    } finally {
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('spawns a working board-mcp stdio bridge from the generated Antigravity config', async () => {
    const { db, card } = setup();
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pm-board-agy-bridge-'));
    const bridgeApp = new Hono();
    registerBoardMcp(bridgeApp, db, dataDir, undefined, new SopStore(null));
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      req.on('end', () => {
        void bridgeApp
          .request((req.url || '/api/board-mcp').replace(/^\/api/, ''), {
            method: req.method || 'POST',
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([k, v]) => [
                k,
                Array.isArray(v) ? v.join(', ') : v || '',
              ]),
            ),
            body: Buffer.concat(chunks),
          })
          .then(async (response) => {
            res.statusCode = response.status;
            res.setHeader(
              'content-type',
              response.headers.get('content-type') || 'application/json',
            );
            res.end(await response.text());
          })
          .catch((err) => {
            res.statusCode = 500;
            res.end(String(err));
          });
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('expected TCP port');
    writeFileSync(
      path.join(dataDir, 'server.json'),
      JSON.stringify({ url: `http://127.0.0.1:${address.port}` }),
      'utf8',
    );
    try {
      const connection = boardConnection(
        db,
        dataDir,
        { kind: 'session', id: 1, logPath: 'test-log' },
        'antigravity',
        ['agy', '-i', 'hello'],
        {},
      );
      const cfg = JSON.parse(
        readFileSync(path.join(dataDir, 'antigravity-mcp', '.agents', 'mcp_config.json'), 'utf8'),
      ) as { mcpServers: { projectmanager: { command: string; args: string[] } } };
      const child = spawn(
        cfg.mcpServers.projectmanager.command,
        cfg.mcpServers.projectmanager.args,
        {
          env: { ...process.env, ...connection.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      try {
        const responses = new Map<number, { result?: unknown; error?: unknown }>();
        let buffer = '';
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
          buffer += chunk;
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? '';
          for (const line of lines) {
            if (!line.trim()) continue;
            const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown };
            if (typeof msg.id === 'number') responses.set(msg.id, msg);
          }
        });
        const waitForId = (id: number) =>
          new Promise<{ result?: unknown; error?: unknown }>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(new Error(`Timed out waiting for response ${id}`)),
              5000,
            );
            const check = setInterval(() => {
              const hit = responses.get(id);
              if (hit) {
                clearInterval(check);
                clearTimeout(timer);
                resolve(hit);
              }
            }, 20);
          });
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
        );
        await waitForId(1);
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
        );
        child.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`,
        );
        const listReply = await waitForId(2);
        expect(listReply.error).toBeUndefined();
        const listed = (listReply.result as { tools: Array<{ name: string }> }).tools.map(
          (t) => t.name,
        );
        expect(listed).toContain('add_note');
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 3,
            method: 'tools/call',
            params: { name: 'add_note', arguments: { note: 'Via Antigravity bridge' } },
          })}\n`,
        );
        const reply = await waitForId(3);
        expect(reply.error).toBeUndefined();
        const result = reply.result as { isError?: boolean; content: Array<{ text: string }> };
        expect(result.isError).toBeUndefined();
        expect(getCard(db, card.id)?.description).toContain('Via Antigravity bridge');
        child.stdin.end();
        await new Promise<void>((resolve) => child.once('exit', () => resolve()));
      } finally {
        if (child.exitCode === null) child.kill();
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('message_orchestrator (PM-432)', () => {
  it('passes the grant owner as the sender, whatever the arguments say', async () => {
    const db = openDb(':memory:');
    const project = insertProject(db, 'Test', process.cwd());
    db.prepare(
      `INSERT INTO agent_sessions (project_id, card_id, name, provider_id, command_json, cwd, status, desired_state, supervise, created_at, started_at, log_path)
      VALUES (?, NULL, 'Agent', 'codex', '{}', ?, 'running', 'running', 1, '2026-10-06', '2026-10-06', 'test-log')`,
    ).run(project, process.cwd());
    const token = issueBoardGrant(db, { kind: 'session', id: 1, logPath: 'test-log' });
    const calls: [number, Record<string, unknown>][] = [];
    const app = new Hono();
    registerBoardMcp(app, db, 'unused', {
      tools: [],
      call: async () => null,
      fromWorker: (sessionId, args) => {
        calls.push([sessionId, args]);
        return { sent: true };
      },
    });
    const res = await app.request('/board-mcp', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'message_orchestrator',
          arguments: { kind: 'question', text: 'Which DB?' },
        },
      }),
    });
    expect((await res.json()).result.isError).toBeUndefined();
    expect(calls).toEqual([[1, { kind: 'question', text: 'Which DB?' }]]);
    db.close();
  });
});
