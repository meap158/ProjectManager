import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, expect, it } from 'vitest';
import { grokItems, providerConversation, readProviderTranscript } from './providerTranscripts.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'pm-provider-chat-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const id = '27792941-fe24-4856-8426-158715d514d9';
const cwd = path.join(home, 'project');

it('requires a pinned provider identifier and rejects paths or unrelated argv', () => {
  expect(providerConversation('opencode', JSON.stringify(['opencode', '-s', 'ses_test']))).toBe(
    'ses_test',
  );
  expect(providerConversation('grok', JSON.stringify(['grok', '--resume', id]))).toBe(id);
  expect(
    providerConversation('opencode', JSON.stringify(['opencode', '-s', '../other'])),
  ).toBeNull();
  expect(providerConversation('grok', JSON.stringify(['grok', '--resume', '../other']))).toBeNull();
  expect(providerConversation('grok', JSON.stringify(['grok']))).toBeNull();
});

it('reads only this OpenCode conversation and replaces in-place streaming/tool updates', async () => {
  const file = path.join(home, '.local/share/opencode/opencode.db');
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec(
      'CREATE TABLE session (id TEXT, directory TEXT); CREATE TABLE message (id TEXT, session_id TEXT, data TEXT); CREATE TABLE part (id TEXT, message_id TEXT, session_id TEXT, time_created INTEGER, data TEXT);',
    );
    db.prepare('INSERT INTO session VALUES (?, ?)').run('ses_test', cwd);
    db.prepare('INSERT INTO message VALUES (?, ?, ?)').run('m', 'ses_test', '{"role":"assistant"}');
    const insert = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)');
    insert.run(
      'p',
      'm',
      'ses_test',
      1,
      JSON.stringify({
        type: 'tool',
        tool: 'read',
        callID: 'call',
        state: { status: 'running', input: { path: 'app.ts' } },
      }),
    );
    insert.run('foreign', 'm', 'ses_other', 2, '{"type":"text","text":"OTHER CONVERSATION"}');
    const resume = JSON.stringify(['opencode', '--session', 'ses_test']);
    const first = await readProviderTranscript('opencode', resume, cwd, undefined, home);
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.toolId).toBe('call');
    expect((await readProviderTranscript('opencode', resume, cwd, first.next, home)).items).toEqual(
      [],
    );
    db.prepare('UPDATE part SET data = ? WHERE id = ?').run(
      JSON.stringify({
        type: 'tool',
        tool: 'read',
        callID: 'call',
        state: { status: 'completed', input: { path: 'app.ts' }, output: 'contents' },
      }),
      'p',
    );
    const updated = await readProviderTranscript('opencode', resume, cwd, first.next, home);
    expect(updated.reset).toBe(true);
    expect(updated.items[1]).toMatchObject({ kind: 'result', text: 'contents', toolId: 'call' });
    expect(
      (
        await readProviderTranscript(
          'opencode',
          resume,
          path.join(home, 'different'),
          undefined,
          home,
        )
      ).items,
    ).toEqual([]);
  } finally {
    db.close();
  }
});

const line = (update: unknown, conversation = id) =>
  JSON.stringify({
    timestamp: '2026-10-18T00:00:00Z',
    params: { sessionId: conversation, update },
  }) + '\n';
it('joins Grok streamed text, retains failed tool details and ignores other conversations', () => {
  const rows = [
    line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello ' } }),
    line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'world' } }),
    line({
      sessionUpdate: 'tool_call',
      toolCallId: 'call',
      title: 'Read file',
      rawInput: { path: 'a' },
    }),
    line({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call',
      status: 'failed',
      rawOutput: 'not found',
    }),
    line(
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'WRONG' } },
      'different',
    ),
  ];
  const items = grokItems(rows, id);
  expect(items[0]).toMatchObject({ kind: 'assistant', text: 'Hello world' });
  expect(items[1]).toMatchObject({ kind: 'tool', toolId: 'call' });
  expect(items[2]).toMatchObject({ kind: 'result', toolId: 'call', isError: true });
  expect(items).toHaveLength(3);
});

it('waits for complete Grok records and refreshes the snapshot without duplicate chunks', async () => {
  const file = path.join(home, '.grok/sessions', encodeURIComponent(cwd), id, 'updates.jsonl');
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    line({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Hi' } }),
  );
  const resume = JSON.stringify(['grok', '--resume', id]);
  const first = await readProviderTranscript('grok', resume, cwd, undefined, home);
  appendFileSync(file, '{"unfinished":');
  expect((await readProviderTranscript('grok', resume, cwd, first.next, home)).items).toEqual([]);
  appendFileSync(
    file,
    'true}\n' +
      line({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } }),
  );
  const updated = await readProviderTranscript('grok', resume, cwd, first.next, home);
  expect(updated.reset).toBe(true);
  expect(updated.items.map((item) => item.text)).toEqual(['Hi', 'Hello']);
});
