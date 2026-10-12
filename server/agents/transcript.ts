// Chat view of an agent session (mobile): the CLI's own structured transcript, read
// incrementally, normalised into chat items. Claude Code writes every conversation to
// ~/.claude/projects/<folder>/<conversation id>.jsonl and Codex to
// ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl; ProjectManager knows each session's
// exact conversation id (its resume target), so the right file is found without guessing.
// Transcripts can be hundreds of MB (Codex): only the tail is read at first, then new bytes.

import { open, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ChatItem, SessionTranscript } from '../../shared/types.js';

/** First read: the last 2 MB (hundreds of messages); later reads: what was appended. */
const INITIAL_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 4 * 1024 * 1024;
/** Tool inputs and outputs are kept whole up to this size, then cut with a note. */
const MAX_DETAIL = 16_000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TranscriptSource {
  providerId: string;
  conversationId: string;
}

/** The conversation a session resumes into ("claude --resume <id>", "codex resume <id>"). */
export function transcriptSource(
  providerId: string,
  resumeJson: string | null,
): TranscriptSource | null {
  if (!resumeJson || (providerId !== 'claude' && providerId !== 'codex')) return null;
  let argv: unknown;
  try {
    argv = JSON.parse(resumeJson);
  } catch {
    return null;
  }
  if (!Array.isArray(argv)) return null;
  const id = argv.find((a): a is string => typeof a === 'string' && ID.test(a));
  return id ? { providerId, conversationId: id } : null;
}

const found = new Map<string, string>();

/** Where the transcript lives, or null when the CLI hasn't written one yet. Cached once found. */
export async function findTranscript(
  source: TranscriptSource,
  home = os.homedir(),
): Promise<string | null> {
  const key = `${source.providerId}:${source.conversationId}`;
  const cached = found.get(key);
  if (cached) return cached;
  let file: string | null = null;
  if (source.providerId === 'claude') {
    const root = path.join(home, '.claude', 'projects');
    for (const dir of await readdir(root).catch(() => [] as string[])) {
      const candidate = path.join(root, dir, `${source.conversationId}.jsonl`);
      if (
        await stat(candidate).then(
          (s) => s.isFile(),
          () => false,
        )
      ) {
        file = candidate;
        break;
      }
    }
  } else {
    // Newest days first: a live session's rollout is almost always in the last few.
    const root = path.join(home, '.codex', 'sessions');
    const sorted = async (dir: string) =>
      (await readdir(dir).catch(() => [] as string[])).sort().reverse();
    search: for (const y of await sorted(root))
      for (const m of await sorted(path.join(root, y)))
        for (const d of await sorted(path.join(root, y, m)))
          for (const f of await readdir(path.join(root, y, m, d)).catch(() => [] as string[]))
            if (f.endsWith(`${source.conversationId}.jsonl`)) {
              file = path.join(root, y, m, d, f);
              break search;
            }
  }
  if (file) found.set(key, file);
  return file;
}

const clip = (text: string) =>
  text.length > MAX_DETAIL
    ? `${text.slice(0, MAX_DETAIL)}\n… ${(text.length - MAX_DETAIL).toLocaleString()} more characters`
    : text;

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) =>
      typeof part === 'string'
        ? part
        : part && typeof part === 'object' && 'text' in part && typeof part.text === 'string'
          ? part.text
          : '',
    )
    .filter(Boolean)
    .join('\n');
};

/** Housekeeping the CLIs put in user turns (context, reminders, command echoes): not chat. */
const isNoise = (text: string) =>
  !text.trim() ||
  /^\s*<(environment_context|system-reminder|command-|local-command|user_instructions|permissions|skills_instructions|task-notification)/.test(
    text,
  );

