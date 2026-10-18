// Chat view of an agent session (mobile): the CLI's own structured transcript, read
// incrementally, normalised into chat items. Claude Code writes every conversation to
// ~/.claude/projects/<folder>/<conversation id>.jsonl and Codex to
// ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl; ProjectManager knows each session's
// exact conversation id (its resume target), so the right file is found without guessing.
// Transcripts can be hundreds of MB (Codex): only the tail is read at first, then new bytes.

import { open, readFile, readdir, stat } from 'node:fs/promises';
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
  codexHome?: string;
}

/** The conversation a session resumes into ("claude --resume <id>", "codex resume <id>"). */
export function transcriptSource(
  providerId: string,
  resumeJson: string | null,
  codexHome?: string,
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
  return id ? { providerId, conversationId: id, ...(codexHome ? { codexHome } : {}) } : null;
}

const found = new Map<string, string>();
const missed = new Map<string, number>();
const MISS_TTL_MS = 3_000;

/** Where the transcript lives, or null when the CLI hasn't written one yet. Cached once found. */
export async function findTranscript(
  source: TranscriptSource,
  home = os.homedir(),
): Promise<string | null> {
  const key = `${source.providerId}:${source.conversationId}:${source.codexHome ?? ''}`;
  const cached = found.get(key);
  if (cached) return cached;
  // The chat view polls every 1.5 s until the CLI writes its transcript: don't walk the session
  // folders (days of rollouts) on every one of those polls.
  const missKey = `${home}|${key}`;
  const missedAt = missed.get(missKey);
  if (missedAt !== undefined && Date.now() - missedAt < MISS_TTL_MS) return null;
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
    const roots = [
      ...(source.codexHome ? [path.join(source.codexHome, 'sessions')] : []),
      path.join(home, '.codex', 'sessions'),
    ];
    const sorted = async (dir: string) =>
      (await readdir(dir).catch(() => [] as string[])).sort().reverse();
    search: for (const root of roots)
      for (const y of await sorted(root))
        for (const m of await sorted(path.join(root, y)))
          for (const d of await sorted(path.join(root, y, m)))
            for (const f of await readdir(path.join(root, y, m, d)).catch(() => [] as string[]))
              if (f.endsWith(`${source.conversationId}.jsonl`)) {
                file = path.join(root, y, m, d, f);
                break search;
              }
  }
  if (file) {
    found.set(key, file);
    missed.delete(missKey);
  } else {
    if (missed.size > 500) missed.clear();
    missed.set(missKey, Date.now());
  }
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
  /^\s*<(environment_context|system-reminder|command-|local-command|user_instructions|permissions|skills_instructions|task-notification|cross-session-message)/.test(
    text,
  );

/** One Claude Code transcript line → chat items. `sidechain` reads a subagent's own file. */
export function parseClaudeLine(line: string, sidechain = false): ChatItem[] {
  let o: {
    type?: string;
    uuid?: string;
    timestamp?: string;
    isSidechain?: boolean;
    isMeta?: boolean;
    isCompactSummary?: boolean;
    message?: { role?: string; content?: unknown };
    attachment?: { type?: string; prompt?: unknown };
  };
  try {
    o = JSON.parse(line);
  } catch {
    return [];
  }
  // A message you sent while Claude was working: recorded as a queued command when it reached
  // Claude mid-task, not as a user message (PM-118). Without this it never showed as yours.
  if (
    o.type === 'attachment' &&
    o.attachment?.type === 'queued_command' &&
    !o.isSidechain &&
    !sidechain
  ) {
    const text = textOf(o.attachment.prompt);
    return isNoise(text)
      ? []
      : [{ id: o.uuid ?? `queued-${o.timestamp}`, kind: 'user', text, at: o.timestamp ?? null }];
  }
  if ((o.type !== 'user' && o.type !== 'assistant') || (o.isSidechain && !sidechain) || o.isMeta)
    return [];
  const at = o.timestamp ?? null;
  const base = o.uuid ?? `${o.type}-${at}`;
  const content = o.message?.content;
  // Markers, not messages (PM-123): the summary Claude writes when it compacts the conversation
  // (kept, one tap away), and the "[Request interrupted by user]" note after an Esc.
  if (o.type === 'user' && o.isCompactSummary)
    return [
      { id: base, kind: 'note', text: 'Conversation compacted', input: clip(textOf(content)), at },
    ];
  const marker = /^\s*\[Request interrupted by user[^\]]*\]\s*$/.exec(textOf(content));
  if (o.type === 'user' && marker) return [{ id: base, kind: 'note', text: 'Interrupted', at }];
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
  if (typeof input === 'string') {
    // Codex's apply_patch: the files it changes, not its "*** Begin Patch" header.
    const files = [...input.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) =>
      m[1]!.trim(),
    );
    return files.length ? files.join(', ') : firstLine(input);
  }
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
  const parse =
    providerId === 'codex'
      ? parseCodexLine
      : (line: string) => parseClaudeLine(line, providerId === 'claude-subagent');
  const items = text
    .slice(start, end)
    .split('\n')
    .flatMap((line) => (line ? parse(line) : []));
  return { items, next: from + Buffer.byteLength(text.slice(0, end), 'utf8'), reset };
}

const TOOL_ID = /^[A-Za-z0-9_-]{1,100}$/;

/**
 * What a Claude subagent did (PM-123): the steps and messages of the agent a tool call
 * started, read from the subagent transcript Claude Code keeps beside the conversation
 * (<conversation>/subagents/agent-*.jsonl, matched by its .meta.json toolUseId). Null when
 * there is none (other CLIs, or an older Claude Code that kept no subagent files).
 */
export async function readSubagent(file: string, toolUseId: string): Promise<ChatItem[] | null> {
  if (!TOOL_ID.test(toolUseId) || !file.endsWith('.jsonl')) return null;
  const dir = path.join(file.slice(0, -'.jsonl'.length), 'subagents');
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (!name.endsWith('.meta.json')) continue;
    const meta = await readFile(path.join(dir, name), 'utf8').catch(() => '');
    let id: unknown;
    try {
      id = (JSON.parse(meta) as { toolUseId?: unknown }).toolUseId;
    } catch {
      continue;
    }
    if (id !== toolUseId) continue;
    const jsonl = path.join(dir, name.replace(/\.meta\.json$/, '.jsonl'));
    const { items } = await readTranscript(jsonl, 'claude-subagent').catch(() => ({ items: [] }));
    return items;
  }
  return null;
}
