// Supervises persistent agent CLI sessions and one-shot runs.
//
// Design (supervisor pattern, like systemd/supervisord):
// - Every session/run is a row in SQLite plus a log file on disk, so it survives
//   server restarts and machine reboots.
// - Sessions carry desiredState ('running' vs 'stopped') and a supervise flag.
//   On boot, wanted + supervised sessions relaunch automatically (provider resume
//   flags keep AI conversations going where the CLI supports it); anything else
//   left 'running' is marked 'dead'.
// - stdin written while a session has no live process waits in agent_input_queue
//   and flushes on the next spawn — queued work survives reboots too.
// - Runs are one-shot dispatches (usually of a Kanban card). Runs left
//   'running'/'queued' at shutdown relaunch up to maxAttempts, then fail with an
//   explanatory error; the linked card keeps its status and the verdict.
// - Only node builtins are used (child_process, fs). No shell is ever spawned:
//   argv arrays go straight to the OS, so prompts cannot inject shell commands.

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  appendFileSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  closeSync,
  fstatSync,
  statSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { inferTerminalGeometry, legacyTerminalSnapshot } from './terminalGeometry.js';
import type {
  AgentAutonomy,
  AgentDesiredState,
  AgentInstall,
  AgentInstallStatus,
  AgentOutput,
  AgentRun,
  AgentRunStatus,
  AgentSession,
  AgentSessionStatus,
  AgentTerminal,
  CardRunSummary,
  CardStatus,
  InstallRecipe,
  RunChanges,
} from '../../shared/types.js';
import { isTerminalReport, stripTerminalReports } from '../../shared/terminalReports.js';
import { boardConnection, boardTaskNote } from '../boardMcp.js';
import { withAttachments, listAttachments, cardAttachmentsDir } from '../attachments.js';
import type { Db } from '../db.js';
import {
  deleteSetting,
  getCard,
  cardKey as formatCardKey,
  getProjectRow,
  getSetting,
  setSetting,
  updateCard,
} from '../store.js';
import { diffSince, snapshotTree } from './gitChanges.js';
import {
  animatingInTail,
  backgroundInTail,
  stripTerminal,
  elapsedTimer,
  tailState,
  timerTicking,
  type TimerMemo,
  workingInTail,
} from './activity.js';
import { readLimits } from './limits.js';
import { applyCpuBudget, getCpuBudget } from './cpuBudget.js';
import { allowanceReset, emptyCodexPrompt } from './continuation.js';
import { claudeSessionId, codexSessionFor, staleClaudeResume } from './usage.js';
import {
  antigravityConversationFor,
  claudeCustomTitle,
  codexThreadName,
  grokManualTitle,
  grokSessionExists,
  openCodeSessionFor,
} from './conversations.js';
import { effectiveLevel, getPermissions, withPermissions } from './permissions.js';
import { forgetTurn, turnState } from './turnState.js';
import { HostClient } from './host/client.js';
import type { HostSessionInfo } from './host/protocol.js';
import { fetchScript, recipeFor } from './install.js';
import { processEnv, ptyAvailable, spawnPipe, spawnPty, type AgentProc } from './proc.js';
import {
  buildDispatchArgv,
  buildInteractiveArgv,
  buildResumeArgv,
  getProvider,
  providerAvailable,
  supportsAutonomy,
} from './providers.js';
import { resolveArgv } from './resolve.js';
import { renderScreen } from './screen.js';
import {
  compactLog,
  LOG_KEEP_BYTES,
  logBase,
  logicalSize,
  physicalSize,
  removeLog,
} from './logFile.js';

const now = () => new Date().toISOString();

export const MAX_SESSIONS_PER_PROJECT = 8;
export const MAX_RUNNING_RUNS_PER_PROJECT = 3;
/**
 * Card runs executing at once across all projects. Each run is an agent CLI that builds, tests
 * and lints on its own, so several at once can hold every core for hours (heat, throttling).
 * Further runs wait as 'queued' in the database and start, oldest first, as slots free up.
 */
export const MAX_PARALLEL_RUNS = Math.max(
  1,
  Math.min(4, Math.floor(os.availableParallelism() / 4)),
);
export const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MEM_CAP_BYTES = 256 * 1024;
const MAX_READ_BYTES = 128 * 1024;
const MAX_QUEUE_ENTRIES = 500;
const MAX_QUEUE_BYTES = 256 * 1024;
const RUN_DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const RUN_MAX_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const MAX_RESTARTS = 20;
/** A resumed process that exits non-zero within this time counts as a failed resume. */
const RESUME_FAIL_MS = 20_000;
const RESTART_BASE_MS = 2000;
const RESTART_CAP_MS = 60_000;
const KILL_GRACE_MS = 3000;
/** Installers get one shot each: 10 minutes, then killed. */
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;

interface InstallRow {
  id: number;
  provider_id: string;
  name: string;
  status: AgentInstallStatus;
  exit_code: number | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  log_path: string;
}

interface InstallProc {
  proc: ChildProcess;
  log: OutputLog;
  stoppedByUser: boolean;
  timer?: NodeJS.Timeout;
}

export class AgentError extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

// ---- Output log -----------------------------------------------------------------------------

interface Chunk {
  data: Buffer;
  bytes: number;
}

/** File-backed, offset-addressed log with a capped in-memory window. */
export class OutputLog {
  private chunks: Chunk[] = [];
  private memBytes = 0;
  private baseOffset = 0; // bytes dropped from the head of `chunks`
  totalBytes = 0;

  constructor(
    readonly file: string,
    private onAppend?: () => void,
    private maxFileBytes = MAX_LOG_BYTES,
  ) {
    mkdirSync(path.dirname(file), { recursive: true });
    // Continue from what is already on disk, so byte offsets match the file across server
    // restarts (a reconnecting terminal asks for "everything after byte N"). Offsets are logical:
    // compacted logs record the bytes dropped from their head (logFile.ts).
    const size = logicalSize(file);
    this.baseOffset = size;
    this.totalBytes = size;
  }

  /** Output the session host already wrote to the file at `offset`: mirror it in memory only. */
  ingest(offset: number, text: string): void {
    const bytes = Buffer.byteLength(text);
    if (offset + bytes <= this.totalBytes) return; // Already have it.
    if (offset !== this.totalBytes) this.resync(offset); // Gap/overlap: follow the host.
    this.push(text);
  }

  /** Re-anchor at the file size the host reports; anything older is read from disk. */
  resync(size: number): void {
    if (size === this.totalBytes) return;
    this.chunks = [];
    this.memBytes = 0;
    this.baseOffset = size;
    this.totalBytes = size;
  }

  /** Drop inactive cache only when disk can still serve every byte (writes are best-effort). */
  releaseCache(): boolean {
    if (logicalSize(this.file) < this.totalBytes) return false;
    this.chunks = [];
    this.memBytes = 0;
    this.baseOffset = this.totalBytes;
    return true;
  }

  append(text: string): void {
    if (!text) return;
    try {
      // A full log is compacted to its recent tail; output keeps flowing at growing offsets.
      if (physicalSize(this.file) + Buffer.byteLength(text) > this.maxFileBytes) {
        compactLog(this.file, Math.min(LOG_KEEP_BYTES, Math.floor(this.maxFileBytes / 4)));
      }
      appendFileSync(this.file, text);
    } catch {
      // A log write must never take down a session; memory still serves reads.
    }
    this.push(text);
  }

  private push(text: string): void {
    this.onAppend?.();
    const bytes = Buffer.byteLength(text);
    let tail = this.chunks.at(-1);
    if (!tail || tail.bytes === 4096) {
      tail = { data: Buffer.allocUnsafe(4096), bytes: 0 };
      this.chunks.push(tail);
    }
    // Most PTY events fit in the current block. Encode directly into it, avoiding a
    // temporary Buffer allocation per keystroke/progress update.
    if (bytes <= 4096 - tail.bytes) {
      tail.data.write(text, tail.bytes, bytes, 'utf8');
      tail.bytes += bytes;
      this.memBytes += bytes;
      this.totalBytes += bytes;
      while (this.memBytes > MEM_CAP_BYTES) {
        const dropped = this.chunks.shift()!;
        this.memBytes -= dropped.bytes;
        this.baseOffset += dropped.bytes;
      }
      return;
    }
    const data = Buffer.from(text, 'utf8');
    this.totalBytes += data.length;
    // Fixed blocks bound object overhead even for one-character output events. Store bytes
    // once instead of encoding every cached chunk for every connected viewer's read.
    for (let offset = 0; offset < data.length;) {
      let tail = this.chunks.at(-1);
      if (!tail || tail.bytes === 4096) {
        tail = { data: Buffer.allocUnsafe(4096), bytes: 0 };
        this.chunks.push(tail);
      }
      const take = Math.min(4096 - tail.bytes, data.length - offset);
      data.copy(tail.data, tail.bytes, offset, offset + take);
      tail.bytes += take;
      offset += take;
      this.memBytes += take;
      while (this.memBytes > MEM_CAP_BYTES) {
        const dropped = this.chunks.shift()!;
        this.memBytes -= dropped.bytes;
        this.baseOffset += dropped.bytes;
      }
    }
  }

  /** Read up to MAX_READ_BYTES starting at byte offset `after`. */
  read(after: number): { data: string; nextOffset: number } {
    if (!Number.isFinite(after) || after < 0) after = 0;
    if (after < this.baseOffset) return this.readFile(after);
    // Serve from memory; slice chunks by bytes so multibyte chars never split.
    let skip = after - this.baseOffset;
    const parts: Buffer[] = [];
    let used = 0;
    for (const c of this.chunks) {
      if (used >= MAX_READ_BYTES) break;
      if (skip >= c.bytes) {
        skip -= c.bytes;
        continue;
      }
      const take = Math.min(c.bytes - skip, MAX_READ_BYTES - used);
      parts.push(c.data.subarray(skip, skip + take));
      used += take;
      skip = 0;
    }
    // A byte-limited read can end inside a multibyte glyph. Leave that suffix for the next
    // read instead of inserting replacement characters and advancing beyond its true offset.
    const data = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(parts), {
      stream: true,
    });
    return { data, nextOffset: after + Buffer.byteLength(data) };
  }

  /** Positioned read straight from the file for ranges that fell out of memory. */
  private readFile(after: number): { data: string; nextOffset: number } {
    try {
      const base = logBase(this.file);
      const fd = openSync(this.file, 'r');
      try {
        const size = fstatSync(fd).size;
        // Offsets are logical; anything older than the compacted head resumes at the head.
        const start = Math.min(Math.max(after, base), base + size);
        const len = Math.min(MAX_READ_BYTES, base + size - start);
        if (len <= 0) return { data: '', nextOffset: start };
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = readSync(fd, buf, 0, len, start - base);
        const slice = bytesRead < len ? buf.subarray(0, bytesRead) : buf;
        const data = new TextDecoder('utf-8', { ignoreBOM: true }).decode(slice, { stream: true });
        return { data, nextOffset: start + Buffer.byteLength(data) };
      } finally {
        closeSync(fd);
      }
    } catch {
      return { data: '', nextOffset: after };
    }
  }
}

// ---- Process tree kill ----------------------------------------------------------------------

export function killTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => resolve());
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        return resolve();
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // Already gone.
        }
        resolve();
      }, KILL_GRACE_MS);
      timer.unref?.();
    }
  });
}

// ---- Supervisor -------------------------------------------------------------------------------

interface LiveProc {
  proc: AgentProc;
  log: OutputLog;
  stoppedByUser: boolean;
  timer?: NodeJS.Timeout;
  kind: 'session' | 'run';
  id: number;
}

/** A session process owned by the session host, driven over its socket. */
class HostedProc implements AgentProc {
  readonly terminal = 'pty' as const;
  private exitListeners: ((code: number | null, signal: string | null) => void)[] = [];
  private exited = false;

  constructor(
    private client: HostClient,
    readonly key: string,
    readonly pid: number | undefined,
  ) {}

  write(data: string): boolean {
    if (this.exited || !this.client.connected) return false;
    this.client.request({ op: 'write', key: this.key, data }).catch(() => undefined);
    return true;
  }

  resize(cols: number, rows: number): void {
    this.client.request({ op: 'resize', key: this.key, cols, rows }).catch(() => undefined);
  }

  async kill(): Promise<void> {
    await this.client.request({ op: 'kill', key: this.key }).catch(() => undefined);
  }

  // Output goes straight from host events into the session's OutputLog (see wireHosted).
  onData(): void {}
  onError(): void {}

  onExit(listener: (code: number | null, signal: string | null) => void): void {
    this.exitListeners.push(listener);
  }

  deliverExit(code: number | null, signal: string | null): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of this.exitListeners) listener(code, signal);
  }
}

/** The host's key for a session record: the id alone is not unique (SQLite reuses ids). */
const hostKey = (row: { id: number; log_path: string }) => `session:${row.id}|${row.log_path}`;

interface SessionRow {
  id: number;
  project_id: number;
  name: string;
  provider_id: string;
  command_json: string;
  resume_json: string | null;
  cwd: string;
  pid: number | null;
  status: AgentSessionStatus;
  exit_code: number | null;
  desired_state: AgentDesiredState;
  supervise: number;
  restarts: number;
  last_restart_at: string | null;
  created_at: string;
  started_at: string;
  ended_at: string | null;
  log_path: string;
  terminal: AgentTerminal;
  card_id: number | null;
  /** Set for an orchestrator's chat CLI (PM-89). */
  orchestrator_id: string | null;
  /** When the user last sent it a message (PM-94). */
  last_input_at: string | null;
}

