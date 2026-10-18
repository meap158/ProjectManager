import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ChatItem, SessionTranscript } from '../../shared/types.js';
import { antigravityConversationFile, readAntigravity } from './antigravityTranscript.js';
import { toolSummary } from './transcript.js';

const clip = (s: string) => (s.length > 16_000 ? s.slice(0, 16_000) + '\n… more in CLI' : s);
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
const string = (v: unknown) => (typeof v === 'string' ? v : '');
const json = (s: string): Record<string, unknown> => {
  try {
    return object(JSON.parse(s));
  } catch {
    return {};
  }
};

/** Only explicit pinned resume identifiers; never guess the newest conversation. */
export function providerConversation(provider: string, resume: string | null): string | null {
  let args: unknown;
  try {
    args = JSON.parse(resume ?? 'null');
  } catch {
    return null;
  }
  if (!Array.isArray(args)) return null;
  const flag =
    provider === 'opencode'
      ? '--session'
      : provider === 'antigravity'
        ? '--conversation'
        : '--resume';
  const at = args.findIndex((arg) => arg === flag || (provider === 'opencode' && arg === '-s'));
  const id = at >= 0 ? args[at + 1] : undefined;
  if (typeof id !== 'string') return null;
  return (provider === 'opencode' ? /^ses_[A-Za-z0-9_-]+$/ : /^[0-9a-f-]{36}$/i).test(id)
    ? id
    : null;
}

function snapshot(items: ChatItem[], after?: number): SessionTranscript {
  // The provider updates existing parts/chunks in place. A content revision replaces the
  // bounded visible tail instead of appending duplicate streamed text or stale tool states.
  const revision = parseInt(
    createHash('sha256').update(JSON.stringify(items)).digest('hex').slice(0, 12),
    16,
  );
  return {
    supported: true,
    items: after === revision ? [] : items,
    next: revision,
    reset: after !== revision,
  };
}

export function openCodeItems(
  rows: { id: string; data: string; role: string; time_created: number }[],
): ChatItem[] {
  return rows.flatMap((row): ChatItem[] => {
    const p = json(row.data);
    const at = Number.isFinite(row.time_created) ? new Date(row.time_created).toISOString() : null;
    const kind = row.role === 'user' ? 'user' : 'assistant';
    if (p.type === 'text' && typeof p.text === 'string')
      return [{ id: row.id, kind, text: clip(p.text), at }];
    if (p.type === 'reasoning' && typeof p.text === 'string')
      return [{ id: row.id, kind: 'note', text: clip(p.text), at }];
    if (p.type === 'file')
      return [
        {
          id: row.id,
          kind,
          text: `[Attachment: ${string(p.filename) || string(p.mime) || 'file'}]`,
          at,
        },
      ];
    if (p.type !== 'tool') return [];
    const state = object(p.state);
    const toolId = string(p.callID) || row.id;
    const name = string(p.tool) || 'Tool';
    const input = state.input ?? {};
    const items: ChatItem[] = [
      {
        id: row.id,
        kind: 'tool',
        toolId,
        name,
        summary: toolSummary(name, input),
        input: clip(JSON.stringify(input)),
        at,
      },
    ];
    if (state.status === 'completed' || state.status === 'error')
      items.push({
        id: row.id + ':result',
        kind: 'result',
        toolId,
        text: clip(string(state.output) || string(state.error)),
        isError: state.status === 'error',
        at,
      });
    return items;
  });
}

