import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  claudeSessionId,
  codexSessionFor,
  readTranscriptUsage,
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
        payload: { id, cwd, timestamp: at, ...(source ? { source } : {}) },
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
    // Another session already resumes "mine": take the next one.
    expect(codexSessionFor(cwd, started, new Set(['mine']), home)).toBe('later');
    expect(codexSessionFor('S:\\Nowhere', started, new Set(), home)).toBeNull();
  });
});