interface RunRow {
  id: number;
  project_id: number;
  card_id: number | null;
  name: string;
  provider_id: string;
  command_json: string;
  prompt: string;
  status: AgentRunStatus;
  exit_code: number | null;
  error: string | null;
  attempts: number;
  max_attempts: number;
  validation: 'accepted' | 'rejected' | null;
  validated_at: string | null;
  validated_move: CardStatus | null;
  created_at: string;
  started_at: string | null;
  ended_at: string | null;
  log_path: string;
  autonomy: AgentAutonomy;
  changes_json: string | null;
  orchestrator_id: string | null;
}

/**
 * How much of a session log its screen is rebuilt from. CLIs repaint only what changed, so the
 * screen needs more than the latest frames; 256 KB covers the last full redraw in practice and
 * replays in a few milliseconds.
 */
const SCREEN_TAIL_BYTES = 256 * 1024;
/** How far back a log is searched for its last recorded size. */
const RECORDED_SIZE_SCAN_BYTES = 64 * 1024 * 1024;

/** The last size marker (`OSC 777;pm-size;cols;rows`) in some log text, if a sane one. */
function lastRecordedSize(text: string): { cols: number; rows: number } | null {
  // eslint-disable-next-line no-control-regex -- the geometry marker the log records
  const m = [...text.matchAll(/\x1b\]777;pm-size;(\d+);(\d+)\x07/g)].at(-1);
  if (!m) return null;
  const cols = Number(m[1]);
  const rows = Number(m[2]);
  return cols >= 20 && cols <= 500 && rows >= 1 && rows <= 500 ? { cols, rows } : null;
}
/** A working line counts only with output this recent (a busy CLI redraws its timer constantly). */
const FRESH_OUTPUT_MS = 6_000;
/** Output this soon after a keystroke is its echo (typing), not the agent working. */
const ECHO_WINDOW_MS = 1_500;
/** CLIs with a /rename command whose names we keep in sync with the session's. */
const RENAMABLE = new Set(['claude', 'codex', 'grok']);
/** A rename made here, waiting until the CLI is idle to be typed in as /rename. */
const renameKey = (id: number) => `session-rename:${id}`;
/** The CLI name last seen or sent, so a change made in the CLI is told apart from ours. */
const seenTitleKey = (id: number) => `session-cli-title:${id}`;

export class AgentSupervisor {
  private live = new Map<string, LiveProc>();
  private sessionSizes = new Map<number, { cols: number; rows: number }>();
  /** Sizes read back from session logs, for screens no viewer has sized yet (PM-129). */
  private recordedSizes = new Map<number, { cols: number; rows: number }>();
  private sizeSearched = new Set<number>();
  private logs = new Map<string, OutputLog>();
  /** Keys whose spawn is in flight (argv resolution is async): guards double starts. */
  private starting = new Set<string>();
  private readonly maxParallelRuns: number;
  /** Apply Settings → CPU budget to agent processes (production; tests opt in). */
  private readonly cpuBudget: boolean;
  /** When each session last spawned and whether that spawn resumed a conversation. */
  private lastSpawn = new Map<string, { at: number; resumed: boolean; byUser: boolean }>();
  /** Sessions whose last resume died right away: their next relaunch starts fresh. */
  private resumeFailed = new Set<string>();
  /** Last busy-line timer seen per session, and when it last changed (PM-67). */
  private timers: TimerMemo = new Map();
  /** When each session last got a key typed by a person (not terminal reports). */
  private lastKeystroke = new Map<number, number>();
  private closed = false;
  private restarting = new Map<
    number,
    { phase: 'stopping' | 'starting' | 'restoring' | 'failed'; error?: string; since: number }
  >();
  private continuationTimer?: ReturnType<typeof setInterval>;
  /** Emits `output:<kind>:<id>` whenever a log grows, for live streaming to the GUI. */
  readonly events = new EventEmitter().setMaxListeners(0);
  /** Interactive sessions live in the session host (survive server restarts) when enabled. */
  private readonly useHost: boolean;
  /** The data folder (null in tests without one); limits.ts reads recorder output there. */
  readonly dataDir: string | null;
  private host: HostClient | null = null;
  private hostConnecting: Promise<HostClient | null> | null = null;
  private hosted = new Map<string, { proc: HostedProc; log: OutputLog }>();
  /** Live installer processes (global, not per-project). */
  private installing = new Map<number, InstallProc>();
  /** Provider ids with an install spawn in flight: guards double starts. */
  private installStarting = new Set<string>();
  /** Test-only recipe overrides (production always uses the catalog). */
  private readonly installRecipes: Partial<Record<string, InstallRecipe>>;
  /** Resolves once boot reconciliation (re-attach / relaunch) is done. */
  readonly ready: Promise<void>;

  /** A card task plus the paths of the card's attached images (stored next to the agent logs). */
  private withImages(prompt: string, cardId: number, providerId?: string): string {
    return withAttachments(
      prompt +
        (['claude', 'codex', 'opencode', 'antigravity'].includes(providerId ?? '')
          ? boardTaskNote
          : ''),
      path.join(path.dirname(this.logDir), 'attachments'),
      cardId,
    );
  }

  private imagePaths(cardId: number): string[] {
    const root = path.join(path.dirname(this.logDir), 'attachments');
    return listAttachments(root, cardId).map((image) =>
      path.join(cardAttachmentsDir(root, cardId), image.file),
    );
  }

  constructor(
    private db: Db,
    private logDir: string,
    options: {
      host?: boolean;
      dataDir?: string;
      installRecipes?: Partial<Record<string, InstallRecipe>>;
      maxParallelRuns?: number;
      cpuBudget?: boolean;
    } = {},
  ) {
    mkdirSync(logDir, { recursive: true });
    this.dataDir = options.dataDir ?? null;
    this.maxParallelRuns = options.maxParallelRuns ?? MAX_PARALLEL_RUNS;
    this.cpuBudget = options.cpuBudget ?? false;
    this.installRecipes = options.installRecipes ?? {};
    this.useHost = !!options.host && !!this.dataDir && ptyAvailable();
    this.ready = this.reconcile().catch((e: Error) => {
      console.error('[agents] reconcile failed:', e);
    });
    this.continuationTimer = setInterval(() => {
      if (!this.closed) {
        try {
          this.tickContinuation();
        } catch (e) {
          console.error('[agents] auto-continue:', e);
        }
      }
    }, 10_000);
    this.continuationTimer.unref();
  }

  // ---- Session host ------------------------------------------------------------------------

  private getHost(): Promise<HostClient | null> {
    if (!this.useHost || this.closed) return Promise.resolve(null);
    if (this.host?.connected) return Promise.resolve(this.host);
    this.hostConnecting ??= HostClient.connect(this.dataDir!).then((client) => {
      this.hostConnecting = null;
      if (!client || this.closed) {
        client?.close();
        if (!client) console.warn('[agents] session host unavailable; running sessions in-process');
        return null;
      }
      this.host = client;
      // Every session the host starts inherits the budget; this also covers ones it already runs.
      void this.limitCpu([client.hostPid]);
      client.on('data', (key, offset, data) => this.hosted.get(key)?.log.ingest(offset, data));
      client.on('exit', (key, code, signal) =>
        this.hosted.get(key)?.proc.deliverExit(code, signal),
      );
      client.on('disconnect', () => this.onHostLost(client));
      return client;
    });
    return this.hostConnecting;
  }

  /** Settings → CPU budget for the given processes and everything they run. */
  private async limitCpu(pids: (number | undefined)[]): Promise<void> {
    if (!this.cpuBudget || this.closed) return;
    const roots = pids.filter((pid): pid is number => !!pid);
    if (roots.length) await applyCpuBudget(roots, getCpuBudget(this.db).threads);
  }

  /** Re-applies the CPU budget to every agent process (after the setting changed). */
  async refreshCpuBudget(): Promise<void> {
    const pids = [...this.live.values()]
      .filter((live) => !(live.proc instanceof HostedProc))
      .map((live) => live.proc.pid);
    await this.limitCpu([this.host?.connected ? this.host.hostPid : undefined, ...pids]);
  }

  /** The host went away (crashed/killed): its sessions are gone; restart them normally. */
  private onHostLost(client: HostClient): void {
    if (this.host === client) this.host = null;
    if (this.closed) return;
    console.warn('[agents] session host disconnected');
    for (const [key, hosted] of this.hosted) {
      this.hosted.delete(key);
      hosted.proc.deliverExit(null, 'session host exited');
    }
  }

  /** Common wiring for a hosted session we just spawned or re-attached to. */
  private wireHosted(
    row: SessionRow,
    client: HostClient,
    info: HostSessionInfo,
    log: OutputLog,
  ): void {
    const key = this.logPathFor('session', row.id);
    const hk = hostKey(row);
    log.resync(info.logBytes);
    const proc = new HostedProc(client, hk, info.pid ?? undefined);
    const live: LiveProc = { proc, log, stoppedByUser: false, kind: 'session', id: row.id };
    this.live.set(key, live);
    this.hosted.set(hk, { proc, log });
    proc.onExit((code, signal) => {
      this.hosted.delete(hk);
      client.request({ op: 'forget', key: hk }).catch(() => undefined);
      this.onSessionExit(row, key, live, code, signal);
    });
    this.db
      .prepare(
        `UPDATE agent_sessions SET status = 'running', pid = ?, ended_at = NULL WHERE id = ?`,
      )
      .run(info.pid ?? null, row.id);
    this.flushInputQueue(row.id, proc);
  }

  private async killLive(live: LiveProc): Promise<void> {
    if (live.proc instanceof HostedProc) await live.proc.kill();
    else if (live.proc.pid) await killTree(live.proc.pid);
  }

  // ---- Boot reconciliation: survive restarts and reboots -------------------------------------

  private async reconcile(): Promise<void> {
    // Sessions are never dropped by a restart: anything still wanted is re-attached (alive in the
    // session host) or relaunched (died, e.g. reboot). Only deliberately stopped ones stay down.
    const sessions = this.db
      .prepare(`SELECT * FROM agent_sessions`)
      .all() as unknown as SessionRow[];
    const inHost = new Map<string, HostSessionInfo>();
    if (sessions.some((r) => r.terminal === 'pty' && r.status === 'running')) {
      const host = await this.getHost();
      try {
        for (const info of (await host?.list()) ?? []) inHost.set(info.key, info);
      } catch {
        // Host unavailable: fall through to relaunching.
      }
    }
    for (const row of sessions) {
      const hosted = inHost.get(hostKey(row));
      if (row.desired_state === 'running' && row.status === 'running') {
        if (hosted?.alive && this.host) {
          this.wireHosted(
            row,
            this.host,
            hosted,
            this.outputFor(`session:${row.id}`, row.log_path),
          );
          continue;
        }
        if (hosted) this.host?.request({ op: 'forget', key: hostKey(row) }).catch(() => undefined);
        this.log(
          row.log_path,
          `\n[supervisor] server restarted — relaunching session (attempt ${row.restarts + 1})\n`,
        );
        this.spawnSession(row, true).catch((e) => this.markSessionDead(row.id, String(e)));
      } else if (row.status === 'running') {
        // Wanted down (stopped on purpose) but still alive somewhere: honour the stop.
        if (hosted?.alive)
          this.host?.request({ op: 'kill', key: hostKey(row) }).catch(() => undefined);
        this.db
          .prepare(
            `UPDATE agent_sessions SET status = 'dead', pid = NULL, ended_at = ? WHERE id = ?`,
          )
          .run(now(), row.id);
      }
    }
    // Runs: relaunch attempts left, fail the exhausted ones with an explanation.
    const runs = this.db
      .prepare(`SELECT * FROM agent_runs WHERE status IN ('queued', 'running')`)
      .all() as unknown as RunRow[];
    for (const row of runs) {
      if (row.attempts < row.max_attempts) {
        this.log(
          row.log_path,
          `\n[supervisor] server restarted — relaunching run (attempt ${row.attempts + 1}/${row.max_attempts})\n`,
        );
        void this.spawnRun(row, true);
      } else {
        this.db
          .prepare(`UPDATE agent_runs SET status = 'failed', error = ?, ended_at = ? WHERE id = ?`)
          .run('Server shut down before completion (attempts exhausted)', now(), row.id);
      }
    }
    // Installs never relaunch: they are quick and idempotent enough to retry by hand.
    this.db
      .prepare(
        `UPDATE agent_installs SET status = 'failed', error = ?, ended_at = ? WHERE status = 'running'`,
      )
      .run('Server shut down before completion', now());
  }

  // ---- Sessions -------------------------------------------------------------------------------

