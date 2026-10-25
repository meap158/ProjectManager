import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, describe, expect, it } from 'vitest';
import {
  claudeSessionId,
  codexResumeId,
  codexSessionFor,
  findCodexRolloutFile,
  readCodexRolloutUsage,
  readGrokUsage,
  readOpenCodeUsage,
  readTranscriptUsage,
  sessionUsage,
  staleClaudeResume,
  transcriptPath,
} from './usage.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'pm-usage-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const ID = '8548d3fe-83a8-432d-a3b4-b8a3f41cf99b';
const reply = (id: string, input: number, output: number) =>
  JSON.stringify({
    type: 'assistant',
    message: {
      id,
      usage: {
        input_tokens: input,
        output_tokens: output,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 10,
      },
    },
  }) + '\n';

describe('Claude session usage', () => {
  it('finds the session id in the launch or resume command', () => {
    expect(claudeSessionId(['claude', '--session-id', ID, 'Task'])).toBe(ID);
    expect(claudeSessionId(['claude'], ['claude', '--resume', ID])).toBe(ID);
    expect(claudeSessionId(['claude', '--resume', 'latest'])).toBeNull();
  });

  it('locates the transcript by the cwd slug', () => {
    const cwd = 'S:\\Vibe Coding\\Demo';
    const dir = path.join(home, '.claude', 'projects', 'S--Vibe-Coding-Demo');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${ID}.jsonl`), '');
    expect(transcriptPath(cwd, ID, home)).toBe(path.join(dir, `${ID}.jsonl`));
    expect(transcriptPath(cwd, '00000000-0000-0000-0000-000000000000', home)).toBeNull();
  });

  it('flags a resume whose conversation Claude never saved (relaunch starts fresh)', () => {
    const cwd = 'S:\\Vibe Coding\\Demo';
    // Saved in the previous test: resumable.
    expect(staleClaudeResume(['claude', '--resume', ID], cwd, home)).toBeNull();
    const missing = '11111111-2222-3333-4444-555555555555';
    expect(staleClaudeResume(['claude', '--resume', missing], cwd, home)).toBe(missing);
    // Not a pinned resume: nothing to judge.
    expect(staleClaudeResume(['claude', '--continue'], cwd, home)).toBeNull();
  });

  it('counts each reply once, reads appended lines, and skips bad lines', () => {
    const file = path.join(home, 'transcript.jsonl');
    // One reply streamed over two lines (same message id), one user line, one broken line.
    writeFileSync(
      file,
      reply('m1', 5, 50) +
        reply('m1', 5, 50) +
        JSON.stringify({ type: 'user', message: { content: 'hi' } }) +
        '\n{"usage": broken\n',
    );
    expect(readTranscriptUsage(file)).toEqual({
      input: 5,
      output: 50,
      cacheRead: 100,
      cacheWrite: 10,
      replies: 1,
    });
    appendFileSync(file, reply('m2', 1, 7));
    expect(readTranscriptUsage(file)).toMatchObject({ input: 6, output: 57, replies: 2 });
  });

  it('finds the Codex conversation a session started (main thread, this folder)', () => {
    const day = path.join(home, '.codex', 'sessions', '2026', '10', '06');
    mkdirSync(day, { recursive: true });
    const meta = (id: string, cwd: string, at: string, source?: unknown) =>
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id,
          cwd,
          timestamp: at,
          instructions: 'x'.repeat(8000),
          ...(source ? { source } : {}),
        },
      }) + '\n';
    const cwd = 'S:\\Vibe Coding\\Codex';
    writeFileSync(path.join(day, 'rollout-a.jsonl'), meta('old', cwd, '2026-10-06T01:00:00Z'));
    writeFileSync(
      path.join(day, 'rollout-b.jsonl'),
      meta('guardian', cwd, '2026-10-06T02:00:01Z', { subagent: { other: 'guardian' } }),
    );
    writeFileSync(
      path.join(day, 'rollout-c.jsonl'),
      meta('other-dir', 'S:\\Elsewhere', '2026-10-06T02:00:02Z'),
    );
    writeFileSync(path.join(day, 'rollout-d.jsonl'), meta('mine', cwd, '2026-10-06T02:00:03Z'));
    writeFileSync(path.join(day, 'rollout-e.jsonl'), meta('later', cwd, '2026-10-06T03:00:00Z'));

    const started = '2026-10-06T02:00:00Z';
    expect(codexSessionFor(cwd, started, new Set(), home)).toBe('mine');
    // Another session owns "mine": never take an unrelated conversation an hour later.
    expect(codexSessionFor(cwd, started, new Set(['mine']), home)).toBeNull();
    writeFileSync(
      path.join(day, 'rollout-f.jsonl'),
      meta('ambiguous', cwd, '2026-10-06T02:00:04Z'),
    );
    expect(codexSessionFor(cwd, started, new Set(), home)).toBeNull();
    expect(codexSessionFor('S:\\Nowhere', started, new Set(), home)).toBeNull();
  });
});

describe('explicit Codex resume identity', () => {
  it('respects explicit IDs and refuses latest or picker arguments', () => {
    const id = '019ef8dc-a4c1-7ae2-841a-e0f17c1e9b12';
    expect(codexResumeId(['codex', '--sandbox', 'workspace-write', 'resume', id])).toBe(id);
    expect(codexResumeId(['codex', 'resume', '--last'])).toBeNull();
    expect(codexResumeId(['codex', 'resume'])).toBeNull();
  });
});

describe('Codex rollout usage and file lookup', () => {
  it('reads token metrics from a Codex rollout file', () => {
    const file = path.join(home, 'codex-test-rollout.jsonl');
    const line = JSON.stringify({
      type: 'event',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: {
            input_tokens: 1500,
            output_tokens: 250,
            cached_input_tokens: 300,
            cache_write_input_tokens: 50,
          },
        },
      },
    });
    writeFileSync(file, line + '\n');
    expect(readCodexRolloutUsage(file)).toEqual({
      input: 1500,
      output: 250,
      cacheRead: 300,
      cacheWrite: 50,
      replies: 1,
    });
  });

  it('locates rollout file by resumeId', () => {
    const dir = path.join(home, '.codex', 'sessions', '2026', '10', '10');
    mkdirSync(dir, { recursive: true });
    const targetFile = path.join(dir, 'rollout-resume-xyz.jsonl');
    writeFileSync(targetFile, '{"type":"session_meta"}\n');
    expect(
      findCodexRolloutFile('S:\\Vibe Coding\\Codex', '2026-10-10T12:00:00Z', 'resume-xyz', home),
    ).toBe(targetFile);
  });
});

describe('Grok session usage', () => {
  it('reads usage.json in grok session directory', () => {
    const cwd = 'S:\\Vibe Coding\\Grok';
    const encCwd = encodeURIComponent(cwd);
    const sessionDir = path.join(home, '.grok', 'sessions', encCwd, 'session-123');
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, 'usage.json'),
      JSON.stringify({
        session: {
          inputTokens: 500,
          outputTokens: 80,
          cachedReadTokens: 120,
          cacheCreationTokens: 30,
          turnCount: 4,
        },
      }),
    );
    expect(readGrokUsage(cwd, 'session-123', home)).toEqual({
      input: 500,
      output: 80,
      cacheRead: 120,
      cacheWrite: 30,
      replies: 4,
    });
  });
});

describe('OpenCode session usage', () => {
  it('reads token metrics from OpenCode SQLite database', () => {
    const dbDir = path.join(home, '.local', 'share', 'opencode');
    mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'opencode.db');
    const db = new DatabaseSync(dbPath);
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY,
        directory TEXT,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_cache_read INTEGER,
        tokens_cache_write INTEGER,
        time_updated INTEGER
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY,
        session_id TEXT
      );
    `);
    db.prepare(
      `
      INSERT INTO session (id, directory, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, time_updated)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    ).run('ses-1', 'S:\\Vibe Coding\\OpenCode', 800, 150, 200, 40, Date.now());
    db.prepare(`INSERT INTO message (id, session_id) VALUES (?, ?)`).run('msg-1', 'ses-1');
    db.prepare(`INSERT INTO message (id, session_id) VALUES (?, ?)`).run('msg-2', 'ses-1');
    db.close();

    const usage = readOpenCodeUsage('S:\\Vibe Coding\\OpenCode', 'ses-1', home);
    expect(usage).toEqual({
      input: 800,
      output: 150,
      cacheRead: 200,
      cacheWrite: 40,
      replies: 2,
    });
  });
});

describe('sessionUsage multi-provider', () => {
  it('handles multiple provider rows and returns null for unknown/empty', () => {
    const memDb = new DatabaseSync(':memory:');
    memDb.exec(`
      CREATE TABLE agent_sessions (
        id INTEGER PRIMARY KEY,
        provider_id TEXT,
        command_json TEXT,
        resume_json TEXT,
        cwd TEXT,
        started_at TEXT
      );
    `);
    memDb
      .prepare(
        `
      INSERT INTO agent_sessions (id, provider_id, command_json, resume_json, cwd, started_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `,
      )
      .run(1, 'unknown', JSON.stringify(['other']), null, home, new Date().toISOString());

    const result = sessionUsage(memDb, [1]);
    expect(result[1]).toBeNull();
    memDb.close();
  });
});
