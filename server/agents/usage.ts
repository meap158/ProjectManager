import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { AgentTokenUsage } from '../../shared/types.js';

// Token usage for Claude Code sessions, read (never written) from Claude's own transcript:
// ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<session uuid>.jsonl. Each assistant
// reply carries message.usage, repeated on every line of that reply, so replies are counted once
// by message.id. Files are read incrementally from the last offset, so polling stays cheap.
// Other CLIs don't expose per-session usage in a stable place, so they report null.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CacheEntry {
  offset: number;
  partial: string;
  seen: Map<string, AgentTokenUsage>;
}

const cache = new Map<string, CacheEntry>();

/** The Claude session uuid passed via --session-id / --resume in either stored command. */
export function claudeSessionId(...commands: (string[] | null)[]): string | null {
  for (const argv of commands) {
    if (!argv) continue;
    for (let i = 0; i < argv.length - 1; i++) {
      if ((argv[i] === '--session-id' || argv[i] === '--resume') && UUID.test(argv[i + 1]!)) {
        return argv[i + 1]!;
      }
    }
  }
  return null;
}

export function transcriptPath(cwd: string, sessionId: string, home = os.homedir()): string | null {
  const projects = path.join(home, '.claude', 'projects');
  const direct = path.join(projects, cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${sessionId}.jsonl`);
  if (existsSync(direct)) return direct;
  // Fallback for slug rules we don't know about: look for the uuid in any project folder.
  try {
    for (const dir of readdirSync(projects)) {
      const candidate = path.join(projects, dir, `${sessionId}.jsonl`);
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No ~/.claude/projects: Claude never ran here.
  }
  return null;
}

const empty = (): AgentTokenUsage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  replies: 0,
});

/** Sum of usage across replies in a transcript; reads only what was appended since last time. */
export function readTranscriptUsage(file: string): AgentTokenUsage {
  const size = statSync(file).size;
  let entry = cache.get(file);
  if (!entry || size < entry.offset) {
    entry = { offset: 0, partial: '', seen: new Map() };
    cache.set(file, entry);
  }
  if (size > entry.offset) {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - entry.offset);
      readSync(fd, buffer, 0, buffer.length, entry.offset);
      entry.offset = size;
      const lines = (entry.partial + buffer.toString('utf8')).split('\n');
      entry.partial = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.includes('"usage"')) continue;
        try {
          const record = JSON.parse(line) as {
            type?: string;
            message?: { id?: string; usage?: Record<string, unknown> };
          };
          const usage = record.message?.usage;
          const id = record.message?.id;
          if (record.type !== 'assistant' || !usage || !id) continue;
          const n = (key: string) => (typeof usage[key] === 'number' ? (usage[key] as number) : 0);
          entry.seen.set(id, {
            input: n('input_tokens'),
            output: n('output_tokens'),
            cacheRead: n('cache_read_input_tokens'),
            cacheWrite: n('cache_creation_input_tokens'),
            replies: 1,
          });
        } catch {
          // A malformed line is skipped; the rest of the transcript still counts.
        }
      }
    } finally {
      closeSync(fd);
    }
  }
  const total = empty();
  for (const u of entry.seen.values()) {
    total.input += u.input;
    total.output += u.output;
    total.cacheRead += u.cacheRead;
    total.cacheWrite += u.cacheWrite;
    total.replies += 1;
  }
  return total;
}

/** Usage per session id (null where unknown: not Claude, no session id, or no transcript yet). */
export function sessionUsage(
  db: DatabaseSync,
  ids: number[],
): Record<number, AgentTokenUsage | null> {
  const result: Record<number, AgentTokenUsage | null> = {};
  const query = db.prepare(
    'SELECT provider_id, command_json, resume_json, cwd FROM agent_sessions WHERE id = ?',
  );
  for (const id of ids) {
    const row = query.get(id) as
      | { provider_id: string; command_json: string; resume_json: string | null; cwd: string }
      | undefined;
    result[id] = null;
    if (!row || row.provider_id !== 'claude') continue;
    const parse = (json: string | null) => {
      try {
        return json ? (JSON.parse(json) as string[]) : null;
      } catch {
        return null;
      }
    };
    const sessionId = claudeSessionId(parse(row.command_json), parse(row.resume_json));
    const file = sessionId ? transcriptPath(row.cwd, sessionId) : null;
    if (!file) continue;
    try {
      result[id] = readTranscriptUsage(file);
    } catch {
      // Unreadable transcript: report unknown rather than failing the request.
    }
  }
  return result;
}