  listSessions(projectId: number): AgentSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY id`)
      .all(projectId) as unknown as SessionRow[];
    return rows.map((r) => this.toSession(r));
  }

  /** Every session in every project, newest last (the workspace shows sessions side by side). */
  listAllSessions(): AgentSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_sessions ORDER BY id`)
      .all() as unknown as SessionRow[];
    return rows.map((r) => this.toSession(r));
  }

  getSession(id: number, projectId?: number): AgentSession | null {
    const row = this.db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).get(id) as
      SessionRow | undefined;
    if (!row || (projectId !== undefined && row.project_id !== projectId)) return null;
    return this.toSession(row);
  }

  async createSession(
    projectId: number,
    input: {
      providerId?: string;
      command?: string[];
      name?: string;
      cwd?: string;
      supervise?: boolean;
      env?: Record<string, string>;
      /** Defaults to 'pty' when node-pty is available (needed for interactive AI CLIs). */
      terminal?: AgentTerminal;
      /** Kanban card this session works on; it also primes the first prompt. */
      cardId?: number;
      /** First prompt for the interactive CLI (defaults to the card's task when cardId is set). */
      prompt?: string;
      /** The master orchestrator this session is the chat of (PM-89). */
      orchestratorId?: string;
    },
  ): Promise<AgentSession> {
    const project = getProjectRow(this.db, projectId);
    if (!project) throw new AgentError(404, 'Project not found');
    const card = input.cardId !== undefined ? getCard(this.db, input.cardId) : null;
    if (input.cardId !== undefined && (!card || card.projectId !== projectId)) {
      throw new AgentError(404, 'Card not found');
    }
    const count = (
      this.db
        // Orchestrator chats only borrow a project as their home; they don't use its slots.
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_sessions WHERE project_id = ? AND orchestrator_id IS NULL`,
        )
        .get(projectId) as { n: number }
    ).n;
    if (!input.orchestratorId && count >= MAX_SESSIONS_PER_PROJECT) {
      throw new AgentError(409, `Session limit reached (${MAX_SESSIONS_PER_PROJECT} per project)`);
    }

    const providerId = input.providerId ?? (input.command ? 'custom' : 'shell');
    const provider = getProvider(providerId);
    if (!provider) throw new AgentError(400, `Unknown provider: ${providerId}`);
    if (provider.binary && !(await providerAvailable(providerId))) {
      throw new AgentError(
        400,
        `${provider.name} is not on PATH${provider.installUrl ? ` — install: ${provider.installUrl}` : ''}`,
      );
    }
    // Explicit commands win; otherwise an AI provider starts its interactive
    // REPL and a resume path is stored for crash/reboot relaunches.
    const explicit = input.command ? validateCommand(input.command) : null;
    const prompt = (
      card
        ? this.withImages(
            input.prompt ??
              defaultPrompt(card.key, card.title, card.description, undefined, card.issueUrl),
            card.id,
            providerId,
          )
        : (input.prompt ?? '')
    ).slice(0, 20_000);
    // Pin the conversation to our own id where the CLI supports it, so resume reopens exactly
    // this conversation even when several sessions share a project.
    const conversationId = !explicit && provider.sessionIdArgs ? randomUUID() : undefined;
    const name =
      input.name?.trim() || (card ? `${card.key}: ${card.title}`.slice(0, 80) : provider.name);
    // A chosen name (not just the CLI's) names the CLI's conversation too (PM-33).
    const chosenName = name !== provider.name ? name : undefined;
    const command =
      explicit ??
      buildInteractiveArgv(provider, {
        sessionId: conversationId,
        name: chosenName,
        images: card ? this.imagePaths(card.id) : [],
        prompt: prompt.trim() ? prompt : undefined,
      });
    if (command.length === 0) throw new AgentError(400, 'No command to run');
    const resume = explicit ? null : buildResumeArgv(provider, conversationId);
    const cwd = resolveCwd(input.cwd ?? project.path);
    const env = validateEnv(input.env);
    const terminal: AgentTerminal = input.terminal ?? (ptyAvailable() ? 'pty' : 'pipe');
    if (terminal === 'pty' && !ptyAvailable()) {
      throw new AgentError(400, 'Terminal sessions need node-pty, which is not installed here');
    }

    const ts = now();
    const logPath = path.join(
      this.logDir,
      `session-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`,
    );
    const result = this.db
      .prepare(
        `INSERT INTO agent_sessions
           (project_id, name, provider_id, command_json, resume_json, cwd, status,
            desired_state, supervise, created_at, started_at, log_path, terminal, card_id,
            orchestrator_id)
         VALUES (?, ?, ?, ?, ?, ?, 'running', 'running', ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        projectId,
        name,
        providerId,
        JSON.stringify({ command, env }),
        resume ? JSON.stringify(resume) : null,
        cwd,
        (input.supervise ?? true) ? 1 : 0,
        ts,
        ts,
        logPath,
        terminal,
        card?.id ?? null,
        input.orchestratorId ?? null,
      );
    const id = Number(result.lastInsertRowid);
    // CLIs without a launch flag for the name get it by /rename once they're ready.
    if (chosenName && !explicit && !provider.nameArg && RENAMABLE.has(providerId)) {
      setSetting(this.db, renameKey(id), chosenName);
    }
    // A first prompt is the first message you sent it.
    if (prompt.trim()) {
      this.db.prepare('UPDATE agent_sessions SET last_input_at = ? WHERE id = ?').run(ts, id);
    }
    // Starting work on a card moves it to In progress, like a dispatch does.
    if (card && (card.status === 'backlog' || card.status === 'todo')) {
      updateCard(this.db, card.id, { status: 'in_progress' });
    }
    const row = this.db
      .prepare(`SELECT * FROM agent_sessions WHERE id = ?`)
      .get(id) as unknown as SessionRow;
    // Await the spawn so the response reports the live process (spawn failures mark it dead).
    await this.spawnSession(row, false).catch((e) => this.markSessionDead(id, String(e)));
    return this.toSession(
      this.db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).get(id) as unknown as SessionRow,
    );
  }

  renameSession(id: number, name: string): AgentSession | null {
    const row = this.getSessionRow(id);
    if (!row) return null;
    this.db.prepare(`UPDATE agent_sessions SET name = ? WHERE id = ?`).run(name, id);
    // The CLI gets it by /rename as soon as it's ready (syncTitles), even after a restart.
    if (RENAMABLE.has(row.provider_id)) setSetting(this.db, renameKey(id), name);
    return this.getSession(id);
  }

  renameRun(id: number, name: string): AgentRun | null {
    if (!this.getRun(id)) return null;
    this.db.prepare(`UPDATE agent_runs SET name = ? WHERE id = ?`).run(name, id);
    return this.getRun(id);
  }

  setSupervise(id: number, supervise: boolean): AgentSession | null {
    const row = this.getSessionRow(id);
    if (!row) return null;
    this.db
      .prepare(`UPDATE agent_sessions SET supervise = ? WHERE id = ?`)
      .run(supervise ? 1 : 0, id);
    return this.getSession(id);
  }

  /**
   * Make a card the session's current task, so an agent that already has context keeps working
   * in the same conversation. With `send`, the card's task is pasted into the session (bracketed
   * paste, so multi-line text arrives as one message) and submitted; only AI CLIs receive it, as
   * a shell would run each pasted line as a command. `cardId: null` detaches.
   */
  attachCard(
    id: number,
    cardId: number | null,
    options: { send?: boolean; prompt?: string } = {},
  ): { session: AgentSession; queued: boolean; sent: boolean } {
    const row = this.getSessionRow(id);
    if (!row) throw new AgentError(404, 'Session not found');
    if (cardId === null) {
      this.db.prepare(`UPDATE agent_sessions SET card_id = NULL WHERE id = ?`).run(id);
      return { session: this.getSession(id)!, queued: false, sent: false };
    }
    const card = getCard(this.db, cardId);
    if (!card || card.projectId !== row.project_id) {
      throw new AgentError(404, "Card not found in this session's project");
    }
    // Sessions named after their previous card ("PM-4: …", set automatically) follow the new card;
    // a name the user chose is kept.
    const autoNamed = /^[A-Z]+-\d+: /.test(row.name);
    this.db
      .prepare(`UPDATE agent_sessions SET card_id = ?, name = ? WHERE id = ?`)
      .run(cardId, autoNamed ? `${card.key}: ${card.title}`.slice(0, 80) : row.name, id);
    if (card.status === 'backlog' || card.status === 'todo') {
      updateCard(this.db, card.id, { status: 'in_progress' });
    }
    const isAiCli = getProvider(row.provider_id)?.binary != null;
    if (!options.send || !isAiCli) {
      return { session: this.getSession(id)!, queued: false, sent: false };
    }
    const prompt = this.withImages(
      options.prompt ??
        defaultPrompt(card.key, card.title, card.description, undefined, card.issueUrl),
      card.id,
      row.provider_id,
    )
      .slice(0, 20_000)
      // A paste-end marker inside the text would end the paste early; never forward it.
      .replaceAll('\x1b[201~', '');
    const { queued } = this.sendInput(id, `\x1b[200~${prompt}\x1b[201~\r`);
    return { session: this.getSession(id)!, queued, sent: true };
  }

  /** Write stdin: straight to the live process, or queued durably when it is down. */
  sendInput(
    id: number,
    data: string,
    manual = true,
  ): { queued: boolean; session: AgentSession | null } {
    const row = this.getSessionRow(id);
    if (!row) return { queued: false, session: null };
    if (!data) throw new AgentError(400, 'Input is empty');
    if (Buffer.byteLength(data) > 64 * 1024)
      throw new AgentError(400, 'Input too large (64KB max)');
    if (manual && !isTerminalReport(data)) this.cancelContinuation(id, 'Cancelled by manual input');
    // Typed keys come back as echo output; remembered so it isn't mistaken for work (PM-67).
    if (manual && !isTerminalReport(data)) this.lastKeystroke.set(id, Date.now());
    // A message sent (Enter, or a paste ending a line), not each keystroke: the list sorts by it.
    if (manual && !isTerminalReport(data) && /[\r\n]/.test(data)) {
      this.db.prepare('UPDATE agent_sessions SET last_input_at = ? WHERE id = ?').run(now(), id);
    }
    const live = this.live.get(`session:${id}`);
    if (live && live.proc.write(data)) return { queued: false, session: this.getSession(id) };
    // A terminal's automatic replies (focus, device attributes, cursor reports) mean nothing to
    // a process that isn't listening: never queue them.
    if (isTerminalReport(data)) return { queued: false, session: this.getSession(id) };
    const usage = this.db
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM agent_input_queue WHERE session_id = ?`,
      )
      .get(id) as { n: number; bytes: number };
    if (usage.n >= MAX_QUEUE_ENTRIES || usage.bytes > MAX_QUEUE_BYTES) {
      throw new AgentError(409, 'Input queue is full; wait for the session to come back');
    }
    this.db
      .prepare(`INSERT INTO agent_input_queue (session_id, data, created_at) VALUES (?, ?, ?)`)
      .run(id, data, now());
    return { queued: true, session: this.getSession(id) };
  }

  /** Resize a PTY session's terminal to match the viewer (no-op for pipe sessions). */
  resizeSession(id: number, cols: number, rows: number): boolean {
    if (!this.getSessionRow(id)) return false;
    const previous = this.sessionSizes.get(id);
    this.sessionSizes.set(id, { cols, rows });
    const live = this.live.get(`session:${id}`);
    if (live && (previous?.cols !== cols || previous?.rows !== rows)) {
      // Record geometry before the redraw so stopped viewers can replay cursor motion faithfully.
      if (!(live.proc instanceof HostedProc)) {
        live.log.append(`\x1b]777;pm-size;${cols};${rows}\x07`);
      }
      live.proc.resize(cols, rows);
    }
    return true;
  }

  readSessionOutput(id: number, after: number): AgentOutput | null {
    const row = this.getSessionRow(id);
    if (!row) return null;
    const output = this.readOutput(
      `session:${id}`,
      row.log_path,
      row.status === 'running',
      row.exit_code,
      after,
    );
    if (
      after === 0 &&
      row.terminal === 'pty' &&
      row.status !== 'running' &&
      !output.data.includes('\x1b]777;pm-size;')
    ) {
      try {
        const st = { size: physicalSize(row.log_path) };
        const maxLegacyBytes = 1024 * 1024;
        let log: string;
        if (st.size > maxLegacyBytes) {
          const fd = openSync(row.log_path, 'r');
          try {
            const buf = Buffer.allocUnsafe(maxLegacyBytes);
            const bytesRead = readSync(fd, buf, 0, maxLegacyBytes, st.size - maxLegacyBytes);
            log = buf.subarray(0, bytesRead).toString('utf8');
          } finally {
            closeSync(fd);
          }
        } else {
          log = readFileSync(row.log_path, 'utf8');
        }
        const snapshot = row.provider_id === 'opencode' ? legacyTerminalSnapshot(log) : null;
        if (snapshot) {
          output.data = snapshot;
          // Snapshot represents the whole archive, not a new log with different byte offsets.
          output.nextOffset = output.logBytes;
        } else {
          output.terminalSize = inferTerminalGeometry(log);
        }
      } catch {
        // Missing logs still return the normal output response.
      }
    }
    return output;
  }

  async stopSession(id: number): Promise<AgentSession | null> {
    const row = this.getSessionRow(id);
    if (!row) return null;
    this.cancelContinuation(id, 'Cancelled by Stop or Restart');
    this.db.prepare(`UPDATE agent_sessions SET desired_state = 'stopped' WHERE id = ?`).run(id);
    const live = this.live.get(`session:${id}`);
    if (live) {
      live.stoppedByUser = true;
      if (live.timer) clearTimeout(live.timer);
      // The host can acknowledge kill before its exit notification clears the live entry.
      // Wait for that notification so an immediate Start cannot race the old process.
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      const exited = new Promise<void>((resolve, reject) => {
        live.proc.onExit(() => resolve());
        exitTimer = setTimeout(
          () => reject(new AgentError(409, 'Timed out waiting for session to stop')),
          10_000,
        );
      });
      try {
        await Promise.all([this.killLive(live), exited]);
      } finally {
        clearTimeout(exitTimer);
      }
    } else if (row.status === 'running') {
      this.db
        .prepare(
          `UPDATE agent_sessions SET status = 'killed', pid = NULL, ended_at = ? WHERE id = ?`,
        )
        .run(now(), id);
    }
    return this.getSession(id);
  }

  /** (Re)start a stopped/dead/exited session. Resets the restart counter. */
  async restartSession(id: number): Promise<AgentSession> {
    if (!this.getSessionRow(id)) throw new AgentError(404, 'Session not found');
    const pending = this.restarting.get(id);
    if (pending && pending.phase !== 'failed')
      throw new AgentError(409, 'Restart already in progress');
    const state = {
      phase: 'stopping' as 'stopping' | 'starting' | 'restoring' | 'failed',
      since: Date.now(),
      error: undefined as string | undefined,
    };
    this.restarting.set(id, state);
    try {
      await this.stopSession(id);
      state.phase = 'starting';
      const session = await this.startSession(id);
      if (session.status !== 'running')
        throw new AgentError(400, 'CLI failed to start. Inspect the terminal log.');
      state.phase = 'restoring';
      state.since = Date.now();
      return this.getSession(id)!;
    } catch (e) {
      state.phase = 'failed';
      state.error = (e as Error).message;
      throw e;
    }
  }

  setAutoContinue(id: number, enabled: boolean): AgentSession {
    const row = this.getSessionRow(id);
    if (!row) throw new AgentError(404, 'Session not found');
    if (row.provider_id !== 'codex' || row.terminal !== 'pty')
      throw new AgentError(
        400,
        'Use Claude’s native auto-continue; managed continuation supports Codex terminals.',
      );
    setSetting(this.db, `session-auto-continue:${id}`, {
      enabled,
      resumesAt: null,
      message: enabled ? 'Watching for an allowance limit' : 'Auto-continue off',
      offset: this.fileSize(row.log_path),
      conversation: this.conversationOf(row),
      attempts: 0,
      startedAt: row.started_at,
      checkedAt: Date.now(),
    });
    // Allow opting in after the visible error has already occurred.
    if (enabled) this.armContinuation(row);
    return this.getSession(id)!;
  }

  private cancelContinuation(id: number, message: string): void {
    const key = `session-auto-continue:${id}`;
    const state = getSetting<{ enabled: boolean; resumesAt: string | null; message: string }>(
      this.db,
      key,
    );
    if (state?.enabled)
      setSetting(this.db, key, { ...state, enabled: false, resumesAt: null, message });
  }

  private armContinuation(row: SessionRow): void {
    const key = `session-auto-continue:${row.id}`;
    const state = getSetting<{ enabled: boolean; resumesAt: string | null; attempts: number }>(
      this.db,
      key,
    );
    if (!state?.enabled || state.resumesAt) return;
    const limits = readLimits(this.dataDir).find((p) => p.providerId === 'codex');
    const resumesAt = allowanceReset(
      this.logTail(row.log_path) ?? '',
      limits?.windows ?? [],
      Date.now(),
    );
    if (!resumesAt) return;
    setSetting(this.db, key, { ...state, resumesAt, message: 'Waiting for allowance reset' });
  }

  private tickContinuation(): void {
    const rows = this.db
      .prepare(`SELECT * FROM agent_sessions WHERE provider_id = 'codex' AND status = 'running'`)
      .all() as unknown as SessionRow[];
    for (const row of rows) {
      const key = `session-auto-continue:${row.id}`;
      let state = getSetting<{
        enabled: boolean;
        resumesAt: string | null;
        message: string;
        offset: number;
        conversation: string | null;
        startedAt: string;
        checkedAt: number;
        attempts: number;
      }>(this.db, key);
      if (!state?.enabled) continue;
      if (
        state.startedAt !== row.started_at ||
        (state.conversation && state.conversation !== this.conversationOf(row))
      ) {
        this.cancelContinuation(row.id, 'Cancelled: session or conversation changed');
        continue;
      }
      const previousCheck = state.checkedAt;
      state.checkedAt = Date.now();
      setSetting(this.db, key, state);
      const size = this.fileSize(row.log_path);
      if (!state.resumesAt && size > state.offset) {
        this.armContinuation(row);
        state = getSetting(this.db, key)!;
        state.offset = size;
        setSetting(this.db, key, state);
      }
      if (!state.resumesAt || Date.parse(state.resumesAt) > Date.now()) continue;
      if (Date.now() - previousCheck > 30 * 60_000) {
        this.cancelContinuation(row.id, 'Allowance reset while offline. Continue manually.');
        continue;
      }
      const tail = this.logTail(row.log_path) ?? '';
      // A placeholder is evidence that the CLI draft is empty; never overwrite typed text.
      if (
        this.sessionActivity(row, this.fileModifiedAt(row.log_path)) !== 'idle' ||
        !emptyCodexPrompt(tail)
      )
        continue;
      const live = this.live.get(`session:${row.id}`);
      if (!live || this.queuedInputBytes(row.id)) continue;
      // Persist the claim before sending, so reconnect/restart cannot duplicate submission.
      this.cancelContinuation(row.id, 'Continuation sent; enable again for another reset');
      if (
        !live.proc.write(
          '\x1b[200~Continue the interrupted task from where you stopped.\x1b[201~\r',
        )
      ) {
        setSetting(this.db, key, {
          ...state,
          enabled: false,
          resumesAt: null,
          message: 'Could not send continuation. Continue manually.',
        });
      }
    }
  }

  async startSession(id: number): Promise<AgentSession> {
    const row = this.getSessionRow(id);
    if (!row) throw new AgentError(404, 'Session not found');
    if (this.live.has(`session:${id}`)) throw new AgentError(409, 'Session is already running');
    if (this.restarting.get(id)?.phase === 'failed') this.restarting.delete(id);
    this.db
      .prepare(`UPDATE agent_sessions SET desired_state = 'running', restarts = 0 WHERE id = ?`)
      .run(id);
    const fresh = this.getSessionRow(id)!;
    // Starting a stopped session continues its conversation, like a relaunch: launching the
    // original command again would replay its first prompt or reuse a pinned id (which CLIs refuse).
    try {
      await this.spawnSession(fresh, true, true);
    } catch (e) {
      this.markSessionDead(id, String(e));
      throw e;
    }
    return this.getSession(id)!;
  }

  async removeSession(id: number): Promise<boolean> {
    const row = this.getSessionRow(id);
    if (!row) return false;
    await this.stopSession(id);
    this.db.prepare(`DELETE FROM agent_sessions WHERE id = ?`).run(id);
    deleteSetting(this.db, renameKey(id));
    deleteSetting(this.db, seenTitleKey(id));
    deleteSetting(this.db, `session-auto-continue:${id}`);
    this.restarting.delete(id);
    // Forget the record's process and log now: SQLite reuses ids, and a new session with this id
    // must not be mistaken for the old one while the old process is still exiting.
    this.live.delete(`session:${id}`);
    this.logs.delete(`session:${id}`);
    try {
      removeLog(row.log_path);
    } catch {
      // Log cleanup is best-effort.
    }
    return true;
  }

  // ---- Runs -----------------------------------------------------------------------------------

  listRuns(projectId: number, cardId?: number): AgentRun[] {
    const rows = (cardId === undefined
      ? this.db
          .prepare(`SELECT * FROM agent_runs WHERE project_id = ? ORDER BY id DESC`)
          .all(projectId)
      : this.db
          .prepare(`SELECT * FROM agent_runs WHERE project_id = ? AND card_id = ? ORDER BY id DESC`)
          .all(projectId, cardId)) as unknown as RunRow[];
    return rows.map((r) => this.toRun(r));
  }

  /** The newest runs across every project (the workspace list view). */
  listAllRuns(limit = 200): AgentRun[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_runs ORDER BY id DESC LIMIT ?`)
      .all(limit) as unknown as RunRow[];
    return rows.map((r) => this.toRun(r));
  }

  /** Batch workspace hydration: one SQL read, including card identity, in requested order. */
  getRunsByIds(ids: readonly number[]): AgentRun[] {
    if (!ids.length) return [];
    const rows = this.db
      .prepare(
        `SELECT r.*, c.id AS existing_card_id
      FROM agent_runs r LEFT JOIN cards c ON c.id = r.card_id
      WHERE r.id IN (SELECT value FROM json_each(?))`,
      )
      .all(JSON.stringify(ids)) as unknown as (RunRow & { existing_card_id: number | null })[];
    const byId = new Map(rows.map((row) => [row.id, row]));
    return [...new Set(ids)].flatMap((id) => {
      const row = byId.get(id);
      return row
        ? [
            this.toRun(
              row,
              row.existing_card_id == null ? null : formatCardKey(row.existing_card_id),
            ),
          ]
        : [];
    });
  }

  getRun(id: number, projectId?: number): AgentRun | null {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as unknown as
      RunRow | undefined;
    if (!row || (projectId !== undefined && row.project_id !== projectId)) return null;
    return this.toRun(row);
  }

  cardSummaries(projectId: number): CardRunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT card_id,
                SUM(status = 'running' OR status = 'queued') AS running,
                SUM(status = 'succeeded') AS succeeded,
                SUM(status = 'failed') AS failed,
                SUM(status = 'succeeded' AND validation IS NULL) AS awaiting
           FROM agent_runs WHERE project_id = ? AND card_id IS NOT NULL GROUP BY card_id`,
      )
      .all(projectId) as {
      card_id: number;
      running: number;
      succeeded: number;
      failed: number;
      awaiting: number;
    }[];
    const summaries = new Map<number, CardRunSummary>(
      rows.map((r) => [
        r.card_id,
        {
          cardId: r.card_id,
          running: r.running,
          succeeded: r.succeeded,
          failed: r.failed,
          awaitingValidation: r.awaiting,
          liveSessionId: null,
        },
      ]),
    );
    // Live interactive sessions linked to cards (newest wins) power the board's "live" badge.
    const sessions = this.db
      .prepare(
        `SELECT id, card_id FROM agent_sessions
          WHERE project_id = ? AND card_id IS NOT NULL AND desired_state = 'running'
          ORDER BY id`,
      )
      .all(projectId) as { id: number; card_id: number }[];
    for (const row of sessions) {
      if (!this.live.has(`session:${row.id}`)) continue;
      const summary = summaries.get(row.card_id) ?? {
        cardId: row.card_id,
        running: 0,
        succeeded: 0,
        failed: 0,
        awaitingValidation: 0,
        liveSessionId: null,
      };
      summary.liveSessionId = row.id;
      summaries.set(row.card_id, summary);
    }
    return [...summaries.values()];
  }

  /** Push a card to an AI CLI: spawns a one-shot run and moves the card to In progress. */
  async dispatchCard(
    projectId: number,
    cardId: number,
    input: {
      providerId?: string;
      command?: string[];
      prompt?: string;
      timeoutMin?: number;
      maxAttempts?: number;
      autonomy?: AgentAutonomy;
      dispatchKey?: string;
      orchestratorId?: string;
      /** Extra context for the default prompt (e.g. what the orchestrator knows, PM-70). */
      context?: string;
      /** Internal scheduler fence, evaluated synchronously immediately before insertion. */
      canCommit?: () => boolean;
    },
  ): Promise<AgentRun> {
    const project = getProjectRow(this.db, projectId);
    if (!project) throw new AgentError(404, 'Project not found');
    const card = getCard(this.db, cardId);
    if (!card || card.projectId !== projectId) throw new AgentError(404, 'Card not found');
    const existingDispatch = () =>
      input.dispatchKey
        ? (this.db
            .prepare('SELECT * FROM agent_runs WHERE dispatch_key = ?')
            .get(input.dispatchKey) as unknown as RunRow | undefined)
        : undefined;
    const existing = existingDispatch();
    if (existing) {
      if (existing.project_id !== projectId || existing.card_id !== cardId)
        throw new AgentError(409, 'Dispatch key belongs to another task');
      return this.toRun(existing);
    }
    const running = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_runs WHERE project_id = ? AND status IN ('queued', 'running')`,
        )
        .get(projectId) as { n: number }
    ).n;
    if (running >= MAX_RUNNING_RUNS_PER_PROJECT) {
      throw new AgentError(
        409,
        `Too many active runs (${MAX_RUNNING_RUNS_PER_PROJECT} per project)`,
      );
    }

    const providerId = input.providerId ?? (input.command ? 'custom' : 'claude');
    const provider = getProvider(providerId);
    if (!provider) throw new AgentError(400, `Unknown provider: ${providerId}`);
    if (provider.binary && !(await providerAvailable(providerId))) {
      throw new AgentError(
        400,
        `${provider.name} is not on PATH${provider.installUrl ? ` — install: ${provider.installUrl}` : ''}`,
      );
    }
    if (
      (providerId === 'shell' || (provider.binary && provider.argsTemplate.length === 0)) &&
      !input.command
    ) {
      throw new AgentError(400, `${provider.name} needs an explicit command for a one-shot run`);
    }
    const prompt = this.withImages(
      input.prompt ??
        defaultPrompt(card.key, card.title, card.description, input.context, card.issueUrl),
      card.id,
      providerId,
    ).slice(0, 20_000);
    if (!prompt.trim()) throw new AgentError(400, 'Prompt is empty');
    const autonomy = input.autonomy ?? 'edit';
    if (!input.command && !supportsAutonomy(provider, autonomy)) {
      throw new AgentError(400, `${provider.name} has no "${autonomy}" mode`);
    }
    const command = input.command
      ? validateCommand(input.command)
      : buildDispatchArgv(provider, prompt, autonomy, this.imagePaths(card.id));
    if (command.length === 0) throw new AgentError(400, 'Command is empty');
    const timeoutMs =
      input.timeoutMin === undefined ? RUN_DEFAULT_TIMEOUT_MS : input.timeoutMin * 60_000;
    if (!(timeoutMs > 0) || timeoutMs > RUN_MAX_TIMEOUT_MS) {
      throw new AgentError(400, 'timeoutMin must be between 1 and 240');
    }
    const maxAttempts = input.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 10) {
      throw new AgentError(400, 'maxAttempts must be 1–10');
    }

    const repeated = existingDispatch();
    if (repeated) {
      if (repeated.project_id !== projectId || repeated.card_id !== cardId)
        throw new AgentError(409, 'Dispatch key belongs to another task');
      return this.toRun(repeated);
    }
    if (input.canCommit && !input.canCommit())
      throw new AgentError(409, 'Orchestrator ownership or policy changed before dispatch');
    const ts = now();
    const logPath = path.join(
      this.logDir,
      `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`,
    );
    const id = Number(
      this.db
        .prepare(
          `INSERT INTO agent_runs
             (project_id, card_id, name, provider_id, command_json, prompt, status,
              attempts, max_attempts, created_at, log_path, autonomy, dispatch_key, orchestrator_id)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          projectId,
          cardId,
          `${card.key}: ${card.title}`.slice(0, 120),
          providerId,
          JSON.stringify({ command, timeoutMs }),
          prompt,
          maxAttempts,
          ts,
          logPath,
          autonomy,
          input.dispatchKey ?? null,
          input.orchestratorId ?? null,
        ).lastInsertRowid,
    );
    // Dispatching work starts it: backlog/todo cards move to In progress.
    if (card.status === 'backlog' || card.status === 'todo') {
      updateCard(this.db, cardId, { status: 'in_progress' });
    }
    const row = this.db
      .prepare(`SELECT * FROM agent_runs WHERE id = ?`)
      .get(id) as unknown as RunRow;
    void this.spawnRun(row, false);
    return this.toRun(
      this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as unknown as RunRow,
    );
  }

  readRunOutput(id: number, after: number): AgentOutput | null {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as unknown as
      RunRow | undefined;
    if (!row) return null;
    const running = row.status === 'queued' || row.status === 'running';
    return this.readOutput(`run:${id}`, row.log_path, running, row.exit_code, after);
  }

  async stopRun(id: number): Promise<AgentRun | null> {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as unknown as
      RunRow | undefined;
    if (!row) return null;
    const live = this.live.get(`run:${id}`);
    if (live) {
      live.stoppedByUser = true;
      if (live.timer) clearTimeout(live.timer);
      await this.killLive(live);
    } else if (row.status === 'queued' || row.status === 'running') {
      this.db
        .prepare(`UPDATE agent_runs SET status = 'killed', ended_at = ? WHERE id = ?`)
        .run(now(), id);
    }
    return this.getRun(id);
  }

  retryRun(id: number): AgentRun {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as unknown as
      RunRow | undefined;
    if (!row) throw new AgentError(404, 'Run not found');
    if (row.status === 'queued' || row.status === 'running') {
      throw new AgentError(409, 'Run is still active; stop it before retrying');
    }
    const ts = now();
    const logPath = path.join(
      this.logDir,
      `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`,
    );
    const next = Number(
      this.db
        .prepare(
          `INSERT INTO agent_runs
             (project_id, card_id, name, provider_id, command_json, prompt, status,
              attempts, max_attempts, created_at, log_path, autonomy, orchestrator_id)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.project_id,
          row.card_id,
          row.name,
          row.provider_id,
          row.command_json,
          row.prompt,
          row.max_attempts,
          ts,
          logPath,
          row.autonomy,
          row.orchestrator_id,
        ).lastInsertRowid,
    );
    const fresh = this.db
      .prepare(`SELECT * FROM agent_runs WHERE id = ?`)
      .get(next) as unknown as RunRow;
    void this.spawnRun(fresh, false);
    return this.toRun(
      this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(next) as unknown as RunRow,
    );
  }

  /** Validate a finished run and move the linked card through its lifecycle. */
  validateRun(id: number, decision: 'accepted' | 'rejected', moveTo?: CardStatus): AgentRun {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as unknown as
      RunRow | undefined;
    if (!row) throw new AgentError(404, 'Run not found');
    if (row.status !== 'succeeded' && row.status !== 'failed') {
      throw new AgentError(409, 'Only finished runs can be validated');
    }
    if (row.validation) throw new AgentError(409, `Run was already ${row.validation}`);
    const target: CardStatus | null = decision === 'accepted' ? (moveTo ?? 'review') : 'todo';
    if (decision === 'accepted' && moveTo && moveTo !== 'review' && moveTo !== 'done') {
      throw new AgentError(400, "Accepting moves the card to 'review' or 'done'");
    }
    const card = row.card_id ? getCard(this.db, row.card_id) : null;
    if (card) {
      if (decision === 'accepted') {
        // Never drag a card backwards: leave Done cards where they are.
        if (card.status !== 'done' && target) updateCard(this.db, card.id, { status: target });
      } else if (card.status === 'in_progress' || card.status === 'review') {
        updateCard(this.db, card.id, { status: 'todo' });
      }
    }
    this.db
      .prepare(
        `UPDATE agent_runs SET validation = ?, validated_at = ?, validated_move = ? WHERE id = ?`,
      )
      .run(decision, now(), target, id);
    return this.getRun(id)!;
  }

  async removeRun(id: number): Promise<boolean> {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as unknown as
      RunRow | undefined;
    if (!row) return false;
    await this.stopRun(id);
    this.db.prepare(`DELETE FROM agent_runs WHERE id = ?`).run(id);
    this.live.delete(`run:${id}`);
    this.logs.delete(`run:${id}`);
    try {
      removeLog(row.log_path);
    } catch {
      // Best-effort.
    }
    // A deleted run never reaches finishRun, so its slot is handed on here.
    this.startQueuedRuns();
    return true;
  }

  /** Stop everything for a deleted project and drop its logs. */
  async onProjectDeleted(projectId: number): Promise<void> {
    // Queued runs must not take a slot freed by killing this project's live ones.
    this.db
      .prepare(
        `UPDATE agent_runs SET status = 'killed', ended_at = ? WHERE project_id = ? AND status = 'queued'`,
      )
      .run(now(), projectId);
    for (const live of [...this.live.values()]) {
      const rowId = live.id;
      const table = live.kind === 'session' ? 'agent_sessions' : 'agent_runs';
      const row = this.db.prepare(`SELECT project_id FROM ${table} WHERE id = ?`).get(rowId) as
        { project_id: number } | undefined;
      if (row?.project_id === projectId) {
        live.stoppedByUser = true;
        if (live.timer) clearTimeout(live.timer);
        try {
          await this.killLive(live);
        } catch {
          // Already gone.
        }
      }
    }
  }

  /** Graceful shutdown. Hosted sessions keep running in the session host (the next server
      re-attaches); in-process ones are stopped so the next boot can relaunch them cleanly. */
  async shutdown(): Promise<void> {
    this.closed = true;
    clearInterval(this.continuationTimer);
    const installKills = [...this.installing.values()].map(async (live) => {
      if (live.timer) clearTimeout(live.timer);
      try {
        if (live.proc.pid) await killTree(live.proc.pid);
      } catch {
        // Already gone.
      }
    });
    const kills = [...this.live.values()].map(async (live) => {
      if (live.timer) clearTimeout(live.timer);
      if (live.proc instanceof HostedProc) return;
      // If a process was mid-restart-backoff it never spawned: leave the row as
      // 'running' + wanted so the next boot picks it up.
      try {
        await this.killLive(live);
      } catch {
        // Already gone.
      }
    });
    await Promise.allSettled(kills);
    await Promise.allSettled(installKills);
    this.live.clear();
    this.installing.clear();
    this.hosted.clear();
    this.host?.close();
  }

  // ---- Spawning ---------------------------------------------------------------------------------

  private logPathFor(kind: 'session' | 'run', id: number): string {
    return `${kind}:${id}`;
  }

  private outputFor(key: string, file: string): OutputLog {
    let log = this.logs.get(key);
    // Row ids are reused after deletes (no AUTOINCREMENT), so a cached log only counts if it is
    // for the same log file; otherwise a new session would inherit a deleted one's output.
    if (!log || log.file !== file) {
      log = new OutputLog(file, () => this.events.emit(`output:${key}`));
      this.logs.set(key, log);
    }
    return log;
  }

  private log(file: string, text: string): void {
    try {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, text);
    } catch {
      // Best-effort (boot markers must not crash startup).
    }
  }

  private readOutput(
    key: string,
    file: string,
    running: boolean,
    exitCode: number | null,
    after: number,
  ): AgentOutput {
    const cached = this.logs.get(key);
    const log = cached?.file === file ? cached : undefined;
    const safeAfter = Number.isFinite(after) && after >= 0 ? Math.floor(after) : 0;
    if (log) {
      const { data, nextOffset } = log.read(safeAfter);
      return { data, nextOffset, running, exitCode, logBytes: log.totalBytes };
    }
    // No live log (server restarted since): serve the persisted file directly.
    const tmp = new OutputLog(file);
    const { data, nextOffset } = tmp.read(safeAfter);
    const logBytes = Math.max(nextOffset, logicalSize(file));
    return { data, nextOffset, running, exitCode, logBytes };
  }

  private flushInputQueue(sessionId: number, proc: AgentProc): void {
    const queued = this.db
      .prepare(`SELECT id, data FROM agent_input_queue WHERE session_id = ? ORDER BY id`)
      .all(sessionId) as { id: number; data: string }[];
    if (queued.length === 0) return;
    let flushed = 0;
    for (const item of queued) {
      // Strip terminal auto-replies queued by older clients; replaying them would type junk.
      const data = stripTerminalReports(item.data);
      if (data && !proc.write(data)) break;
      flushed++;
    }
    if (flushed > 0) {
      const ids = queued.slice(0, flushed).map((q) => q.id);
      this.db
        .prepare(`DELETE FROM agent_input_queue WHERE id IN (${ids.map(() => '?').join(',')})`)
        .run(...ids);
    }
  }

  private async spawnSession(row: SessionRow, isRelaunch: boolean, byUser = false): Promise<void> {
    const key = this.logPathFor('session', row.id);
    if (this.live.has(key) || this.starting.has(key)) return;
    this.starting.add(key);
    try {
      const { command, env } = JSON.parse(row.command_json) as {
        command: string[];
        env: Record<string, string>;
      };
      // Relaunching prefers the stored resume argv (e.g. `claude --continue`),
      // so an AI conversation picks up instead of starting cold. Shells and
      // custom commands simply respawn.
      let resume = row.resume_json ? (JSON.parse(row.resume_json) as string[]) : null;
      const launch = command;
      const note = (text: string) =>
        this.outputFor(key, row.log_path).append(`
[supervisor] ${text}
`);
      // Each CLI resumes its own conversation where it can say which one it is:
      // - Claude: the id its SessionStart hook last reported (follows /resume, /clear,
      //   compaction). A conversation Claude never saved can't be resumed: start fresh.
      // - Codex: the rollout this session started (~/.codex/sessions), not "the latest".
      // - Others: their "continue latest" flag when no sibling session shares the folder.
      if (isRelaunch && resume && row.provider_id === 'claude') {
        const stale = staleClaudeResume(resume, row.cwd);
        if (stale) {
          if (byUser) {
            throw new AgentError(
              409,
              `Cannot resume Claude conversation ${stale}: its saved transcript is missing. Restart cancelled to preserve the conversation target.`,
            );
          }
          note(`Claude has no saved conversation ${stale} (it was never saved) — starting fresh`);
          resume = null;
        }
      }
      if (isRelaunch && !resume && row.provider_id === 'codex' && command[0] === 'codex') {
        const id = codexSessionFor(row.cwd, row.created_at, this.claimedConversations(row));
        if (id) resume = this.saveResume(row.id, [command[0], 'resume', id]);
      }
      // Grok saves a pinned conversation only once it has one; until then start fresh.
      if (isRelaunch && resume && row.provider_id === 'grok') {
        const id = claudeSessionId(resume);
        if (id && !grokSessionExists(row.cwd, id)) {
          note(`Grok has no saved conversation ${id} yet — starting fresh`);
          resume = null;
        }
      }
      // OpenCode and Antigravity can't be told an id up front: look the conversation up each
      // relaunch (so it follows a conversation switched to inside the CLI), never another
      // session's. Nothing found: their "latest" fallback below, when that is safe.
      if (isRelaunch && row.provider_id === 'opencode' && command[0] === 'opencode') {
        const id = await openCodeSessionFor(
          row.cwd,
          row.created_at,
          this.claimedConversations(row),
        );
        if (id) resume = this.saveResume(row.id, [command[0], '--session', id]);
      }
      if (isRelaunch && row.provider_id === 'antigravity' && command[0] === 'agy') {
        const id = antigravityConversationFor(
          row.cwd,
          row.created_at,
          this.claimedConversations(row),
        );
        if (id) resume = this.saveResume(row.id, [command[0], '--conversation', id]);
      }
      // The last resume attempt died within seconds (e.g. "No conversation found"): start
      // fresh instead of burning the restart budget on the same failure.
      const resumeFailed = !byUser && this.resumeFailed.delete(key);
      if (byUser && this.resumeFailed.has(key)) {
        throw new AgentError(
          409,
          'The saved conversation failed to resume. Restart cancelled rather than starting a fresh conversation. Inspect the terminal log.',
        );
      }
      if (isRelaunch && resumeFailed) note('the last resume failed right away — starting fresh');
      const baseArgv = isRelaunch
        ? resumeFailed
          ? launch
          : (resume ?? this.resumeLatestArgv(row) ?? launch)
        : launch;
      this.lastSpawn.set(key, { at: Date.now(), resumed: baseArgv !== launch, byUser });
      forgetTurn(row.id); // A new process: its hooks report afresh.
      const connection = this.dataDir
        ? boardConnection(
            this.db,
            this.dataDir,
            { kind: 'session', id: row.id, logPath: row.log_path },
            row.provider_id,
            baseArgv,
            env,
          )
        : { command: baseArgv, env };
      // Global / per-CLI permission level (Settings), applied at every launch and relaunch.
      const permitted = withPermissions(
        row.provider_id,
        effectiveLevel(getPermissions(this.db), row.provider_id),
        connection.command,
        connection.env,
      );
      connection.command = permitted.command;
      connection.env = permitted.env;
      const argv = connection.command;
      const log = this.outputFor(key, row.log_path);
      if (isRelaunch) {
        // A killed TUI may leave cursor position, scroll margins and alternate-screen modes
        // active. Reset them before the next process writes into this same output stream.
        if (row.terminal === 'pty') log.append('\x1bc');
        log.append(
          (byUser
            ? '\r\n[supervisor] session started again'
            : `\r\n[supervisor] session relaunched after restart (restart ${row.restarts})`) +
            (baseArgv !== launch ? ' — resuming conversation' : ' — fresh start') +
            `\r\n$ ${argv.join(' ')}\r\n`,
        );
      }

      let proc: AgentProc;
      try {
        const resolved = await resolveArgv(argv);
        const host = row.terminal === 'pty' ? await this.getHost() : null;
        if (host) {
          // Write our banner before the host starts appending: one writer at a time keeps byte
          // offsets exact.
          if (!isRelaunch) log.append(`$ ${argv.join(' ')}\r\n(cd ${row.cwd})\r\n`);
          const info = (await host.request({
            op: 'spawn',
            key: hostKey(row),
            argv: resolved,
            cwd: row.cwd,
            env: processEnv(connection.env),
            cols: this.sessionSizes.get(row.id)?.cols ?? 120,
            rows: this.sessionSizes.get(row.id)?.rows ?? 30,
            logPath: row.log_path,
            maxLogBytes: MAX_LOG_BYTES,
          })) as HostSessionInfo;
          // Shutting down meanwhile: leave it running in the host; the next boot re-attaches.
          if (this.closed) return;
          this.db
            .prepare('UPDATE agent_sessions SET started_at = ? WHERE id = ?')
            .run(now(), row.id);
          this.wireHosted(row, host, info, log);
          return;
        }
        const options = { cwd: row.cwd, env: processEnv(connection.env) };
        proc =
          row.terminal === 'pty' && ptyAvailable()
            ? spawnPty(resolved, options)
            : spawnPipe(resolved, { ...options, stdin: true });
      } catch (e) {
        this.markSessionDead(row.id, `spawn failed: ${(e as Error).message}`);
        return;
      }
      if (this.closed) {
        // Shut down while resolving: don't leave an orphan behind.
        if (proc.pid) await killTree(proc.pid);
        return;
      }
      if (!isRelaunch) log.append(`$ ${argv.join(' ')}\r\n(cd ${row.cwd})\r\n`);

      const live: LiveProc = { proc, log, stoppedByUser: false, kind: 'session', id: row.id };
      this.live.set(key, live);
      void this.limitCpu([proc.pid]);
      this.db
        .prepare(
          `UPDATE agent_sessions SET status = 'running', pid = ?, started_at = ?, ended_at = NULL WHERE id = ?`,
        )
        .run(proc.pid ?? null, now(), row.id);

      proc.onData((text) => log.append(text));
      proc.onError((e) => log.append(`\r\n[process error: ${e.message}]\r\n`));
      proc.onExit((code, signal) => this.onSessionExit(row, key, live, code, signal));

      // Flush stdin queued while the session was down (reboot-proof inbox).
      this.flushInputQueue(row.id, proc);
    } finally {
      this.starting.delete(key);
    }
  }

  private onSessionExit(
    row: SessionRow,
    key: string,
    live: LiveProc,
    code: number | null,
    signal: string | null,
  ): void {
    if (this.live.get(key) === live) this.live.delete(key);
    // After exit markers have been appended, archives need no retained byte window.
    // A replacement process may have started meanwhile; never evict its active cache.
    queueMicrotask(() => {
      if (!this.live.has(key) && this.logs.get(key) === live.log) live.log.releaseCache();
    });
    // Shutdown kills everything: leave the row 'running' + wanted so the next boot relaunches
    // it (reboot-proof by design). The DB may already be closed, so touch nothing.
    if (this.closed) return;
    const id = row.id;
    // Row ids are reused after deletes. If this record was deleted (maybe replaced by a new
    // session with the same id), a late exit must not touch the newcomer: log paths are unique.
    const current = this.getSessionRow(id);
    if (!current || current.log_path !== row.log_path) return;
    const log = live.log;
    if (live.stoppedByUser) {
      this.db
        .prepare(
          `UPDATE agent_sessions SET status = 'killed', exit_code = ?, pid = NULL, ended_at = ? WHERE id = ?`,
        )
        .run(code, now(), id);
      return;
    }
    if (current.desired_state !== 'running') {
      this.db
        .prepare(
          `UPDATE agent_sessions SET status = 'exited', exit_code = ?, pid = NULL, ended_at = ? WHERE id = ?`,
        )
        .run(code, now(), id);
      return;
    }
    const spawned = this.lastSpawn.get(key);
    if (spawned?.resumed && code !== 0 && Date.now() - spawned.at < RESUME_FAIL_MS) {
      this.resumeFailed.add(key);
      if (spawned.byUser) {
        const error =
          'The saved conversation failed to resume. Kept the conversation target; inspect the terminal log before retrying.';
        this.restarting.set(id, { phase: 'failed', since: Date.now(), error });
        this.db.prepare("UPDATE agent_sessions SET desired_state = 'stopped' WHERE id = ?").run(id);
        this.markSessionDead(id, error);
        return;
      }
    }
    if (current.supervise && current.restarts < MAX_RESTARTS) {
      const restarts = current.restarts + 1;
      const delay = Math.min(RESTART_BASE_MS * 2 ** Math.min(restarts - 1, 5), RESTART_CAP_MS);
      log.append(
        `\r\n[supervisor] process exited (code ${code ?? signal}) — relaunching in ${(delay / 1000).toFixed(0)}s (restart ${restarts}/${MAX_RESTARTS})\r\n`,
      );
      this.db
        .prepare(`UPDATE agent_sessions SET restarts = ?, last_restart_at = ? WHERE id = ?`)
        .run(restarts, now(), id);
      const timer = setTimeout(() => {
        const fresh = this.getSessionRow(id);
        if (
          fresh &&
          fresh.log_path === row.log_path &&
          fresh.desired_state === 'running' &&
          !this.closed
        ) {
          this.spawnSession(fresh, true).catch((e) => this.markSessionDead(id, String(e)));
        }
      }, delay);
      timer.unref?.();
      live.timer = timer;
      return;
    }
    if (current.supervise && current.restarts >= MAX_RESTARTS) {
      log.append(
        `\r\n[supervisor] restart budget exhausted (${MAX_RESTARTS}) — leaving session down; press Start to retry\r\n`,
      );
    }
    this.db
      .prepare(
        `UPDATE agent_sessions SET status = 'exited', exit_code = ?, pid = NULL, ended_at = ? WHERE id = ?`,
      )
      .run(code, now(), id);
  }

  /** Conversation ids other sessions of this CLI already resume (never take one of those). */
  private claimedConversations(row: SessionRow): Set<string> {
    return new Set(
      (
        this.db
          .prepare(
            `SELECT resume_json FROM agent_sessions WHERE provider_id = ? AND id != ? AND resume_json IS NOT NULL`,
          )
          .all(row.provider_id, row.id) as { resume_json: string }[]
      ).flatMap((r) => (JSON.parse(r.resume_json) as string[]).slice(-1)),
    );
  }

  private saveResume(id: number, resume: string[]): string[] {
    this.db
      .prepare('UPDATE agent_sessions SET resume_json = ? WHERE id = ?')
      .run(JSON.stringify(resume), id);
    return resume;
  }

  // ---- Names, in sync with the CLIs' own (/rename) ----------------------------------------
  // App -> CLI: a name chosen at creation goes in as a launch flag (Claude --name) or, like any
  // rename here, is typed into the CLI as `/rename <name>` once it is idle (kept in settings
  // until then, so it survives restarts). CLI -> app: a /rename made in the CLI (Claude's
  // transcript, Codex's session index, Grok's manual title) renames the session here. Automatic
  // titles never do. While a rename from here is pending, the CLI's old name is ignored.

  /** Keeps names in sync every `intervalMs` (server/index.ts). */
  syncTitlesPeriodically(intervalMs = 10_000): void {
    const timer = setInterval(() => {
      try {
        this.syncTitles();
      } catch (e) {
        console.error('[agents] name sync failed:', e);
      }
    }, intervalMs);
    timer.unref();
  }

  syncTitles(now = Date.now()): void {
    const rows = this.db
      .prepare(
        `SELECT * FROM agent_sessions WHERE status = 'running' AND provider_id IN ('claude', 'codex', 'grok')`,
      )
      .all() as unknown as SessionRow[];
    for (const row of rows) {
      if (!this.live.has(`session:${row.id}`)) continue;
      const pending = getSetting<string>(this.db, renameKey(row.id));
      if (pending) {
        if (!this.readyForCommand(row, now)) continue;
        // One line of plain text: control characters could end the paste or send keys.
        const clean = [...pending]
          .map((ch) => (ch < ' ' || ch === '\x7f' ? ' ' : ch))
          .join('')
          .trim();
        this.sendInput(row.id, `\x1b[200~/rename ${clean}\x1b[201~\r`, false);
        setSetting(this.db, seenTitleKey(row.id), pending);
        deleteSetting(this.db, renameKey(row.id));
        continue;
      }
      const id = this.conversationOf(row);
      const title = id ? this.cliTitle(row, id) : null;
      if (!title || title === getSetting<string>(this.db, seenTitleKey(row.id))) continue;
      setSetting(this.db, seenTitleKey(row.id), title);
      if (title !== row.name) {
        this.db
          .prepare('UPDATE agent_sessions SET name = ? WHERE id = ?')
          .run(title.slice(0, 80), row.id);
      }
    }
  }

  /** At its prompt with nothing running: safe to type a command without interrupting work. */
  private readyForCommand(row: SessionRow, now: number): boolean {
    const session = this.toSession(row);
    if (session.tailState === 'idle') return true;
    // Unknown (no hook yet, no clear prompt): quiet for 20s counts as idle.
    const last = session.lastOutputAt ? Date.parse(session.lastOutputAt) : 0;
    return session.tailState === null && now - last > 20_000;
  }

  /** The CLI conversation a running session is in (Codex: found once, then remembered). */
  private conversationOf(row: SessionRow): string | null {
    const resume = row.resume_json ? (JSON.parse(row.resume_json) as string[]) : null;
    const { command } = JSON.parse(row.command_json) as { command: string[] };
    if (row.provider_id !== 'codex') return claudeSessionId(resume, command);
    if (resume?.[1] === 'resume' && resume[2] && resume[2] !== '--last') return resume[2];
    if (command[0] !== 'codex') return null;
    const id = codexSessionFor(row.cwd, row.created_at, this.claimedConversations(row));
    if (id) this.saveResume(row.id, [command[0], 'resume', id]);
    return id;
  }

  private cliTitle(row: SessionRow, id: string): string | null {
    if (row.provider_id === 'claude') return claudeCustomTitle(row.cwd, id);
    if (row.provider_id === 'codex') return codexThreadName(id);
    return grokManualTitle(row.cwd, id);
  }

  /**
   * For CLIs that can only "resume the latest conversation" (Codex, OpenCode, Antigravity): that is the
   * right conversation only if this is the sole session of that CLI in the folder. Otherwise
   * (or for explicit commands) relaunch fresh rather than risk resuming another pane's chat.
   */
  private resumeLatestArgv(row: SessionRow): string[] | null {
    const provider = getProvider(row.provider_id);
    if (!provider?.binary || !provider.resumeLatestArgs) return null;
    const { command } = JSON.parse(row.command_json) as { command: string[] };
    if (command[0] !== provider.binary) return null; // A custom command line: don't guess.
    const siblings = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_sessions
            WHERE provider_id = ? AND cwd = ? AND id != ? AND desired_state = 'running'`,
        )
        .get(row.provider_id, row.cwd, row.id) as { n: number }
    ).n;
    return siblings === 0 ? [provider.binary, ...provider.resumeLatestArgs] : null;
  }

  private markSessionDead(id: number, error: string): void {
    const row = this.getSessionRow(id);
    if (row) {
      this.outputFor(`session:${id}`, row.log_path).append(
        `\r\n[supervisor] session could not start: ${error}\r\n`,
      );
    }
    this.db
      .prepare(`UPDATE agent_sessions SET status = 'dead', pid = NULL, ended_at = ? WHERE id = ?`)
      .run(now(), id);
  }

  /** Runs holding a slot: live, or between the spawn decision and the process start. */
  private activeRuns(): number {
    let n = 0;
    for (const live of this.live.values()) if (live.kind === 'run') n++;
    for (const key of this.starting) if (key.startsWith('run:')) n++;
    return n;
  }

  /** Starts queued runs, oldest first, while slots are free. */
  private startQueuedRuns(): void {
    if (this.closed) return;
    const queued = this.db
      .prepare(`SELECT * FROM agent_runs WHERE status = 'queued' ORDER BY id`)
      .all() as unknown as RunRow[];
    for (const row of queued) {
      if (this.activeRuns() >= this.maxParallelRuns) return;
      void this.spawnRun(row, row.attempts > 0);
    }
  }

  private async spawnRun(row: RunRow, isRelaunch: boolean): Promise<void> {
    const key = this.logPathFor('run', row.id);
    if (this.live.has(key) || this.starting.has(key)) return;
    // Everything up to `starting.add` is synchronous, so concurrent callers count each other.
    const busy = this.activeRuns();
    if (busy >= this.maxParallelRuns) {
      // A run relaunched after a restart is 'running' in the database until it gets a slot.
      this.db
        .prepare(`UPDATE agent_runs SET status = 'queued' WHERE id = ? AND status = 'running'`)
        .run(row.id);
      this.outputFor(key, row.log_path).append(
        `[supervisor] queued: ${busy} of ${this.maxParallelRuns} parallel runs are busy; starts when one finishes\n`,
      );
      return;
    }
    this.starting.add(key);
    try {
      const { command, timeoutMs } = JSON.parse(row.command_json) as {
        command: string[];
        timeoutMs: number;
      };
      const project = getProjectRow(this.db, row.project_id);
      const cwd = project?.path ?? process.cwd();
      const log = this.outputFor(key, row.log_path);

      let proc: AgentProc;
      let before: Awaited<ReturnType<typeof snapshotTree>> = null;
      try {
        const connection = this.dataDir
          ? boardConnection(
              this.db,
              this.dataDir,
              { kind: 'run', id: row.id, logPath: row.log_path },
              row.provider_id,
              command,
              {},
            )
          : { command, env: {} };
        const resolved = await resolveArgv(connection.command);
        // Snapshot the work tree so validation can show what the agent actually changed.
        before = await snapshotTree(cwd);
        proc = spawnPipe(resolved, { cwd, env: processEnv(connection.env), stdin: false });
      } catch (e) {
        log.append(`\n[supervisor] could not start: ${(e as Error).message}\n`);
        this.finishRun(row, 'failed', null, `spawn failed: ${(e as Error).message}`);
        return;
      }
      if (this.closed) {
        if (proc.pid) await killTree(proc.pid);
        return;
      }
      const attempts = row.attempts + 1;
      this.db
        .prepare(
          `UPDATE agent_runs SET status = 'running', started_at = ?, attempts = ? WHERE id = ?`,
        )
        .run(now(), attempts, row.id);
      if (!isRelaunch) log.append(`$ ${command.join(' ')}\n(cd ${cwd})\n`);

      const live: LiveProc = { proc, log, stoppedByUser: false, kind: 'run', id: row.id };
      this.live.set(key, live);
      void this.limitCpu([proc.pid]);
      let timedOut = false;
      const minutes = Math.round(timeoutMs / 60000);
      const timer = setTimeout(() => {
        if (!this.live.has(key)) return;
        timedOut = true;
        log.append(`\n[supervisor] timed out after ${minutes}m — killing\n`);
        if (proc.pid) killTree(proc.pid).catch(() => undefined);
      }, timeoutMs);
      timer.unref?.();
      live.timer = timer;

      proc.onData((text) => log.append(text));
      proc.onError((e) => log.append(`\n[process error: ${e.message}]\n`));
      proc.onExit((code) => {
        clearTimeout(timer);
        if (this.live.get(key) === live) this.live.delete(key);
        // Shutdown kills everything: leave wanted rows alone so the next boot relaunches them.
        if (this.closed) return;
        const current = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(row.id) as
          RunRow | undefined;
        if (!current || current.log_path !== row.log_path) return; // Deleted (id maybe reused).
        if (current.status !== 'running' && current.status !== 'queued') return;
        const changes = before ? diffSince(cwd, before).catch(() => null) : Promise.resolve(null);
        void changes.then((diff) => {
          if (live.stoppedByUser) {
            this.finishRun(row, 'killed', code, null, diff);
          } else if (timedOut) {
            this.finishRun(row, 'failed', code, `Timed out after ${minutes}m`, diff);
          } else if (code === 0) {
            const untouched = diff !== null && diff.files.length === 0 && diff.commits === 0;
            log.append(
              untouched && current.autonomy !== 'read'
                ? `\n[run exited 0 but changed no files — read the output before accepting]\n`
                : `\n[run succeeded — awaiting validation]\n`,
            );
            this.finishRun(row, 'succeeded', code, null, diff);
          } else {
            this.finishRun(row, 'failed', code, `Exited with code ${code}`, diff);
          }
        });
      });
    } finally {
      this.starting.delete(key);
      // A start that failed or was abandoned gives its slot to the next queued run.
      if (!this.live.has(key)) this.startQueuedRuns();
    }
  }

  /** Records a run's outcome, only on the run's own record (log paths are unique per run). */
  private finishRun(
    row: { id: number; log_path: string },
    status: AgentRunStatus,
    exitCode: number | null,
    error: string | null,
    changes: RunChanges | null = null,
  ): void {
    if (this.closed) return;
    this.db
      .prepare(
        `UPDATE agent_runs SET status = ?, exit_code = ?, error = ?, ended_at = ?, changes_json = ?
         WHERE id = ? AND log_path = ?`,
      )
      .run(
        status,
        exitCode,
        error,
        now(),
        changes ? JSON.stringify(changes) : null,
        row.id,
        row.log_path,
      );
    const key = `run:${row.id}`;
    const log = this.logs.get(key);
    if (!this.live.has(key) && log?.file === row.log_path) log.releaseCache();
    this.startQueuedRuns();
  }

  // ---- Installs (Settings: one-click agent CLI installs) ---------------------------------------

  listInstalls(): AgentInstall[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_installs ORDER BY id DESC`)
      .all() as unknown as InstallRow[];
    return rows.map((r) => this.toInstall(r));
  }

  getInstall(id: number): AgentInstall | null {
    const row = this.db.prepare(`SELECT * FROM agent_installs WHERE id = ?`).get(id) as
      unknown | undefined;
    if (!row) return null;
    return this.toInstall(row as InstallRow);
  }

  readInstallOutput(id: number, after: number): AgentOutput | null {
    const row = this.db.prepare(`SELECT * FROM agent_installs WHERE id = ?`).get(id) as
      unknown | undefined;
    if (!row) return null;
    const typed = row as InstallRow;
    const running = typed.status === 'running';
    return this.readOutput(`install:${id}`, typed.log_path, running, typed.exit_code, after);
  }

  /** Starts an install with the catalog recipe (or a test override). Never relaunches. */
  async startInstall(providerId: string): Promise<AgentInstall> {
    const provider = getProvider(providerId);
    if (!provider) throw new AgentError(404, `Unknown provider: ${providerId}`);
    const recipe = this.installRecipes[providerId] ?? recipeFor(provider);
    if (!recipe) throw new AgentError(400, `${provider.name} has no automatic install`);
    // No "already installed" rejection: vendor installers are idempotent, so reinstalling is a
    // legitimate repair. The UI only offers Install for missing CLIs.
    const active = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS n FROM agent_installs WHERE provider_id = ? AND status = 'running'`,
        )
        .get(providerId) as { n: number }
    ).n;
    if (active > 0 || this.installStarting.has(providerId)) {
      throw new AgentError(409, `Install of ${provider.name} is already running`);
    }
    this.installStarting.add(providerId);
    try {
      const ts = now();
      const logPath = path.join(
        this.logDir,
        `install-${providerId}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`,
      );
      const id = Number(
        this.db
          .prepare(
            `INSERT INTO agent_installs
               (provider_id, name, created_at, started_at, log_path)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(providerId, `Install ${provider.name}`, ts, ts, logPath).lastInsertRowid,
      );
      const label =
        recipe.kind === 'command'
          ? `$ ${recipe.command!.join(' ')}`
          : `Install script: ${recipe.scriptUrl}`;
      this.log(logPath, `${label}\n(${recipe.detail} Source: ${recipe.docUrl})\n\n`);
      await this.spawnInstall(id, recipe);
      return this.getInstall(id)!;
    } finally {
      this.installStarting.delete(providerId);
    }
  }

  private async spawnInstall(id: number, recipe: InstallRecipe): Promise<void> {
    const row = this.db
      .prepare(`SELECT * FROM agent_installs WHERE id = ?`)
      .get(id) as unknown as InstallRow;
    const key = `install:${id}`;
    const log = this.outputFor(key, row.log_path);
    const finish = (status: AgentInstallStatus, exitCode: number | null, error: string | null) => {
      this.installing.delete(id);
      this.db
        .prepare(
          `UPDATE agent_installs SET status = ?, exit_code = ?, error = ?, ended_at = ? WHERE id = ? AND log_path = ?`,
        )
        .run(status, exitCode, error, now(), id, row.log_path);
    };

    let proc: ChildProcess;
    try {
      if (recipe.kind === 'command') {
        const resolved = await resolveArgv(recipe.command!);
        proc = spawn(resolved[0]!, resolved.slice(1), {
          cwd: os.tmpdir(),
          env: processEnv(),
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
        });
      } else {
        const script = await fetchScript(recipe.scriptUrl!);
        const resolved = await resolveArgv(recipe.interpreter!);
        proc = spawn(resolved[0]!, resolved.slice(1), {
          cwd: os.tmpdir(),
          env: processEnv(),
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: true,
          windowsHide: true,
        });
        // Installers read to EOF: close stdin after handing over the script.
        proc.stdin!.write(script);
        proc.stdin!.end();
      }
    } catch (e) {
      log.append(`\n[supervisor] could not start install: ${(e as Error).message}\n`);
      finish('failed', null, `Could not start install: ${(e as Error).message}`);
      return;
    }
    if (this.closed) {
      if (proc.pid) await killTree(proc.pid);
      return;
    }
    const live: InstallProc = { proc, log, stoppedByUser: false };
    this.installing.set(id, live);
    const timer = setTimeout(() => {
      if (!this.installing.has(id)) return;
      log.append(`\n[supervisor] install timed out — killing\n`);
      if (proc.pid) killTree(proc.pid).catch(() => undefined);
    }, INSTALL_TIMEOUT_MS);
    timer.unref?.();
    live.timer = timer;

    proc.stdout!.on('data', (d: Buffer) => log.append(d.toString('utf8')));
    proc.stderr!.on('data', (d: Buffer) => log.append(d.toString('utf8')));
    proc.on('error', (e) => log.append(`\n[process error: ${e.message}]\n`));
    proc.on('exit', (code) => {
      clearTimeout(timer);
      if (this.installing.get(id) !== live) return;
      this.installing.delete(id);
      if (this.closed) return;
      const current = this.db
        .prepare(`SELECT * FROM agent_installs WHERE id = ?`)
        .get(id) as unknown as InstallRow | undefined;
      if (!current || current.log_path !== row.log_path || current.status !== 'running') return;
      if (live.stoppedByUser) {
        finish('killed', code, null);
      } else if (code === 0) {
        log.append(`\n[install finished — re-checking PATH]\n`);
        finish('succeeded', code, null);
      } else {
        finish('failed', code, `Installer exited with code ${code}`);
      }
    });
  }

  async cancelInstall(id: number): Promise<AgentInstall | null> {
    const row = this.db.prepare(`SELECT * FROM agent_installs WHERE id = ?`).get(id) as unknown as
      InstallRow | undefined;
    if (!row) return null;
    const live = this.installing.get(id);
    if (live) {
      live.stoppedByUser = true;
      if (live.timer) clearTimeout(live.timer);
      if (live.proc.pid) await killTree(live.proc.pid);
    } else if (row.status === 'running') {
      this.db
        .prepare(`UPDATE agent_installs SET status = 'killed', ended_at = ? WHERE id = ?`)
        .run(now(), id);
    }
    return this.getInstall(id);
  }

  async removeInstall(id: number): Promise<boolean> {
    const row = this.db.prepare(`SELECT * FROM agent_installs WHERE id = ?`).get(id) as unknown as
      InstallRow | undefined;
    if (!row) return false;
    await this.cancelInstall(id);
    this.db.prepare(`DELETE FROM agent_installs WHERE id = ?`).run(id);
    try {
      removeLog(row.log_path);
    } catch {
      // Best-effort.
    }
    return true;
  }

  private toInstall(row: InstallRow): AgentInstall {
    const live = this.installing.get(row.id);
    const provider = getProvider(row.provider_id);
    return {
      id: row.id,
      providerId: row.provider_id,
      providerName: provider?.name ?? row.provider_id,
      status: row.status,
      exitCode: row.exit_code,
      error: row.error,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      logBytes: live ? live.log.totalBytes : this.fileSize(row.log_path),
    };
  }

  // ---- Row mapping --------------------------------------------------------------------------------

  private getSessionRow(id: number): SessionRow | null {
    return (
      (this.db.prepare(`SELECT * FROM agent_sessions WHERE id = ?`).get(id) as unknown as
        SessionRow | undefined) ?? null
    );
  }

  private queuedInputBytes(sessionId: number): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM agent_input_queue WHERE session_id = ?`,
      )
      .get(sessionId) as { bytes: number };
    return row.bytes;
  }

  private toSession(row: SessionRow): AgentSession {
    const { command } = JSON.parse(row.command_json) as { command: string[] };
    const live = this.live.get(`session:${row.id}`);
    const { size: diskLogBytes, mtime: lastOutputAt } = this.fileStat(row.log_path);
    const progress = this.restarting.get(row.id);
    if (progress?.phase === 'restoring') {
      const activity = this.sessionActivity(row, lastOutputAt);
      const hasOutputSince = !!lastOutputAt && Date.parse(lastOutputAt) >= progress.since;
      if (
        (hasOutputSince &&
          (activity === 'idle' || activity === 'input' || activity === 'running')) ||
        (live && hasOutputSince && Date.now() - progress.since > 5_000)
      ) {
        this.restarting.delete(row.id);
      } else if (!live && Date.now() - progress.since > 10_000) {
        progress.phase = 'failed';
        progress.error = 'CLI exited shortly after launch. Inspect the terminal before retrying.';
      } else if (Date.now() - progress.since > 60_000) {
        if (live) {
          this.restarting.delete(row.id);
        } else {
          progress.phase = 'failed';
          progress.error =
            'CLI readiness could not be confirmed. Inspect the terminal before retrying.';
        }
      }
    } else if (progress?.phase === 'failed' && (live || row.status === 'running')) {
      // The session process is alive and running; clear stale restart failure.
      this.restarting.delete(row.id);
    }
    return {
      restartProgress: this.restarting.get(row.id)?.phase ?? null,
      restartError: this.restarting.get(row.id)?.error ?? null,
      autoContinue: getSetting(this.db, `session-auto-continue:${row.id}`) ?? {
        enabled: false,
        resumesAt: null,
        message: '',
      },
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      providerId: row.provider_id,
      command,
      cwd: row.cwd,
      terminal: row.terminal,
      cardId: row.card_id,
      cardKey: row.card_id ? (getCard(this.db, row.card_id)?.key ?? null) : null,
      orchestratorId: row.orchestrator_id ?? null,
      lastInputAt: row.last_input_at ?? null,
      pid: live?.proc.pid ?? row.pid,
      status: live ? 'running' : row.status,
      exitCode: row.exit_code,
      desiredState: row.desired_state,
      supervise: row.supervise === 1,
      resumeSupported: row.resume_json !== null,
      restarts: row.restarts,
      lastRestartAt: row.last_restart_at,
      queuedInputBytes: this.queuedInputBytes(row.id),
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      logBytes: live ? live.log.totalBytes : diskLogBytes,
      lastOutputAt,
      tailState: row.status === 'running' || live ? this.sessionActivity(row, lastOutputAt) : null,
    };
  }

  private toRun(row: RunRow, projectedCardKey?: string | null): AgentRun {
    const { command } = JSON.parse(row.command_json) as { command: string[] };
    const live = this.live.get(`run:${row.id}`);
    let cardKey: string | null = projectedCardKey ?? null;
    if (projectedCardKey === undefined && row.card_id) {
      const card = getCard(this.db, row.card_id);
      if (card) cardKey = card.key;
    }
    return {
      id: row.id,
      orchestratorId: row.orchestrator_id ?? null,
      projectId: row.project_id,
      cardId: row.card_id,
      cardKey,
      name: row.name,
      providerId: row.provider_id,
      command,
      prompt: row.prompt,
      autonomy: row.autonomy,
      changes: row.changes_json ? (JSON.parse(row.changes_json) as RunChanges) : null,
      status: row.status,
      exitCode: row.exit_code,
      error: row.error,
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      validation: row.validation,
      validatedAt: row.validated_at,
      validatedMove: row.validated_move,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      logBytes: live ? live.log.totalBytes : this.fileSize(row.log_path),
    };
  }

  /** Log size as a logical offset (includes bytes compacted away) and last modification. */
  private fileStat(file: string): { size: number; mtime: string | null } {
    try {
      const st = statSync(file);
      return { size: logBase(file) + st.size, mtime: st.mtime.toISOString() };
    } catch {
      return { size: 0, mtime: null };
    }
  }

  /** When the log last grew: the session's last output (the host writes the log itself). */
  private fileModifiedAt(file: string): string | null {
    return this.fileStat(file).mtime;
  }

  /**
   * What a live session is doing (PM-14, PM-47). In order:
   * 1. A choice on screen (option list, "Enter to confirm") needs your input.
   * 2. A working line with output in the last few seconds is running, whatever the hooks last
   *    said (hooks miss some turns, e.g. a queued prompt or a turn after a tool approval).
   * 3. Claude's hooks (exact turn state), else the screen, else null (recency decides).
   */
  private sessionActivity(row: SessionRow, lastOutputAt: string | null): AgentSession['tailState'] {
    const tail = this.logTail(row.log_path);
    const screen = tail ? tailState(tail) : null;
    if (screen === 'input') return 'input';
    const fresh = !!lastOutputAt && Date.now() - Date.parse(lastOutputAt) < FRESH_OUTPUT_MS;
    // 1. Busy CLIs rewrite only the changing bits (spinner frames, timer digits): fresh output
    //    that is that animation means working (PM-67, PM-78).
    if (fresh && tail && animatingInTail(tail)) return 'running';
    // Background agents / shells still working after the main turn ended (PM-104): Claude's
    // Stop hook would say idle, but their timers keep ticking on screen.
    if (fresh && tail && backgroundInTail(tail)) return 'running';
    // 2. Output right after your own keystrokes is their echo in the input box, not work.
    const key = this.lastKeystroke.get(row.id);
    const out = lastOutputAt ? Date.parse(lastOutputAt) : 0;
    if (fresh && key && out >= key - 250 && out - key <= ECHO_WINDOW_MS) {
      return turnState(row.id, lastOutputAt) === 'input' ? 'input' : 'idle';
    }
    // 3. A full busy-line timer: moving means working. Frozen means stopped only when nothing
    //    new is arriving: while output flows, the full line on screen goes stale as the CLI
    //    rewrites just its digits, so it can look frozen while the real timer ticks.
    const timer = tail ? elapsedTimer(tail) : null;
    const ticking = timerTicking(this.timers, row.id, timer);
    if (ticking === true) return 'running';
    if (ticking === false && !fresh) return 'idle';
    // 4. A busy line with fresh output (first sighting, or digits ticking in place).
    if (fresh && tail && workingInTail(tail)) return 'running';
    return turnState(row.id, lastOutputAt) ?? screen;
  }

  /** Provider and resume argv of a session, for its chat view's transcript (mobile). */
  sessionResume(id: number): { providerId: string; resumeJson: string | null } | null {
    const row = this.getSessionRow(id);
    return row ? { providerId: row.provider_id, resumeJson: row.resume_json } : null;
  }

  /**
   * What a session's screen shows, as plain text (blank runs folded), for its chat view's live
   * panel and orchestrator context such as what an agent waiting for input is asking (PM-70).
   * The log tail is replayed on a screen of the session's size rather than stripped of escapes:
   * stripping ran in-place redraws together, so the spinner read "Roosting… Roosting…" (PM-129).
   */
  sessionScreen(id: number, maxChars = 500): string | null {
    const row = this.getSessionRow(id);
    const tail = row ? this.logTail(row.log_path, SCREEN_TAIL_BYTES) : null;
    if (!tail) return null;
    // Before a viewer reports a size (e.g. after a restart, with only chat views open), the
    // latest size the log records: in the tail, else further back (cached once found).
    const inTail = lastRecordedSize(tail);
    if (inTail) this.recordedSizes.set(id, inTail);
    const size =
      this.sessionSizes.get(id) ??
      this.recordedSizes.get(id) ??
      this.findRecordedSize(id, row!.log_path);
    // Cursor moves only make sense at the size they were drawn for; without one the latest
    // output is shown stripped, as before.
    const lines =
      size && size.cols >= 20 && size.cols <= 500 && size.rows >= 1 && size.rows <= 500
        ? renderScreen(tail, size.cols, size.rows, true)
        : stripTerminal(tail.slice(-4096))
            .split('\n')
            .map((line) => line.replace(/\s+$/, ''));
    const text = lines
      .filter((line, i, all) => line || (i > 0 && all[i - 1]))
      .join('\n')
      .trim();
    return text.slice(-maxChars) || null;
  }

  /**
   * The last size a session log records, reading back from the end in chunks (a long session
   * can go many megabytes between resizes). Null when there is none; remembered once found.
   */
  private findRecordedSize(id: number, file: string): { cols: number; rows: number } | null {
    // Searched once per session: any later size is recorded in the tail, which is read anyway.
    if (this.sizeSearched.has(id)) return null;
    this.sizeSearched.add(id);
    const CHUNK = 1024 * 1024;
    const OVERLAP = 64; // A marker split across two chunks is still found whole.
    try {
      const fd = openSync(file, 'r');
      try {
        let end = fstatSync(fd).size;
        const buf = Buffer.allocUnsafe(CHUNK + OVERLAP);
        for (let read = 0; end > 0 && read < RECORDED_SIZE_SCAN_BYTES; read += CHUNK) {
          const start = Math.max(0, end - CHUNK);
          const len = Math.min(CHUNK + OVERLAP, fstatSync(fd).size - start);
          const n = readSync(fd, buf, 0, len, start);
          const size = lastRecordedSize(buf.subarray(0, n).toString('latin1'));
          if (size) {
            this.recordedSizes.set(id, size);
            return size;
          }
          end = start;
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // Unreadable log: the caller falls back to stripped text.
    }
    return null;
  }

  /** The end of a session log: by default 4 KB (the latest output and a little before it). */
  private logTail(file: string, bytes = 4096): string | null {
    try {
      const fd = openSync(file, 'r');
      try {
        const size = fstatSync(fd).size;
        const len = Math.min(bytes, size);
        if (len === 0) return null;
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = readSync(fd, buf, 0, len, size - len);
        const slice = bytesRead < len ? buf.subarray(0, bytesRead) : buf;
        return slice.toString('utf8');
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  private fileSize(file: string): number {
    return this.fileStat(file).size;
  }
}

// ---- Validation helpers ---------------------------------------------------------------------------

function validateCommand(command: unknown): string[] {
  if (!Array.isArray(command) || command.length === 0 || command.length > 32) {
    throw new AgentError(400, 'command must be a non-empty array (max 32 args)');
  }
  for (const arg of command) {
    if (typeof arg !== 'string' || !arg || Buffer.byteLength(arg) > 8192) {
      throw new AgentError(400, 'command args must be non-empty strings (max 8KB each)');
    }
  }
  return command as string[];
}

function validateEnv(env: unknown): Record<string, string> {
  if (env === undefined) return {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new AgentError(400, 'env must be an object of string to string');
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (typeof v !== 'string' || Buffer.byteLength(v) > 8192) {
      throw new AgentError(400, `env var ${k} must be a string (max 8KB)`);
    }
    out[k] = v;
  }
  return out;
}

function resolveCwd(cwd: string): string {
  if (!path.isAbsolute(cwd)) throw new AgentError(400, 'cwd must be an absolute path');
  try {
    const resolved = realpathSync.native(cwd);
    if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
    return resolved;
  } catch {
    throw new AgentError(400, `Folder not found: ${cwd}`);
  }
}

function defaultPrompt(
  key: string,
  title: string,
  description: string,
  context?: string,
  issueUrl?: string | null,
): string {
  const parts = [
    `Task ${key}: ${title}`,
    description.trim(),
    issueUrl
      ? `Linked GitHub issue: ${issueUrl}. Reference ${key} in commits and PRs. When a PR fully resolves the issue, include Closes ${issueUrl} in its body; otherwise use a non-closing reference.`
      : '',
    context?.trim() ?? '',
    '---',
    'Work in the project root directory (your current working directory).',
    'Implement the task above. When finished, summarise what changed.',
  ];
  return parts.filter(Boolean).join('\n\n');
}
