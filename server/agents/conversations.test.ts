import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  antigravityConversationFor,
  claudeCustomTitle,
  codexThreadName,
  grokManualTitle,
  grokSessionExists,
  pickOpenCodeSession,
} from './conversations.js';
import { buildInteractiveArgv, buildResumeArgv, getProvider } from './providers.js';

// Each CLI's own storage, in the shapes they write it (fixtures in a temporary home folder).

let home: string;
const cwd = path.resolve('/work/app');
const START = '2026-10-06T10:00:00.000Z';
const at = (offsetMs: number) => Date.parse(START) + offsetMs;

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'pm-conv-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

function write(rel: string, text: string) {
  const file = path.join(home, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}
const jsonl = (rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

describe('finding the conversation to resume', () => {
  it('OpenCode: the most recently used session begun here since start, not another one', () => {
    const list = [
      { id: 'old', directory: cwd, created: at(-3_600_000), updated: at(60_000) },
      { id: 'mine', directory: cwd, created: at(1_000), updated: at(50_000) },
      { id: 'newer', directory: cwd, created: at(2_000), updated: at(90_000) },
      { id: 'elsewhere', directory: '/other', created: at(3_000), updated: at(99_000) },
    ];
    expect(pickOpenCodeSession(list, cwd, START)).toBe('newer');
    expect(pickOpenCodeSession(list, cwd, START, new Set(['newer']))).toBe('mine');
    expect(pickOpenCodeSession(list, cwd, 'not a date')).toBeNull();
  });

  it('Antigravity: its per-conversation database names the folder (even before any history)', () => {
    const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    mkdirSync(dir, { recursive: true });
    const conversation = (id: string, folder: string) => {
      const db = new DatabaseSync(path.join(dir, `${id}.db`));
      db.exec('CREATE TABLE trajectory_metadata_blob (id TEXT PRIMARY KEY, data BLOB)');
      // Protobuf bytes around the workspace URI, as Antigravity stores it.
      const blob = Buffer.concat([
        Buffer.from([10, 90, 10, 39]),
        Buffer.from(pathToFileURL(folder).href),
        Buffer.from([16, 1]),
      ]);
      db.prepare("INSERT INTO trajectory_metadata_blob VALUES ('main', ?)").run(blob);
      db.close();
    };
    conversation('other-folder', path.resolve('/elsewhere'));
    conversation('mine', cwd);
    const startedJustBefore = new Date(Date.now() - 60_000).toISOString();
    expect(antigravityConversationFor(cwd, startedJustBefore, new Set(), home)).toBe('mine');
    expect(antigravityConversationFor(cwd, startedJustBefore, new Set(['mine']), home)).toBeNull();
  });

  it('Antigravity: the conversation last prompted in this folder since start', () => {
    write(
      '.gemini/antigravity-cli/history.jsonl',
      jsonl([
        { workspace: cwd, conversationId: 'before', timestamp: at(-60_000) },
        { workspace: cwd, conversationId: 'a', timestamp: at(10_000) },
        { workspace: cwd, timestamp: at(15_000) }, // A prompt before the id was known.
        { workspace: '/other', conversationId: 'x', timestamp: at(20_000) },
        { workspace: cwd, conversationId: 'b', timestamp: at(30_000) },
      ]),
    );
    expect(antigravityConversationFor(cwd, START, new Set(), home)).toBe('b');
    expect(antigravityConversationFor(cwd, START, new Set(['b']), home)).toBe('a');
    expect(
      antigravityConversationFor(cwd, new Date(at(40_000)).toISOString(), new Set(), home),
    ).toBeNull();
  });

  it('Grok: a pinned conversation counts once Grok has saved it', () => {
    const id = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
    expect(grokSessionExists(cwd, id, home)).toBe(false);
    write(`.grok/sessions/${encodeURIComponent(cwd)}/${id}/summary.json`, '{}');
    expect(grokSessionExists(cwd, id, home)).toBe(true);
  });

  it('Grok pins its id at launch and resumes it; Claude takes the chosen name', () => {
    const grok = getProvider('grok')!;
    const id = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
    expect(buildInteractiveArgv(grok, { sessionId: id })).toEqual(['grok', '--session-id', id]);
    expect(buildResumeArgv(grok, id)).toEqual(['grok', '--resume', id]);
    expect(
      buildInteractiveArgv(getProvider('claude')!, { sessionId: id, name: 'Fix login' }),
    ).toEqual(['claude', '--session-id', id, '--name', 'Fix login']);
    // CLIs without a name flag get the name by /rename later, not on the command line.
    expect(buildInteractiveArgv(getProvider('codex')!, { name: 'Fix login' })).toEqual(['codex']);
  });
});

describe('names set in the CLI (/rename)', () => {
  it('Claude: the latest custom title; automatic titles are ignored', () => {
    const id = '11111111-2222-4333-8444-555555555555';
    const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    write(
      `.claude/projects/${slug}/${id}.jsonl`,
      jsonl([
        { type: 'custom-title', customTitle: 'First name', sessionId: id },
        { type: 'user', message: 'hi' },
        { type: 'custom-title', customTitle: 'Renamed', sessionId: id },
        { type: 'ai-title', aiTitle: 'Auto title', sessionId: id },
      ]),
    );
    expect(claudeCustomTitle(cwd, id, home)).toBe('Renamed');
    expect(claudeCustomTitle(cwd, '99999999-2222-4333-8444-555555555555', home)).toBeNull();
  });

  it('Codex: the thread name from its session index (latest entry wins)', () => {
    write(
      '.codex/session_index.jsonl',
      jsonl([
        { id: 't1', thread_name: 'Old', updated_at: '2026-10-06T10:00:00Z' },
        { id: 't2', thread_name: 'Other', updated_at: '2026-10-06T10:01:00Z' },
        { id: 't1', thread_name: 'New', updated_at: '2026-10-06T10:02:00Z' },
      ]),
    );
    expect(codexThreadName('t1', home)).toBe('New');
    expect(codexThreadName('missing', home)).toBeNull();
  });

  it('Grok: only a manual title counts', () => {
    const id = '0f1e2d3c-4b5a-4987-8a6b-5c4d3e2f1a0b';
    const file = `.grok/sessions/${encodeURIComponent(cwd)}/${id}/summary.json`;
    write(file, JSON.stringify({ generated_title: 'Auto', title_is_manual: false }));
    expect(grokManualTitle(cwd, id, home)).toBeNull();
    write(file, JSON.stringify({ generated_title: 'Mine', title_is_manual: true }));
    expect(grokManualTitle(cwd, id, home)).toBe('Mine');
  });
});
