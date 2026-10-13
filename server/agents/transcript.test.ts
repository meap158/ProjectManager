import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  findTranscript,
  parseClaudeLine,
  parseCodexLine,
  readTranscript,
  transcriptSource,
} from './transcript.js';

const home = mkdtempSync(path.join(os.tmpdir(), 'pm-transcript-'));
afterAll(() => rmSync(home, { recursive: true, force: true }));
const ID = '27792941-fe24-4856-8426-158715d514d9';
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

describe('session transcript (chat view)', () => {
  it('finds the conversation a session resumes into', () => {
    expect(transcriptSource('claude', JSON.stringify(['claude', '--resume', ID]))).toEqual({
      providerId: 'claude',
      conversationId: ID,
    });
    expect(transcriptSource('codex', JSON.stringify(['codex', 'resume', ID]))?.conversationId).toBe(
      ID,
    );
    expect(transcriptSource('grok', JSON.stringify(['grok', ID]))).toBeNull();
    expect(transcriptSource('claude', null)).toBeNull();
  });

  it('turns Claude Code records into messages, tool calls and results, skipping noise', () => {
    expect(
      parseClaudeLine(
        line({ type: 'user', uuid: 'u1', timestamp: 't', message: { content: 'fix the bug' } }),
      ),
    ).toEqual([{ id: 'u1', kind: 'user', text: 'fix the bug', at: 't' }]);
    const tool = parseClaudeLine(
      line({
        type: 'assistant',
        uuid: 'a1',
        message: {
          content: [
            { type: 'thinking', thinking: '' },
            { type: 'text', text: 'Checking.' },
            { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'git status\n--x' } },
          ],
        },
      }),
    );
    expect(tool.map((i) => [i.kind, i.text ?? i.summary])).toEqual([
      ['assistant', 'Checking.'],
      ['tool', 'git status'],
    ]);
    expect(tool[1]).toMatchObject({ toolId: 'tu1', name: 'Bash' });
    const result = parseClaudeLine(
      line({
        type: 'user',
        uuid: 'r1',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu1',
              content: [{ type: 'text', text: 'M a.ts' }],
            },
          ],
        },
      }),
    );
    expect(result).toMatchObject([
      { kind: 'result', toolId: 'tu1', text: 'M a.ts', isError: false },
    ]);
    // Reminders, side chains and other record types are not chat.
    expect(
      parseClaudeLine(
        line({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } }),
      ),
    ).toEqual([]);
    expect(
      parseClaudeLine(line({ type: 'user', isSidechain: true, message: { content: 'x' } })),
    ).toEqual([]);
    expect(parseClaudeLine(line({ type: 'mode', mode: 'normal' }))).toEqual([]);
    expect(parseClaudeLine('not json')).toEqual([]);
  });

  it('turns Codex records into messages, tool calls and results', () => {
    const at = '2026-10-13T00:00:00Z';
    expect(
      parseCodexLine(
        line({
          type: 'response_item',
          timestamp: at,
          payload: {
            type: 'message',
            id: 'm1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Done.' }],
          },
        }),
      ),
    ).toEqual([{ id: 'm1', kind: 'assistant', text: 'Done.', at }]);
    expect(
      parseCodexLine(
        line({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: '<environment_context>…' }],
          },
        }),
      ),
    ).toEqual([]);
    expect(
      parseCodexLine(
        line({
          type: 'response_item',
          payload: {
            type: 'function_call',
            call_id: 'c1',
            name: 'shell',
            arguments: '{"command":["npm","test"]}',
          },
        }),
      )[0],
    ).toMatchObject({ kind: 'tool', toolId: 'c1', name: 'shell', summary: 'npm test' });
    expect(
      parseCodexLine(
        line({
          type: 'response_item',
          payload: {
            type: 'custom_tool_call_output',
            call_id: 'c1',
            output: [{ type: 'input_text', text: 'ok' }],
          },
        }),
      )[0],
    ).toMatchObject({ kind: 'result', toolId: 'c1', text: 'ok' });
    expect(parseCodexLine(line({ type: 'event_msg', payload: { type: 'token_count' } }))).toEqual(
      [],
    );
  });

  it('finds the file, reads only whole lines, then only what was appended', async () => {
    const dir = path.join(home, '.claude', 'projects', 'S--proj');
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${ID}.jsonl`);
    writeFileSync(file, line({ type: 'user', uuid: 'u1', message: { content: 'one' } }));
    expect(await findTranscript({ providerId: 'claude', conversationId: ID }, home)).toBe(file);
    const first = await readTranscript(file, 'claude');
    expect(first.items.map((i) => i.text)).toEqual(['one']);
    // A line still being written waits for its newline.
    appendFileSync(file, '{"type":"user","uuid":"u2","message":{"content":"tw');
    expect((await readTranscript(file, 'claude', first.next)).items).toEqual([]);
    appendFileSync(file, 'o"}}\n');
    const second = await readTranscript(file, 'claude', first.next);
    expect(second.items.map((i) => i.text)).toEqual(['two']);
    // Rewritten shorter than our offset (compacted): start over.
    writeFileSync(file, line({ type: 'user', uuid: 'u3', message: { content: 'fresh' } }));
    const reset = await readTranscript(file, 'claude', second.next);
    expect(reset.reset).toBe(true);
    expect(reset.items.map((i) => i.text)).toEqual(['fresh']);
  });
});

describe('messages sent while Claude works (PM-118)', () => {
  it('shows a queued message as yours; messages from other sessions are not', () => {
    const queued = (prompt: string) =>
      parseClaudeLine(
        `${JSON.stringify({ type: 'attachment', uuid: 'q1', timestamp: 't', attachment: { type: 'queued_command', prompt } })}\n`,
      );
    expect(queued('also fix the header')).toEqual([
      { id: 'q1', kind: 'user', text: 'also fix the header', at: 't' },
    ]);
    expect(queued('<cross-session-message from="x">relayed</cross-session-message>')).toEqual([]);
  });
});

describe('conversation markers (PM-123)', () => {
  it('turns an interruption and a compaction into notes, not your messages', () => {
    const user = (o: object) =>
      parseClaudeLine(`${JSON.stringify({ type: 'user', uuid: 'm', ...o })}\n`);
    expect(
      user({ message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
    ).toEqual([{ id: 'm', kind: 'note', text: 'Interrupted', at: null }]);
    expect(
      user({ isCompactSummary: true, message: { content: 'Summary: we fixed tables.' } }),
    ).toEqual([
      {
        id: 'm',
        kind: 'note',
        text: 'Conversation compacted',
        input: 'Summary: we fixed tables.',
        at: null,
      },
    ]);
  });
});
