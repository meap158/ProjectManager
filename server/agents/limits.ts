import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ProviderLimits, UsageWindow } from '../../shared/limits.js';

// Plan usage limits (PM-17), read (never written) from what each CLI already records locally, so
// checking costs no tokens and never touches credentials:
//  - Codex logs `rate_limits` on every token_count event in its session rollouts
//    ($CODEX_HOME or ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl): primary is the 5-hour
//    window, secondary the weekly one, each with used_percent and resets_at (unix seconds).
//  - Claude Code reports plan usage only to its status line command; the sessions ProjectManager
//    launches run scripts/claude-statusline.mjs, which saves that block to
//    <dataDir>/claude-limits.json before running the user's own status line.
// The numbers are as of the CLI's last reply; they don't move while the CLI is idle, so the UI
// shows when they were reported. Rollouts can total hundreds of MB, so only the newest day
// folders are listed and only the tail of the newest file is read.

/** Tail sizes tried in turn: big tool outputs can push the last report far from the end. */
const TAIL_BYTES = [256 * 1024, 4 * 1024 * 1024];
const DAY_DIRS = 3; // Newest day folders to look in (a session can span midnight).
const FILES = 4; // Newest rollouts to try when the latest has no rate limit event yet.

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number | null;
}

/** "5-hour", "Weekly", else a plain duration label. */
export function windowLabel(minutes: number): string {
  if (minutes === 300) return '5-hour';
  if (minutes === 10_080) return 'Weekly';
  return minutes % 1440 === 0 ? `${minutes / 1440}-day` : `${Math.round(minutes / 60)}-hour`;
}

function toWindow(w: CodexWindow | null | undefined): UsageWindow | null {
  if (!w || typeof w.used_percent !== 'number' || typeof w.window_minutes !== 'number') return null;
  return {
    label: windowLabel(w.window_minutes),
    windowMinutes: w.window_minutes,
    usedPercent: Math.min(100, Math.max(0, w.used_percent)),
    resetsAt: typeof w.resets_at === 'number' ? new Date(w.resets_at * 1000).toISOString() : null,
  };
}

/** Sorted subfolder names, newest (largest) first; [] when missing. */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
      .map((d) => d.name)
      .sort((a, b) => Number(b) - Number(a));
  } catch {
    return [];
  }
}

/** Rollout files from the newest day folders, newest modified first. */
function newestRollouts(sessions: string): string[] {
  const days: string[] = [];
  for (const year of subdirs(sessions)) {
    for (const month of subdirs(path.join(sessions, year))) {
      for (const day of subdirs(path.join(sessions, year, month))) {
        days.push(path.join(sessions, year, month, day));
        if (days.length >= DAY_DIRS) break;
      }
      if (days.length >= DAY_DIRS) break;
    }
    if (days.length >= DAY_DIRS) break;
  }
  const files: { file: string; mtime: number }[] = [];
  for (const dir of days) {
    try {
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.jsonl')) continue;
        const file = path.join(dir, name);
        files.push({ file, mtime: statSync(file).mtimeMs });
      }
    } catch {
      // A folder removed while listing: skip it.
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime).map((f) => f.file);
}

function tail(file: string, bytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    closeSync(fd);
  }
}

/** The last rate limit report in one rollout's tail, or null. */
export function lastCodexLimits(text: string): ProviderLimits | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (!line.includes('"rate_limits"')) continue;
    try {
      const event = JSON.parse(line) as {
        timestamp?: string;
        payload?: { rate_limits?: { primary?: CodexWindow; secondary?: CodexWindow } | null };
      };
      const limits = event.payload?.rate_limits;
      const windows = [toWindow(limits?.primary), toWindow(limits?.secondary)].filter(
        (w): w is UsageWindow => w !== null,
      );
      if (
        windows.length === 0 ||
        typeof event.timestamp !== 'string' ||
        !Number.isFinite(Date.parse(event.timestamp))
      )
        continue;
      return {
        providerId: 'codex',
        windows: windows.sort((a, b) => a.windowMinutes - b.windowMinutes),
        asOf: new Date(event.timestamp).toISOString(),
        source: 'Codex session log (~/.codex/sessions)',
      };
    } catch {
      // The first line of a tail is usually cut mid-way: not JSON, keep looking.
    }
  }
  return null;
}

/** The last report in one rollout, reading further back only when the end has none. */
function fileLimits(file: string): ProviderLimits | null {
  for (const bytes of TAIL_BYTES) {
    const text = tail(file, bytes);
    const found = lastCodexLimits(text);
    if (found || text.length < bytes) return found; // Found, or the whole file was read.
  }
  return null;
}

/**
 * Codex's latest reported limits, or null when Codex hasn't reported any. Limits are per
 * account, so parallel sessions report the same windows: the most recent report wins.
 */
