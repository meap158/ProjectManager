import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { openDb } from './db.js';
import { insertCard, insertProject, getCard } from './store.js';
import { boardConnection, issueBoardGrant, registerBoardMcp } from './boardMcp.js';

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
  registerBoardMcp(app, db, 'unused');
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
  it('keeps tokens out of argv and preserves existing CLI configuration', () => {
    const { db } = setup();
    const owner = { kind: 'session' as const, id: 1, logPath: 'test-log' };
    for (const provider of ['claude', 'codex', 'opencode']) {
      const result = boardConnection(db, process.cwd(), owner, provider, [provider, 'hello'], {
        OPENCODE_CONFIG_CONTENT: '{"model":"existing"}',
      });
      expect(result.env.PM_BOARD_TOKEN).toHaveLength(64);
      expect(result.command.join(' ')).not.toContain(result.env.PM_BOARD_TOKEN);
      if (provider === 'opencode')
        expect(JSON.parse(result.env.OPENCODE_CONFIG_CONTENT!).model).toBe('existing');
    }
    db.close();
  });
});
