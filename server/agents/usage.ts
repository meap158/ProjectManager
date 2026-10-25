import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AgentTokenUsage } from '../../shared/types.js';

// Token usage for Claude Code sessions, read (never written) from Claude's own transcript:
// ~/.claude/projects/<cwd with non-alphanumerics as '-'>/<session uuid>.jsonl. Each assistant
// reply carries message.usage, repeated on every line of that reply, so replies are counted once
// by message.id. Files are read incrementally from the last offset, so polling stays cheap.
// Other CLIs don't expose per-session usage in a stable place, so they report null.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** An explicit conversation is stronger evidence than timestamp-based discovery. */
export function codexResumeId(argv: readonly string[] | null): string | null {
  const at = argv?.indexOf('resume') ?? -1;
  const id = at >= 0 ? argv?.[at + 1] : null;
  return id && UUID.test(id) ? id : null;
}

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

/**
 * The pinned Claude conversation id in a resume command when Claude has no transcript for it
 * (never saved, or deleted), i.e. when `claude --resume <id>` would fail; null otherwise.
 */
export function staleClaudeResume(
  resume: string[],
  cwd: string,
  home = os.homedir(),
): string | null {
  const id = claudeSessionId(resume);
  return id && !transcriptPath(cwd, id, home) ? id : null;
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

/** Reads the latest cumulative token usage from a Codex session rollout. */
export function readCodexRolloutUsage(file: string): AgentTokenUsage | null {
  try {
    const size = statSync(file).size;
    const len = Math.min(256 * 1024, size);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    const lines = buf.toString('utf8').split('\n');
    let replies = 0;
    let latestUsage: AgentTokenUsage | null = null;
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes('"token_count"')) continue;
      try {
        const event = JSON.parse(line) as {
          payload?: { info?: { total_token_usage?: Record<string, number> } };
        };
        const u = event.payload?.info?.total_token_usage;
        if (u && !latestUsage) {
          latestUsage = {
            input: u.input_tokens ?? 0,
            output: u.output_tokens ?? 0,
            cacheRead: u.cached_input_tokens ?? 0,
            cacheWrite: u.cache_write_input_tokens ?? 0,
            replies: 1,
          };
        }
        replies++;
      } catch {
        /* ignore invalid line */
      }
    }
    if (latestUsage) {
      latestUsage.replies = Math.max(1, replies);
      return latestUsage;
    }
    return null;
  } catch {
    return null;
  }
}

/** Locates the rollout file for a Codex session by its resume id or cwd/startedAt. */
export function findCodexRolloutFile(
  cwd: string,
  startedAt?: string | null,
  resumeId?: string | null,
  home = os.homedir(),
  codexHome?: string,
): string | null {
  const root = path.join(codexHome || path.join(home, '.codex'), 'sessions');
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const folders: string[] = [];
  const baseTime = Number.isFinite(start) ? start : Date.now();
  for (let t = baseTime - 86_400_000; t <= Date.now() + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    const dir = path.join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    if (!folders.includes(dir) && existsSync(dir)) folders.push(dir);
  }
  if (resumeId) {
    for (const dir of folders) {
      try {
        for (const file of readdirSync(dir)) {
          if (file.includes(resumeId) && file.endsWith('.jsonl')) return path.join(dir, file);
        }
      } catch {
        /* unreadable folder */
      }
    }
  }
  const want = path.resolve(cwd).toLowerCase();
  let best: { file: string; at: number } | null = null;
  for (const dir of folders) {
    try {
      for (const file of readdirSync(dir)) {
        if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
        const full = path.join(dir, file);
        try {
          const fd = openSync(full, 'r');
          const buf = Buffer.alloc(256 * 1024);
          const n = readSync(fd, buf, 0, buf.length, 0);
          closeSync(fd);
          const first = buf.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
          const meta = JSON.parse(first) as {
            type?: string;
            payload?: { id?: string; cwd?: string; timestamp?: string; source?: unknown };
          };
          const p = meta.payload;
          if (meta.type !== 'session_meta' || !p?.id || !p.cwd || !p.timestamp) continue;
          if (p.source && typeof p.source === 'object') continue;
          if (path.resolve(p.cwd).toLowerCase() !== want) continue;
          const at = Date.parse(p.timestamp);
          if (Number.isFinite(start) && at < start - 5_000) continue;
          if (!best || at < best.at) best = { file: full, at };
        } catch {
          /* unreadable file */
        }
      }
    } catch {
      /* unreadable folder */
    }
  }
  return best?.file ?? null;
}