export function codexLimits(
  home = os.homedir(),
  codexHome = process.env.CODEX_HOME,
  now = Date.now(),
): ProviderLimits | null {
  const sessions = path.join(codexHome || path.join(home, '.codex'), 'sessions');
  let latest: ProviderLimits | null = null;
  for (const file of newestRollouts(sessions).slice(0, FILES)) {
    try {
      const found = fileLimits(file);
      if (found && (!latest || found.asOf > latest.asOf)) latest = found;
    } catch {
      // Unreadable (locked, removed): try the next newest.
    }
  }
  return latest && rollOver(latest, now);
}

/** A window whose reset time has passed since the report starts again from zero. */
export function rollOver(limits: ProviderLimits, now: number): ProviderLimits {
  return {
    ...limits,
    windows: limits.windows.map((w) =>
      w.resetsAt && Date.parse(w.resetsAt) <= now
        ? { ...w, usedPercent: 0, resetsAt: null, resetSinceReport: true }
        : w,
    ),
  };
}

interface ClaudeWindow {
  used_percentage?: number;
  used_percent?: number;
  resets_at?: number | string | null;
}

/** A reset time as ISO: unix seconds (documented), milliseconds or an ISO string. */
function resetTime(value: number | string | null | undefined): string | null {
  if (typeof value === 'string')
    return Number.isNaN(Date.parse(value)) ? null : new Date(value).toISOString();
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value < 1e12 ? value * 1000 : value).toISOString();
}

function claudeWindow(w: ClaudeWindow | null | undefined, minutes: number): UsageWindow | null {
  const used = w?.used_percentage ?? w?.used_percent;
  if (typeof used !== 'number') return null;
  return {
    label: windowLabel(minutes),
    windowMinutes: minutes,
    usedPercent: Math.min(100, Math.max(0, used)),
    resetsAt: resetTime(w?.resets_at),
  };
}

/** Claude Code's last recorded limits (from its status line), or null. */
export function claudeLimits(dataDir: string | null, now = Date.now()): ProviderLimits | null {
  if (!dataDir) return null;
  try {
    const saved = JSON.parse(readFileSync(path.join(dataDir, 'claude-limits.json'), 'utf8')) as {
      asOf?: string;
      fiveHour?: ClaudeWindow | null;
      sevenDay?: ClaudeWindow | null;
    };
    const windows = [
      claudeWindow(saved.fiveHour, 300),
      claudeWindow(saved.sevenDay, 10_080),
    ].filter((w): w is UsageWindow => w !== null);
    if (
      windows.length === 0 ||
      typeof saved.asOf !== 'string' ||
      !Number.isFinite(Date.parse(saved.asOf))
    )
      return null;
    return rollOver(
      {
        providerId: 'claude',
        windows,
        asOf: new Date(saved.asOf).toISOString(),
        source: 'Claude Code status line (sessions started from ProjectManager)',
      },
      now,
    );
  } catch {
    return null; // Not recorded yet: no Claude session from here has replied since.
  }
}

const TTL_MS = 30_000;
let cached: { at: number; sourceKey: string; value: ProviderLimits[] } | null = null;

function activeCodexHome(dataDir: string | null): string {
  const fallback = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  if (!dataDir) return fallback;
  try {
    const raw = JSON.parse(
      readFileSync(path.join(dataDir, 'codex-accounts.json'), 'utf8'),
    ) as {
      activeProfileId?: string | null;
      accounts?: { id?: string }[];
    };
    const id = raw.activeProfileId;
    if (
      typeof id === 'string' &&
      /^[0-9a-f-]{36}$/i.test(id) &&
      Array.isArray(raw.accounts) &&
      raw.accounts.some((a) => a.id === id)
    ) {
      return path.join(dataDir, 'codex-accounts', id);
    }
  } catch {
    // No saved registry or default account selected.
  }
  return fallback;
}

/** Every provider's limits that can be read locally, cached briefly (Settings polls). */
export function readLimits(
  dataDir: string | null,
  now = Date.now(),
  refresh = false,
): ProviderLimits[] {
  const sourcePath = (value: string) => {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  };
  const codexHome = activeCodexHome(dataDir);
  const sourceKey = JSON.stringify([
    dataDir === null ? null : sourcePath(dataDir),
    sourcePath(codexHome),
  ]);
  if (
    !refresh &&
    cached &&
    cached.sourceKey === sourceKey &&
    now >= cached.at &&
    now - cached.at < TTL_MS
  )
    return cached.value.map((value) => rollOver(value, now));
  const value = [claudeLimits(dataDir, now), codexLimits(os.homedir(), codexHome, now)].filter(
    (l): l is ProviderLimits => l !== null,
  );
  cached = { at: now, sourceKey, value };
  return value;
}