/** One Claude Code transcript line → chat items. */
export function parseClaudeLine(line: string): ChatItem[] {
  let o: {
    type?: string;
    uuid?: string;
    timestamp?: string;
    isSidechain?: boolean;
    isMeta?: boolean;
    message?: { role?: string; content?: unknown };
  };
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) return [];
  const at = o.timestamp ?? null;
  const base = o.uuid ?? `${o.type}-${at}`;
  const content = o.message?.content;
  if (typeof content === 'string') {
    return o.type === 'user' && !isNoise(content)
      ? [{ id: base, kind: 'user', text: content, at }]
      : [];
  }
  if (!Array.isArray(content)) return [];
  const items: ChatItem[] = [];
  content.forEach((part: Record<string, unknown>, i: number) => {
    const id = `${base}:${i}`;
    if (part.type === 'text' && typeof part.text === 'string') {
      if (o.type === 'assistant') items.push({ id, kind: 'assistant', text: part.text, at });
      else if (!isNoise(part.text)) items.push({ id, kind: 'user', text: part.text, at });
    } else if (part.type === 'tool_use') {
      items.push({
        id,
        kind: 'tool',
        toolId: String(part.id ?? id),
        name: String(part.name ?? 'tool'),
        input: clip(JSON.stringify(part.input ?? {}, null, 2)),
        summary: toolSummary(String(part.name ?? ''), part.input),
        at,
      });
    } else if (part.type === 'tool_result') {
      items.push({
        id,
        kind: 'result',
        toolId: String(part.tool_use_id ?? ''),
        text: clip(textOf(part.content)),
        isError: part.is_error === true,
        at,
      });
    } else if (part.type === 'image') {
      items.push({ id, kind: o.type === 'user' ? 'user' : 'assistant', text: '[image]', at });
    }
  });
  return items;
}

/** One Codex rollout line → chat items. */
export function parseCodexLine(line: string): ChatItem[] {
  let o: { type?: string; timestamp?: string; payload?: Record<string, unknown> };
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  const p = o.payload;
  if (o.type !== 'response_item' || !p) return [];
  const at = o.timestamp ?? null;
  const id = String(p.id ?? p.call_id ?? `${p.type}-${at}`);
  if (p.type === 'message' && (p.role === 'user' || p.role === 'assistant')) {
    const text = textOf(p.content);
    if (p.role === 'user' && isNoise(text)) return [];
    return text.trim() ? [{ id, kind: p.role, text, at }] : [];
  }
  if (p.type === 'function_call' || p.type === 'custom_tool_call') {
    const raw = p.type === 'function_call' ? String(p.arguments ?? '') : String(p.input ?? '');
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Custom tools take free text (e.g. a script).
    }
    return [
      {
        id,
        kind: 'tool',
        toolId: String(p.call_id ?? id),
        name: String(p.name ?? 'tool'),
        input: clip(typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)),
        summary: toolSummary(String(p.name ?? ''), parsed),
        at,
      },
    ];
  }
  if (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') {
    const output = typeof p.output === 'string' ? p.output : textOf(p.output);
    return [{ id, kind: 'result', toolId: String(p.call_id ?? ''), text: clip(output), at }];
  }
  return [];
}

/** One line saying what a tool call does: the command, the file, the pattern… */
export function toolSummary(name: string, input: unknown): string {
  if (typeof input === 'string') return firstLine(input);
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  for (const key of [
    'command',
    'cmd',
    'file_path',
    'path',
    'pattern',
    'url',
    'query',
    'description',
    'prompt',
    'code',
  ])
    if (typeof i[key] === 'string' && i[key]) return firstLine(i[key] as string);
    else if (Array.isArray(i[key])) return firstLine((i[key] as unknown[]).join(' '));
  const first = Object.values(i).find((v) => typeof v === 'string');
  return typeof first === 'string' ? firstLine(first) : name;
}
const firstLine = (s: string) => {
  const line = s.trim().split('\n')[0] ?? '';
  return line.length > 140 ? `${line.slice(0, 140)}…` : line;
};

/**
 * Items from `after` (a byte offset from an earlier read) to the end, or the tail on a first
 * read. `next` is where the following read starts: the end of the last complete line.
 */
export async function readTranscript(
  file: string,
  providerId: string,
  after?: number,
): Promise<Omit<SessionTranscript, 'supported'>> {
  const size = (await stat(file)).size;
  const reset = after !== undefined && after > size; // Rewritten (e.g. compacted): start over.
  const from = after === undefined || reset ? Math.max(0, size - INITIAL_BYTES) : after;
  const length = Math.min(size - from, MAX_READ_BYTES);
  if (length <= 0) return { items: [], next: from, reset };
  const handle = await open(file, 'r');
  let text: string;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, from);
    text = buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
  // Only whole lines: a starting partial line (tail read) and an unfinished last line wait.
  let start = 0;
  if (from > 0 && (after === undefined || reset)) start = text.indexOf('\n') + 1;
  const end = text.lastIndexOf('\n') + 1;
  if (end <= start) return { items: [], next: from, reset };
  const parse = providerId === 'codex' ? parseCodexLine : parseClaudeLine;
  const items = text
    .slice(start, end)
    .split('\n')
    .flatMap((line) => (line ? parse(line) : []));
  return { items, next: from + Buffer.byteLength(text.slice(0, end), 'utf8'), reset };
}
