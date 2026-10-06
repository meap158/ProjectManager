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
  closeSync,
  statSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
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
  getProjectRow,
  getSetting,
  setSetting,
  updateCard,
} from '../store.js';
import { diffSince, snapshotTree } from './gitChanges.js';
import { tailState } from './activity.js';
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

const now = () => new Date().toISOString();

export const MAX_SESSIONS_PER_PROJECT = 8;
export const MAX_RUNNING_RUNS_PER_PROJECT = 3;
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
  text: string;
  bytes: number;
}

/** File-backed, offset-addressed log with a capped in-memory window. */
class OutputLog {
  private chunks: Chunk[] = [];
  private memBytes = 0;
  private baseOffset = 0; // bytes dropped from the head of `chunks`
  private capped = false;
  totalBytes = 0;

  constructor(
    readonly file: string,
    private onAppend?: () => void,
  ) {
    mkdirSync(path.dirname(file), { recursive: true });
    // Continue from what is already on disk, so byte offsets match the file across server
    // restarts (a reconnecting terminal asks for "everything after byte N").
    const size = statSync(file, { throwIfNoEntry: false })?.size ?? 0;
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

  append(text: string): void {
    if (!text || this.capped) return;
    try {
      const size = statSync(this.file, { throwIfNoEntry: false })?.size ?? 0;
      if (size >= MAX_LOG_BYTES) {
        this.capped = true;
        const marker = `\n[log truncated: ${MAX_LOG_BYTES} byte cap reached]\n`;
        appendFileSync(this.file, marker);
        this.push(marker);
        return;
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
    this.chunks.push({ text, bytes });
    this.memBytes += bytes;
    this.totalBytes += bytes;
    while (this.memBytes > MEM_CAP_BYTES && this.chunks.length > 1) {
      const dropped = this.chunks.shift()!;
      this.memBytes -= dropped.bytes;
      this.baseOffset += dropped.bytes;
    }
  }

  /** Read up to MAX_READ_BYTES starting at byte offset `after`. */
  read(after: number): { data: string; nextOffset: number } {
    if (!Number.isFinite(after) || after < 0) after = 0;
    if (after < this.baseOffset) return this.readFile(after);
    // Serve from memory; slice chunks by bytes so multibyte chars never split.
    let skip = after - this.baseOffset;
    const parts: string[] = [];
    let used = 0;
    for (const c of this.chunks) {
      if (used >= MAX_READ_BYTES) break;
      if (skip >= c.bytes) {
        skip -= c.bytes;
        continue;
      }
      const take = Math.min(c.bytes - skip, MAX_READ_BYTES - used);
      parts.push(
        Buffer.from(c.text, 'utf8')
          .subarray(skip, skip + take)
          .toString('utf8'),
      );
      used += take;
      skip = 0;
    }
    const data = parts.join('');
    return { data, nextOffset: after + Buffer.byteLength(data) };
  }

  /** Positioned read straight from the file for ranges that fell out of memory. */
  private readFile(after: number): { data: string; nextOffset: number } {
    try {
      const fd = openSync(this.file, 'r');
      try {
        const size = statSync(this.file).size;
        const start = Math.min(after, size);
        const len = Math.min(MAX_READ_BYTES, size - start);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, start);
        const data = buf.toString('utf8');
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
}

/** CLIs with a /rename command whose names we keep in sync with the session's. */
const RENAMABLE = new Set(['claude', 'codex', 'grok']);
/** A rename made here, waiting until the CLI is idle to be typed in as /rename. */
const renameKey = (id: number) => `session-rename:${id}`;
/** The CLI name last seen or sent, so a change made in the CLI is told apart from ours. */
const seenTitleKey = (id: number) => `session-cli-title:${id}`;

export class AgentSupervisor {
  private live = new Map<string, LiveProc>();
  private logs = new Map<string, OutputLog>();
  /** Keys whose spawn is in flight (argv resolution is async): guards double starts. */
  private starting = new Set<string>();
  /** When each session last spawned and whether that spawn resumed a conversation. */
  private lastSpawn = new Map<string, { at: number; resumed: boolean }>();
  /** Sessions whose last resume died right away: their next relaunch starts fresh. */
  private resumeFailed = new Set<string>();
  private closed = false;
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
    } = {},
  ) {
    mkdirSync(logDir, { recursive: true });
    this.dataDir = options.dataDir ?? null;
    this.installRecipes = options.installRecipes ?? {};
    this.useHost = !!options.host && !!this.dataDir && ptyAvailable();
    this.ready = this.reconcile().catch((e: Error) => {
      console.error('[agents] reconcile failed:', e);
    });
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
      client.on('data', (key, offset, data) => this.hosted.get(key)?.log.ingest(offset, data));
      client.on('exit', (key, code, signal) =>
        this.hosted.get(key)?.proc.deliverExit(code, signal),
      );
      client.on('disconnect', () => this.onHostLost(client));
      return client;
    });
    return this.hostConnecting;
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
        .prepare(`SELECT COUNT(*) AS n FROM agent_sessions WHERE project_id = ?`)
        .get(projectId) as { n: number }
    ).n;
    if (count >= MAX_SESSIONS_PER_PROJECT) {
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
            input.prompt ?? defaultPrompt(card.key, card.title, card.description),
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
            desired_state, supervise, created_at, started_at, log_path, terminal, card_id)
         VALUES (?, ?, ?, ?, ?, ?, 'running', 'running', ?, ?, ?, ?, ?, ?)`,
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
      );
    const id = Number(result.lastInsertRowid);
    // CLIs without a launch flag for the name get it by /rename once they're ready.
    if (chosenName && !explicit && !provider.nameArg && RENAMABLE.has(providerId)) {
      setSetting(this.db, renameKey(id), chosenName);
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
      options.prompt ?? defaultPrompt(card.key, card.title, card.description),
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
  sendInput(id: number, data: string): { queued: boolean; session: AgentSession | null } {
    const row = this.getSessionRow(id);
    if (!row) return { queued: false, session: null };
    if (!data) throw new AgentError(400, 'Input is empty');
    if (Buffer.byteLength(data) > 64 * 1024)
      throw new AgentError(400, 'Input too large (64KB max)');
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
    this.live.get(`session:${id}`)?.proc.resize(cols, rows);
    return true;
  }

  readSessionOutput(id: number, after: number): AgentOutput | null {
    const row = this.getSessionRow(id);
    if (!row) return null;
    return this.readOutput(
      `session:${id}`,
      row.log_path,
      row.status === 'running',
      row.exit_code,
      after,
    );
  }

  async stopSession(id: number): Promise<AgentSession | null> {
    const row = this.getSessionRow(id);
    if (!row) return null;
    this.db.prepare(`UPDATE agent_sessions SET desired_state = 'stopped' WHERE id = ?`).run(id);
    const live = this.live.get(`session:${id}`);
    if (live) {
      live.stoppedByUser = true;
      if (live.timer) clearTimeout(live.timer);
      await this.killLive(live);
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
  async startSession(id: number): Promise<AgentSession> {
    const row = this.getSessionRow(id);
    if (!row) throw new AgentError(404, 'Session not found');
    if (this.live.has(`session:${id}`)) throw new AgentError(409, 'Session is already running');
    this.db
      .prepare(`UPDATE agent_sessions SET desired_state = 'running', restarts = 0 WHERE id = ?`)
      .run(id);
    const fresh = this.getSessionRow(id)!;
    // Starting a stopped session continues its conversation, like a relaunch: launching the
    // original command again would replay its first prompt or reuse a pinned id (which CLIs refuse).
    await this.spawnSession(fresh, true, true).catch((e) => this.markSessionDead(id, String(e)));
    return this.getSession(id)!;
  }

  async removeSession(id: number): Promise<boolean> {
    const row = this.getSessionRow(id);
    if (!row) return false;
    await this.stopSession(id);
    this.db.prepare(`DELETE FROM agent_sessions WHERE id = ?`).run(id);
    deleteSetting(this.db, renameKey(id));
    deleteSetting(this.db, seenTitleKey(id));
    // Forget the record's process and log now: SQLite reuses ids, and a new session with this id
    // must not be mistaken for the old one while the old process is still exiting.
    this.live.delete(`session:${id}`);
    this.logs.delete(`session:${id}`);
    try {
      rmSync(row.log_path, { force: true });
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
    },
  ): Promise<AgentRun> {
    const project = getProjectRow(this.db, projectId);
    if (!project) throw new AgentError(404, 'Project not found');
    const card = getCard(this.db, cardId);
    if (!card || card.projectId !== projectId) throw new AgentError(404, 'Card not found');
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
      input.prompt ?? defaultPrompt(card.key, card.title, card.description),
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
              attempts, max_attempts, created_at, log_path, autonomy)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
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
              attempts, max_attempts, created_at, log_path, autonomy)
           VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
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
      rmSync(row.log_path, { force: true });
    } catch {
      // Best-effort.
    }
    return true;
  }

  /** Stop everything for a deleted project and drop its logs. */
  async onProjectDeleted(projectId: number): Promise<void> {
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
    let logBytes = nextOffset;
    try {
      logBytes = Math.max(nextOffset, statSync(file).size);
    } catch {
      // Missing file: report what we read.
    }
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
      const resumeFailed = this.resumeFailed.delete(key);
      if (isRelaunch && resumeFailed) note('the last resume failed right away — starting fresh');
      const baseArgv = isRelaunch
        ? resumeFailed
          ? launch
          : (resume ?? this.resumeLatestArgv(row) ?? launch)
        : launch;
      this.lastSpawn.set(key, { at: Date.now(), resumed: baseArgv !== launch });
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
            cols: 120,
            rows: 30,
            logPath: row.log_path,
            maxLogBytes: MAX_LOG_BYTES,
          })) as HostSessionInfo;
          // Shutting down meanwhile: leave it running in the host; the next boot re-attaches.
          if (this.closed) return;
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
        this.sendInput(row.id, `\x1b[200~/rename ${clean}\x1b[201~\r`);
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

  private async spawnRun(row: RunRow, isRelaunch: boolean): Promise<void> {
    const key = this.logPathFor('run', row.id);
    if (this.live.has(key) || this.starting.has(key)) return;
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
      rmSync(row.log_path, { force: true });
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
    const lastOutputAt = this.fileModifiedAt(row.log_path);
    return {
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      providerId: row.provider_id,
      command,
      cwd: row.cwd,
      terminal: row.terminal,
      cardId: row.card_id,
      cardKey: row.card_id ? (getCard(this.db, row.card_id)?.key ?? null) : null,
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
      logBytes: live ? live.log.totalBytes : this.fileSize(row.log_path),
      lastOutputAt,
      tailState:
        row.status === 'running' || live
          ? // Claude reports its turns through hooks (exact); others fall back to the screen.
            (turnState(row.id, lastOutputAt) ?? this.sessionTailState(row.log_path))
          : null,
    };
  }

  private toRun(row: RunRow): AgentRun {
    const { command } = JSON.parse(row.command_json) as { command: string[] };
    const live = this.live.get(`run:${row.id}`);
    let cardKey: string | null = null;
    if (row.card_id) {
      const card = getCard(this.db, row.card_id);
      if (card) cardKey = card.key;
    }
    return {
      id: row.id,
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

  /** When the log last grew: the session's last output (the host writes the log itself). */
  private fileModifiedAt(file: string): string | null {
    try {
      return statSync(file).mtime.toISOString();
    } catch {
      return null;
    }
  }

  /** What the last screen frame in the log says (see activity.ts). */
  private sessionTailState(file: string): AgentSession['tailState'] {
    try {
      const fd = openSync(file, 'r');
      try {
        const size = statSync(file).size;
        const len = Math.min(4096, size);
        if (len === 0) return null;
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        return tailState(buf.toString('utf8'));
      } finally {
        closeSync(fd);
      }
    } catch {
      return null;
    }
  }

  private fileSize(file: string): number {
    try {
      return statSync(file).size;
    } catch {
      return 0;
    }
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

function defaultPrompt(key: string, title: string, description: string): string {
  const parts = [
    `Task ${key}: ${title}`,
    description.trim(),
    '---',
    'Work in the project root directory (your current working directory).',
    'Implement the task above. When finished, summarise what changed.',
  ];
  return parts.filter(Boolean).join('\n\n');
}