/** Grok usage reader from ~/.grok/sessions/<url-encoded-cwd>/<sessionId>/usage.json. */
export function readGrokUsage(
  cwd: string,
  sessionId?: string | null,
  home = os.homedir(),
): AgentTokenUsage | null {
  const encCwd = encodeURIComponent(cwd);
  const root = path.join(home, '.grok', 'sessions', encCwd);
  if (!existsSync(root)) return null;
  let dir = sessionId ? path.join(root, sessionId) : null;
  if (!dir || !existsSync(dir)) {
    try {
      const dirs = readdirSync(root)
        .map((f) => ({ dir: path.join(root, f), mtime: statSync(path.join(root, f)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (dirs.length > 0) dir = dirs[0]!.dir;
    } catch {
      return null;
    }
  }
  if (!dir) return null;
  const usageFile = path.join(dir, 'usage.json');
  if (!existsSync(usageFile)) return null;
  try {
    const data = JSON.parse(readFileSync(usageFile, 'utf8')) as {
      session?: {
        inputTokens?: number;
        outputTokens?: number;
        cachedReadTokens?: number;
        cacheCreationTokens?: number;
        turnCount?: number;
        modelCalls?: number;
      };
    };
    const s = data.session;
    if (!s) return null;
    return {
      input: s.inputTokens ?? 0,
      output: s.outputTokens ?? 0,
      cacheRead: s.cachedReadTokens ?? 0,
      cacheWrite: s.cacheCreationTokens ?? 0,
      replies: s.turnCount || s.modelCalls || 1,
    };
  } catch {
    return null;
  }
}

/** OpenCode usage reader from OpenCode's SQLite database (~/.local/share/opencode/opencode.db). */
export function readOpenCodeUsage(
  cwd: string,
  sessionId?: string | null,
  home = os.homedir(),
): AgentTokenUsage | null {
  const dbPath = process.env.XDG_DATA_HOME
    ? path.join(process.env.XDG_DATA_HOME, 'opencode', 'opencode.db')
    : path.join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    let row:
      | {
          id: string;
          tokens_input: number | null;
          tokens_output: number | null;
          tokens_cache_read: number | null;
          tokens_cache_write: number | null;
          replies: number | null;
        }
      | undefined;
    if (sessionId) {
      row = db
        .prepare(
          `SELECT id, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
                  (SELECT COUNT(*) FROM message WHERE session_id = s.id) AS replies
           FROM session s WHERE id = ?`,
        )
        .get(sessionId) as typeof row;
    }
    if (!row) {
      const want1 = path.resolve(cwd);
      const want2 = cwd.replace(/\\/g, '/');
      row = db
        .prepare(
          `SELECT id, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write,
                  (SELECT COUNT(*) FROM message WHERE session_id = s.id) AS replies
           FROM session s
           WHERE directory = ? OR directory = ? OR directory = ?
           ORDER BY time_updated DESC LIMIT 1`,
        )
        .get(want1, want2, cwd) as typeof row;
    }
    if (!row || (row.tokens_input == null && row.tokens_output == null)) return null;
    return {
      input: row.tokens_input ?? 0,
      output: row.tokens_output ?? 0,
      cacheRead: row.tokens_cache_read ?? 0,
      cacheWrite: row.tokens_cache_write ?? 0,
      replies: row.replies || 1,
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Usage per session id across supported providers (Claude, Codex, Grok, OpenCode). */
export function sessionUsage(
  db: DatabaseSync,
  ids: number[],
): Record<number, AgentTokenUsage | null> {
  const result: Record<number, AgentTokenUsage | null> = {};
  const query = db.prepare(
    'SELECT provider_id, command_json, resume_json, cwd, started_at FROM agent_sessions WHERE id = ?',
  );
  for (const id of ids) {
    const row = query.get(id) as
      | {
          provider_id: string;
          command_json: string;
          resume_json: string | null;
          cwd: string;
          started_at: string;
        }
      | undefined;
    result[id] = null;
    if (!row) continue;
    const parse = (json: string | null) => {
      try {
        return json ? (JSON.parse(json) as unknown) : null;
      } catch {
        return null;
      }
    };
    const rawCommand = parse(row.command_json);
    const command = Array.isArray(rawCommand)
      ? (rawCommand as string[])
      : rawCommand &&
          typeof rawCommand === 'object' &&
          Array.isArray((rawCommand as { command?: unknown }).command)
        ? ((rawCommand as { command: string[] }).command ?? null)
        : null;
    const codexHome =
      rawCommand &&
      typeof rawCommand === 'object' &&
      !Array.isArray(rawCommand) &&
      typeof (rawCommand as { env?: Record<string, unknown> }).env?.CODEX_HOME === 'string'
        ? ((rawCommand as { env: { CODEX_HOME: string } }).env.CODEX_HOME ?? undefined)
        : undefined;
    const rawResume = parse(row.resume_json);
    const resume = Array.isArray(rawResume) ? (rawResume as string[]) : null;
    try {
      if (row.provider_id === 'claude') {
        const sessionId = claudeSessionId(command, resume);
        const file = sessionId ? transcriptPath(row.cwd, sessionId) : null;
        if (file) result[id] = readTranscriptUsage(file);
      } else if (row.provider_id === 'codex') {
        const resumeId =
          resume && resume[0] === 'codex' && resume[1] === 'resume' ? resume[2] : null;
        const file =
          findCodexRolloutFile(row.cwd, row.started_at, resumeId, os.homedir(), codexHome) ??
          (codexHome
            ? findCodexRolloutFile(row.cwd, row.started_at, resumeId, os.homedir())
            : null);
        if (file) result[id] = readCodexRolloutUsage(file);
      } else if (row.provider_id === 'grok') {
        const sessionId = claudeSessionId(command, resume);
        result[id] = readGrokUsage(row.cwd, sessionId);
      } else if (row.provider_id === 'opencode') {
        const sessionId = resume && resume[1] === '--session' ? resume[2] : null;
        result[id] = readOpenCodeUsage(row.cwd, sessionId);
      }
    } catch {
      // Unreadable transcript or log: report unknown rather than failing the request.
    }
  }
  return result;
}

/**
 * The Codex conversation a session started: the main (non-subagent) rollout recorded in
 * ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl for this folder, created soonest after `startedAt`
 * (and not claimed by another session). Its first line is a session_meta record with the id,
 * folder and start time. Null when none matches (then `codex resume --last` is the fallback).
 */
export function codexSessionFor(
  cwd: string,
  startedAt: string,
  claimed: ReadonlySet<string> = new Set(),
  home = os.homedir(),
  codexHome?: string,
): string | null {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const root = path.join(codexHome || path.join(home, '.codex'), 'sessions');
  const folders: string[] = [];
  // Days from the start (UTC and local can differ by one) up to today.
  for (let t = start - 86_400_000; t <= Date.now() + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    const dir = path.join(
      root,
      String(d.getFullYear()),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    );
    if (!folders.includes(dir) && existsSync(dir)) folders.push(dir);
  }
  const want = path.resolve(cwd).toLowerCase();
  let best: { id: string; at: number } | null = null;
  for (const dir of folders) {
    for (const file of readdirSync(dir)) {
      if (!file.startsWith('rollout-') || !file.endsWith('.jsonl')) continue;
      try {
        const fd = openSync(path.join(dir, file), 'r');
        const buf = Buffer.alloc(256 * 1024);
        const n = readSync(fd, buf, 0, buf.length, 0);
        closeSync(fd);
        const first = buf.subarray(0, n).toString('utf8').split('\n')[0] ?? '';
        const meta = JSON.parse(first) as {
          type?: string;
          payload?: { id?: string; cwd?: string; timestamp?: string; source?: unknown };
        };
        const p = meta.payload;
        if (meta.type !== 'session_meta' || !p?.id || !p.cwd || !p.timestamp) continue;
        // Subagent threads (reviewers, guardians) carry an object source; skip them.
        if (p.source && typeof p.source === 'object') continue;
        if (path.resolve(p.cwd).toLowerCase() !== want || claimed.has(p.id)) continue;
        const at = Date.parse(p.timestamp);
        // Only the launch window belongs to this process. Never take an unrelated thread
        // created hours later simply because its real conversation was already claimed.
        if (!(at >= start - 5_000 && at <= start + 120_000)) continue;
        if (best && best.id !== p.id) return null; // Ambiguous siblings: never guess.
        best = { id: p.id, at };
      } catch {
        // Partial or foreign file: skip.
      }
    }
  }
  return best?.id ?? null;
}
