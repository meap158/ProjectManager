import { execFile } from 'node:child_process';
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
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { resolveArgv } from './resolve.js';
import { transcriptPath } from './usage.js';

// Which conversation a session is in, and what the CLI calls it, read from each CLI's own
// storage (read-only). Used to resume exactly that conversation and to keep names in sync.
//   Claude       hook-reported id (boardMcp.ts); /rename -> "custom-title" lines in its transcript
//   Codex        rollout under ~/.codex/sessions (usage.ts); /rename -> ~/.codex/session_index.jsonl
//   Grok         id pinned at launch (--session-id); stored under ~/.grok/sessions/<cwd>/<id>
//   OpenCode     `opencode session list --format json` (id, directory, created, updated)
//   Antigravity  ~/.gemini/antigravity-cli/history.jsonl (workspace, conversationId, timestamp)

const run = promisify(execFile);
/** A conversation may be created a moment before the session row's timestamp. */
const SKEW_MS = 5_000;
const same = (a: string, b: string) =>
  path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

/** Last `max` bytes of a file as text (whole lines only), or '' when unreadable. */
function tail(file: string, max: number): string {
  try {
    const size = statSync(file).size;
    const len = Math.min(max, size);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try {
      readSync(fd, buf, 0, len, size - len);
    } finally {
      closeSync(fd);
    }
    const text = buf.toString('utf8');
    return len < size ? text.slice(text.indexOf('\n') + 1) : text;
  } catch {
    return '';
  }
}

/** Parsed JSON lines, newest first; malformed lines skipped. */
function linesNewestFirst<T>(text: string): T[] {
  const out: T[] = [];
  for (const line of text.split('\n').reverse()) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // Partial line.
    }
  }
  return out;
}

/** Grok keeps each conversation in ~/.grok/sessions/<url-encoded cwd>/<id>/ once it's saved. */
export function grokSessionExists(cwd: string, id: string, home = os.homedir()): boolean {
  return existsSync(path.join(home, '.grok', 'sessions', encodeURIComponent(cwd), id));
}

interface OpenCodeSession {
  id: string;
  directory: string;
  created: number;
  updated: number;
}

/** Picks this session's OpenCode conversation: in its folder, begun since it started, the most
 *  recently used, and not another session's. Pure: the list comes from `opencode session list`. */
export function pickOpenCodeSession(
  list: OpenCodeSession[],
  cwd: string,
  startedAt: string,
  claimed: ReadonlySet<string> = new Set(),
): string | null {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const mine = list
    .filter((s) => s.id && s.directory && same(s.directory, cwd) && !claimed.has(s.id))
    .filter((s) => s.created >= start - SKEW_MS)
    .sort((a, b) => b.updated - a.updated);
  return mine[0]?.id ?? null;
}

export async function openCodeSessionFor(
  cwd: string,
  startedAt: string,
  claimed: ReadonlySet<string> = new Set(),
): Promise<string | null> {
  try {
    // npm installs are .cmd shims on Windows: resolve to the real program (no shell).
    const [file, ...args] = await resolveArgv(['opencode', 'session', 'list', '--format', 'json']);
    const { stdout } = await run(file!, args, { cwd, timeout: 20_000, windowsHide: true });
    return pickOpenCodeSession(JSON.parse(stdout) as OpenCodeSession[], cwd, startedAt, claimed);
  } catch {
    return null; // Not installed, or no sessions yet.
  }
}

interface AgyHistoryLine {
  workspace?: string;
  conversationId?: string;
  timestamp?: number;
}

/** Does an Antigravity conversation database belong to this folder? Its metadata blob holds the
 *  workspace as a file:// URI. */
function agyConversationIn(file: string, cwd: string): boolean {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(file, { readOnly: true });
    const row = db.prepare(`SELECT data FROM trajectory_metadata_blob WHERE id = 'main'`).get() as
      { data?: Uint8Array } | undefined;
    if (!row?.data) return false;
    const blob = Buffer.from(row.data).toString('latin1').toLowerCase();
    return blob.includes(pathToFileURL(cwd).href.toLowerCase());
  } catch {
    return false; // Locked mid-write, or another format.
  } finally {
    db?.close();
  }
}

/**
 * This session's Antigravity conversation, not another session's: among conversations begun in its
 * folder since it started, the most recently used. Antigravity keeps one database per conversation
 * (its prompt history misses a conversation's opening prompt, so that is only a fallback).
 */
export function antigravityConversationFor(
  cwd: string,
  startedAt: string,
  claimed: ReadonlySet<string> = new Set(),
  home = os.homedir(),
): string | null {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return null;
  const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
  try {
    const mine = readdirSync(dir)
      .filter((f) => f.endsWith('.db') && !claimed.has(f.slice(0, -3)))
      .map((f) => ({
        id: f.slice(0, -3),
        file: path.join(dir, f),
        stat: statSync(path.join(dir, f)),
      }))
      .filter((c) => c.stat.birthtimeMs >= start - SKEW_MS)
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
    const found = mine.find((c) => agyConversationIn(c.file, cwd));
    if (found) return found.id;
  } catch {
    // No conversations folder yet.
  }
  const file = path.join(home, '.gemini', 'antigravity-cli', 'history.jsonl');
  for (const line of linesNewestFirst<AgyHistoryLine>(tail(file, 2_000_000))) {
    if (!line.conversationId || !line.workspace || typeof line.timestamp !== 'number') continue;
    if (line.timestamp < start - SKEW_MS) break; // Older than the session: nothing further.
    if (same(line.workspace, cwd) && !claimed.has(line.conversationId)) return line.conversationId;
  }
  return null;
}

/** The name you gave a Claude conversation with /rename (or --name); auto titles don't count. */
export function claudeCustomTitle(cwd: string, id: string, home = os.homedir()): string | null {
  const file = transcriptPath(cwd, id, home);
  if (!file) return null;
  // Claude repeats the title line as the transcript grows, so the tail nearly always has it.
  for (const line of linesNewestFirst<{ type?: string; customTitle?: string }>(
    tail(file, 512_000),
  )) {
    if (line.type === 'custom-title' && line.customTitle?.trim()) return line.customTitle.trim();
  }
  return null;
}

/** The name you gave a Codex thread with /rename (Codex records no automatic names for them). */
export function codexThreadName(id: string, home = os.homedir()): string | null {
  const file = path.join(home, '.codex', 'session_index.jsonl');
  for (const line of linesNewestFirst<{ id?: string; thread_name?: string }>(
    tail(file, 1_000_000),
  )) {
    if (line.id === id) return line.thread_name?.trim() || null;
  }
  return null;
}

/** The title you gave a Grok session with /rename (`title_is_manual`); auto titles don't count. */
export function grokManualTitle(cwd: string, id: string, home = os.homedir()): string | null {
  const file = path.join(home, '.grok', 'sessions', encodeURIComponent(cwd), id, 'summary.json');
  try {
    const summary = JSON.parse(readFileSync(file, 'utf8')) as {
      title_is_manual?: boolean;
      generated_title?: string;
      title?: string;
    };
    if (!summary.title_is_manual) return null;
    return (summary.title ?? summary.generated_title)?.trim() || null;
  } catch {
    return null;
  }
}
