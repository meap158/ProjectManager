import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { boardConnection, registerBoardMcp } from './boardMcp.js';
import { openDb } from './db.js';
import { insertProject } from './store.js';

// Claude switches conversations on /resume, /clear and compaction, so a session's resume target
// follows its SessionStart hook (scripts/claude-session-hook.mjs) instead of the launch id.

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'pm-hook-'));
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

function setup(provider: 'claude' | 'codex') {
  const db = openDb(':memory:');
  const project = insertProject(db, 'Test', process.cwd());
  db.prepare(
    `INSERT INTO agent_sessions (project_id, name, provider_id, command_json, cwd, status, desired_state, supervise, created_at, started_at, log_path)
     VALUES (?, 'Agent', ?, ?, ?, 'running', 'running', 1, '2026-10-06', '2026-10-06', 'hook-log')`,
  ).run(
    project,
    provider,
    JSON.stringify({ command: [provider, '--session-id', 'a1b2c3d4-0000-4000-8000-000000000000'] }),
    process.cwd(),
  );
  const owner = { kind: 'session' as const, id: 1, logPath: 'hook-log' };
  const connection = boardConnection(db, dataDir, owner, provider, [provider], {});
  const app = new Hono().basePath('/api');
  registerBoardMcp(app, db, path.join(dataDir, 'attachments'));
  const report = (sessionId: string, token = connection.env.PM_BOARD_TOKEN ?? '') =>
    app.request('/api/agent-hooks/claude-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ sessionId, source: 'clear' }),
    });
  const resumeJson = () =>
    (
      db.prepare('SELECT resume_json FROM agent_sessions WHERE id = 1').get() as {
        resume_json: string | null;
      }
    ).resume_json;
  return { connection, report, resumeJson };
}

describe('Claude session hook', () => {
  it('is injected into Claude sessions as a SessionStart hook', () => {
    const { connection } = setup('claude');
    const at = connection.command.indexOf('--settings');
    expect(at).toBeGreaterThan(0);
    const settings = JSON.parse(connection.command[at + 1]!) as {
      hooks: { SessionStart: { hooks: { command: string }[] }[] };
    };
    expect(settings.hooks.SessionStart[0]!.hooks[0]!.command).toContain('claude-session-hook.mjs');
    // The token reaches the hook through the environment, never the command line.
    expect(connection.command.join(' ')).not.toContain(connection.env.PM_BOARD_TOKEN!);
  });

  it('stores the live conversation as the resume target, and only for its own session', async () => {
    const { report, resumeJson } = setup('claude');
    const live = '0f0e0d0c-1111-4222-8333-444455556666';
    expect((await report(live)).status).toBe(204);
    expect(JSON.parse(resumeJson()!)).toEqual(['claude', '--resume', live]);
    expect((await report(live, 'not-a-token')).status).toBe(403);
    expect((await report('not-a-uuid')).status).toBe(400);
  });

  it('refuses reports for non-Claude sessions', async () => {
    const { report } = setup('codex');
    expect((await report('0f0e0d0c-1111-4222-8333-444455556666')).status).toBe(403);
  });
});