export function grokItems(lines: string[], conversation: string): ChatItem[] {
  const items: ChatItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const record = json(lines[i]!);
    const params = object(record.params);
    if (params.sessionId !== conversation) continue;
    const update = object(params.update);
    const type = string(update.sessionUpdate);
    const id = `grok:${i}`;
    const at = typeof record.timestamp === 'string' ? record.timestamp : null;
    const content = object(update.content);
    if (
      type === 'user_message_chunk' ||
      type === 'agent_message_chunk' ||
      type === 'agent_thought_chunk'
    ) {
      const text = string(content.text) || (content.type === 'image' ? '[Image attachment]' : '');
      if (!text) continue;
      const kind =
        type === 'user_message_chunk'
          ? 'user'
          : type === 'agent_message_chunk'
            ? 'assistant'
            : 'note';
      const prev = items.at(-1);
      if (prev?.kind === kind) prev.text = clip((prev.text ?? '') + text);
      else items.push({ id, kind, text: clip(text), at });
    } else if (type === 'tool_call' || type === 'tool_call_update') {
      const toolId = string(update.toolCallId);
      if (!toolId) continue;
      let tool = items.find((item) => item.kind === 'tool' && item.toolId === toolId);
      if (!tool) {
        tool = {
          id,
          kind: 'tool',
          toolId,
          name: string(update.title) || string(update.kind) || 'Tool',
          at,
        };
        items.push(tool);
      }
      if (typeof update.title === 'string') tool.summary = update.title;
      if (update.rawInput !== undefined) tool.input = clip(JSON.stringify(update.rawInput));
      const output = Array.isArray(update.content)
        ? update.content
            .map((c) => string(object(object(c).content).text))
            .filter(Boolean)
            .join('\n')
        : '';
      if (update.status === 'completed' || update.status === 'failed' || output) {
        const result = items.find((item) => item.kind === 'result' && item.toolId === toolId);
        const next: ChatItem = {
          id: tool.id + ':result',
          kind: 'result',
          toolId,
          text: clip(
            output ||
              (update.rawOutput === undefined
                ? (result?.text ?? '')
                : JSON.stringify(update.rawOutput)),
          ),
          isError: update.status === 'failed',
          at,
        };
        if (result) Object.assign(result, next);
        else items.push(next);
      }
    } else if (type === 'plan' && Array.isArray(update.entries)) {
      const text = update.entries
        .map((entry) => {
          const step = object(entry);
          return `${string(step.status)}: ${string(step.content)}`;
        })
        .join('\n');
      if (text) items.push({ id, kind: 'note', text: clip(text), at });
    } else if (type === 'task_backgrounded') {
      items.push({
        id,
        kind: 'note',
        text: clip(`Background task: ${string(update.description) || string(update.command)}`),
        at,
      });
    } else if (type === 'task_completed') {
      const task = object(update.task_snapshot);
      items.push({
        id,
        kind: 'note',
        text: clip(
          `Background task finished: ${string(task.description) || string(task.command) || string(task.status)}`,
        ),
        at,
      });
    } else if (type === 'auto_compact_started' || type === 'auto_compact_completed') {
      items.push({
        id,
        kind: 'note',
        text:
          type === 'auto_compact_started' ? 'Compacting conversation…' : 'Conversation compacted',
        at,
      });
    } else if (type === 'retry_state' && typeof update.message === 'string')
      items.push({ id, kind: 'note', text: clip(update.message), at });
  }
  return items;
}

const antigravityCache = new Map<string, { sig: string; cwd: string; items: ChatItem[] }>();

/** Size and modification time of each file (missing ones included), to tell whether any changed. */
async function fileSignature(files: string[]): Promise<string> {
  const parts = await Promise.all(
    files.map((file) =>
      stat(file).then(
        (s) => `${s.size}:${s.mtimeMs}`,
        () => '-',
      ),
    ),
  );
  return parts.join('|');
}

export async function readProviderTranscript(
  provider: string,
  resume: string | null,
  cwd: string,
  after?: number,
  home = os.homedir(),
): Promise<SessionTranscript> {
  const id = providerConversation(provider, resume);
  if (!id)
    // Never the newest conversation in the folder: without a pinned one there is none to read.
    return {
      supported: false,
      items: [],
      next: 0,
      reset: false,
      unavailable:
        'This session started before ProjectManager pinned its conversation, so its transcript can’t be found. Use the terminal view, or start a new session for the chat view.',
    };
  if (provider === 'antigravity') {
    const file = antigravityConversationFile(id, home);
    if (!file) return snapshot([], after);
    // A conversation file is tens of MB: decode it again only when it (or its WAL) changed.
    const sig = await fileSignature([file, `${file}-wal`]);
    const cached = antigravityCache.get(file);
    if (cached?.sig === sig && cached.cwd === cwd) return snapshot(cached.items, after);
    const items = readAntigravity(file, cwd) ?? [];
    antigravityCache.set(file, { sig, cwd, items });
    return snapshot(items, after);
  }
  if (provider === 'opencode') {
    const file = path.join(home, '.local', 'share', 'opencode', 'opencode.db');
    if (!existsSync(file)) return snapshot([], after);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const session = db.prepare('SELECT directory FROM session WHERE id = ?').get(id);
      if (
        !session ||
        typeof session.directory !== 'string' ||
        path.resolve(session.directory).toLowerCase() !== path.resolve(cwd).toLowerCase()
      )
        return snapshot([], after);
      const rows = db
        .prepare(
          `SELECT p.id, p.data, p.time_created, json_extract(m.data, '$.role') AS role
        FROM part p JOIN message m ON m.id = p.message_id AND m.session_id = p.session_id
        WHERE p.session_id = ? ORDER BY p.time_created DESC, p.id DESC LIMIT 500`,
        )
        .all(id) as { id: string; data: string; role: string; time_created: number }[];
      return snapshot(openCodeItems(rows.reverse()), after);
    } finally {
      db.close();
    }
  }
  const file = path.join(home, '.grok', 'sessions', encodeURIComponent(cwd), id, 'updates.jsonl');
  if (!existsSync(file)) return snapshot([], after);
  const size = (await stat(file)).size;
  const start = Math.max(0, size - 2 * 1024 * 1024);
  const handle = await open(file, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  if (start) text = text.slice(text.indexOf('\n') + 1);
  return snapshot(grokItems(text.slice(0, text.lastIndexOf('\n') + 1).split('\n'), id), after);
}
