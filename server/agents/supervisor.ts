import { readRunRendezvous } from './host/runDaemon.js';
import { RunClient } from './host/runClient.js';
import { budgetedRunArgv } from './host/budgetedRun.js';
import { connectRunHost } from './host/connectRunHost.js';
import { launchManagedRun } from './host/managedRun.js';
import type { PipeRunLaunch } from './host/runLauncher.js';
import { hasManagedExecution, recoverManagedRuns, stopManagedRun } from './host/recoverRuns.js';
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

import { OutputLog, MAX_LOG_BYTES } from './outputLog.js';
export { OutputLog, MAX_LOG_BYTES } from './outputLog.js';
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
  readdirSync,
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
  CodexAccountsState,
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
import { applyCpuBudget, getCpuBudget } from './cpuBudget.js';
import { CpuGovernor, type GovernorStats } from './cpuGovernor.js';
import {
  allowanceReset,
  emptyCodexPrompt,
  mentionsUsageLimit,
  usageLimitShown,
} from './continuation.js';
import { claudeSessionId, codexResumeId, codexSessionFor, staleClaudeResume } from './usage.js';
import { slimResumeImages } from './codexImages.js';
import {
  antigravityConversationFor,
  claudeCustomTitle,
  codexThreadName,
  grokManualTitle,
  grokSessionExists,
  openCodeSessionFor,
} from './conversations.js';
import {
  claudeModeOnScreen,
  effectiveLevel,
  getPermissions,
  withPermissions,
} from './permissions.js';
import { forgetTurn, turnState } from './turnState.js';
import { HostClient } from './host/client.js';
import type { HostSessionInfo } from './host/protocol.js';
import { fetchScript, recipeFor } from './install.js';
import { processEnv, ptyAvailable, spawnPipe, spawnPty, type AgentProc } from './proc.js';
import { projectGitEnv } from '../gitIdentity.js';
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
import { logBase, logicalSize, physicalSize, removeLog } from './logFile.js';
import { ClaudeAccounts, CodexAccountError, CodexAccounts } from './codexAccounts.js';

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

interface SessionBatch {
  autoContinue: Map<number, AgentSession['autoContinue']>;
  queued: Map<number, number>;
  /** The selected Codex login, read once per list (it reads several credential files). */
  codexProfile?: { id: string; name: string; home: string } | null;
  /** Per log folder, the `.base` sidecars present: only compacted logs have one (`fileStat`). */
  baseFiles: Map<string, Set<string>>;
}

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
  execution_state?: 'active' | 'unknown' | 'complete' | null;
  execution_resolution_json?: string | null;
  changes_json: string | null;
  orchestrator_id: string | null;
}

/**
 * How much of a session log its screen is rebuilt from. CLIs repaint only what changed, so the
 * screen needs more than the latest frames; 256 KB covers the last full redraw in practice and
 * replays in a few milliseconds.
 */
const SCREEN_TAIL_BYTES = 256 * 1024;
/** What auto-continue and "Try again" send a Codex session after its usage limit (PM-58). */
const CONTINUE_PROMPT = '\x1b[200~Continue the interrupted task from where you stopped.\x1b[201~\r';
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
  /** Codex sessions whose screen shows the plan usage limit (PM-58), by id. */
  private usageLimits = new Map<number, { resetsAt: string | null }>();
  private logs = new Map<string, OutputLog>();
  /** Keys whose spawn is in flight (argv resolution is async): guards double starts. */
  private starting = new Set<string>();
  private readonly maxParallelRuns: number;
  /** Apply Settings → CPU budget to agent processes (production; tests opt in). */
  private readonly cpuBudget: boolean;
  private cpuGovernor: CpuGovernor | null = null;
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
  private readonly managedRuns: boolean;
  private managedDispatches = new Set<Promise<void>>();
  private managedTimer?: ReturnType<typeof setInterval>;
  private managedPolling: Promise<void> | null = null;
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
  private readonly codexAccounts: CodexAccounts | null;
  private readonly claudeAccounts: ClaudeAccounts | null;
  /**
   * Accounts already tried in the current Codex usage-limit rotation, with when each was left.
   * One list for every Codex CLI. An account drops out once its quota is back (`codexTried`).
   */
  private codexRotationTried = new Map<string, number>();
  private switchingCodexSession = new Set<number>();
  private tailCache = new Map<string, { version: string; tail: string | null }>();
  private limitScreens = new Map<
    number,
    { version: string; lastSeen: string; at: number; screen: string }
  >();
  /**
   * Sessions this process (re)started that have not been sent a message since. A usage limit
   * still on their screen is from before the restart (the old login, PM-243): it would rotate
   * the account again at once. A limit only comes back in reply to a request.
   */
  private noTurnSinceStart = new Set<number>();
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
      /** Opt-in until hosted dispatch crash and platform acceptance gates pass. */
      managedRuns?: boolean;
      dataDir?: string;
      installRecipes?: Partial<Record<string, InstallRecipe>>;
      maxParallelRuns?: number;
      cpuBudget?: boolean;
    } = {},
  ) {
    mkdirSync(logDir, { recursive: true });
    this.dataDir = options.dataDir ?? null;
    this.codexAccounts = this.dataDir ? new CodexAccounts(this.dataDir, db) : null;
    this.claudeAccounts = this.dataDir ? new ClaudeAccounts(this.dataDir, db) : null;
    this.managedRuns = options.managedRuns ?? false;
    this.maxParallelRuns = options.maxParallelRuns ?? MAX_PARALLEL_RUNS;
    this.cpuBudget = options.cpuBudget ?? false;
    // Keeps the whole machine under the budget's threshold by narrowing agents when other load
    // rises (Windows; elsewhere the budget's affinity alone applies).
    if (this.cpuBudget && CpuGovernor.supported()) {
      this.cpuGovernor = new CpuGovernor();
      const budget = getCpuBudget(db);
      this.cpuGovernor.configure({ threads: budget.threads, total: budget.totalThreads });
    }
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
    this.managedTimer = setInterval(() => {
      void this.pollManagedRuns().catch((error: Error) => {
        console.error('[agents] managed recovery:', error);
      });
    }, 2000);
    this.managedTimer.unref();
  }

  refreshCodexAccountsUsage(accountId?: string): Promise<CodexAccountsState> {
    return this.withCodexAccounts((accounts) =>
      accountId ? accounts.refreshAccountUsage(accountId) : accounts.refreshUsage(),
    );
  }

  codexAccountsState(refreshStale = false): CodexAccountsState {
    return this.withCodexAccounts((accounts) => {
      if (refreshStale) accounts.refreshUsageIfStale();
      return accounts.state();
    });
  }

  importCodexAccount(name: string, authJson: string): CodexAccountsState {
    return this.withCodexAccounts((accounts) => accounts.importAccount(name, authJson));
  }

  saveCurrentCodexAccount(name?: string): CodexAccountsState {
    return this.withCodexAccounts((accounts) => accounts.saveCurrentAccount(name));
  }

  renameCodexAccount(id: string, name: string): CodexAccountsState {
    return this.withCodexAccounts((accounts) => accounts.renameAccount(id, name));
  }

  removeCodexAccount(id: string): CodexAccountsState {
    return this.withCodexAccounts((accounts) => accounts.removeAccount(id));
  }

  setActiveCodexAccount(
    id: string | null,
    options: { keepRotation?: boolean; activeOnly?: boolean } = {},
  ): CodexAccountsState {
    const running = this.db
      .prepare("SELECT * FROM agent_sessions WHERE provider_id = 'codex' AND status = 'running'")
      .all() as unknown as SessionRow[];
    for (const row of running) this.pinCodexForRestart(row);
    const state = this.withCodexAccounts((accounts) => accounts.setActive(id));
    // A choice in Settings starts a fresh rotation. Auto-switch keeps the accounts it already tried.
    if (!options.keepRotation) this.codexRotationTried.clear();
    this.applyCodexAccountToSessions(id === null || id === 'default' ? 'default' : id, {
      activeOnly: options.activeOnly,
    });
    return state;
  }

  /**
   * Points every Codex session at the account selected in Settings. There is one Codex login for
   * the whole app: sessions, runs and orchestrator chats do not keep a login of their own.
   * A session whose stored home differs is moved, including one that is mid-turn. A different
   * login keeps the conversation (`carryCodexConversation`), or starts a new one when none can move.
   */
  private applyCodexAccountToSessions(
    targetKey: string,
    options: { exceptId?: number; activeOnly?: boolean } = {},
  ): void {
    const profileId = targetKey === 'default' ? null : targetKey;
    const rows = this.db
      .prepare(`SELECT * FROM agent_sessions WHERE provider_id = 'codex'`)
      .all() as unknown as SessionRow[];
    for (const row of rows) {
      if (row.id === options.exceptId || this.switchingCodexSession.has(row.id)) continue;
      if (options.activeOnly && (row.status !== 'running' || row.desired_state !== 'running'))
        continue;
      const storedKey = this.storedCodexProfile(row)?.id ?? null;
      if (storedKey === targetKey) continue;
      if (storedKey === null && targetKey === 'default') continue;
      const willRestart =
        this.live.has(`session:${row.id}`) ||
        row.desired_state === 'running' ||
        row.status === 'running';
      if (willRestart) this.switchingCodexSession.add(row.id);
      void this.switchSessionCodexAccount(row.id, profileId, {
        continuePrompt: false,
        setGlobal: false,
      }).catch((error: Error) => {
        this.switchingCodexSession.delete(row.id);
        console.error('[agents] codex account switch:', error);
      });
    }
  }

  setCodexAccountOrder(ids: string[]): CodexAccountsState {
    return this.codexAccounts!.setOrder(ids);
  }

  setCodexAccountAutoSwitchEligible(id: string, eligible: boolean) {
    return this.codexAccounts!.setAutoSwitchEligible(id, eligible);
  }

  setCodexAutoSwitch(enabled: boolean): CodexAccountsState {
    return this.withCodexAccounts((accounts) => accounts.setAutoSwitch(enabled));
  }

  claudeAccountsState(): CodexAccountsState {
    return this.withClaudeAccounts((accounts) => accounts.state());
  }

  importClaudeAccount(name: string, authJson: string): CodexAccountsState {
    return this.withClaudeAccounts((accounts) => accounts.importAccount(name, authJson));
  }

  saveCurrentClaudeAccount(name?: string): CodexAccountsState {
    return this.withClaudeAccounts((accounts) => accounts.saveCurrentAccount(name));
  }

  renameClaudeAccount(id: string, name: string): CodexAccountsState {
    return this.withClaudeAccounts((accounts) => accounts.renameAccount(id, name));
  }

  removeClaudeAccount(id: string): CodexAccountsState {
    return this.withClaudeAccounts((accounts) => accounts.removeAccount(id));
  }

  setActiveClaudeAccount(id: string | null): CodexAccountsState {
    return this.withClaudeAccounts((accounts) => accounts.setActive(id));
  }

  setClaudeAutoSwitch(enabled: boolean): CodexAccountsState {
    return this.withClaudeAccounts((accounts) => accounts.setAutoSwitch(enabled));
  }

  /**
   * Switches a Codex session onto another saved login (`null` or `'default'` for the default
   * CODEX_HOME). The session's conversation moves with it: its rollout is copied into the new
   * login's home without the account-sealed reasoning items, and the CLI resumes it there
   * (PM-188). With no rollout to move, a new conversation starts. Restarts the session when it
   * is running.
   */
  async switchSessionCodexAccount(
    id: number,
    profileId: string | null,
    options: {
      continuePrompt?: boolean;
      setGlobal?: boolean;
      keepRotation?: boolean;
      automatic?: boolean;
    } = {},
  ): Promise<AgentSession> {
    const row = this.getSessionRow(id);
    if (!row) throw new AgentError(404, 'Session not found');
    if (row.provider_id !== 'codex')
      throw new AgentError(400, 'Account switching is only supported for Codex sessions');
    const pendingRestart = this.restarting.get(id);
    if (pendingRestart && pendingRestart.phase !== 'failed')
      throw new AgentError(409, 'Restart already in progress');
    if (options.automatic && (row.status !== 'running' || row.desired_state !== 'running'))
      throw new AgentError(409, 'Session ended before automatic account switching.');
    const targetKey = profileId === null || profileId === 'default' ? 'default' : profileId;
    const target = this.withCodexAccounts((accounts) => accounts.profile(targetKey));
    // The login stored on this session, not the Settings selection. Reading the selection after
    // setActive would look like the session was already there, and `codex resume` would keep going.
    const previous = this.storedCodexProfile(row);
    // Every login runs in the default CODEX_HOME; switching changes the auth.json there (PM-243).
    const runHome = this.withCodexAccounts((a) => a.runHome());
    const willRestart =
      this.live.has(`session:${id}`) || row.desired_state === 'running' || row.status === 'running';
    const parsed = JSON.parse(row.command_json) as {
      command: string[];
      env?: Record<string, string>;
      codexAccountId?: string;
      codexFreshStart?: boolean;
    };
    // Where the CLI ran: sessions from before PM-243 may still sit in a saved profile's folder.
    const fromHome = parsed.env?.CODEX_HOME ?? runHome;
    const movedHome = path.resolve(fromHome) !== path.resolve(runHome);
    const switchedAccount = (previous?.id ?? 'default') !== target.id || movedHome;
    const nextEnv = { ...(parsed.env ?? {}), CODEX_HOME: runHome };
    // The conversation stays with the session: same folder, resumed by id after the login
    // changes (as after a manual `codex login`); copied over first when the folder changes.
    // Missing targets cancel the switch rather than silently replacing the conversation.
    const carriedId =
      switchedAccount || willRestart ? this.carryCodexConversation(row, fromHome, runHome) : null;
    if ((switchedAccount || willRestart) && !carriedId) {
      this.switchingCodexSession.delete(id);
      throw new AgentError(
        409,
        'Cannot identify or carry the exact Codex conversation. Account switch cancelled; no fresh conversation was started.',
      );
    }
    if (options.setGlobal !== false) {
      const running = this.db
        .prepare("SELECT * FROM agent_sessions WHERE provider_id = 'codex' AND status = 'running'")
        .all() as unknown as SessionRow[];
      for (const session of running) this.pinCodexForRestart(session);
      this.withCodexAccounts((accounts) =>
        accounts.setActive(target.id === 'default' ? null : target.id),
      );
      if (!options.keepRotation) this.codexRotationTried.clear();
      this.applyCodexAccountToSessions(target.id, { exceptId: id, activeOnly: options.automatic });
    }

    const nextResume = carriedId
      ? JSON.stringify([parsed.command[0] ?? 'codex', 'resume', carriedId])
      : row.resume_json;
    this.db.prepare(`UPDATE agent_sessions SET command_json = ?, resume_json = ? WHERE id = ?`).run(
      JSON.stringify({
        ...parsed,
        env: nextEnv,
        codexAccountId: target.id,
      }),
      nextResume,
      id,
    );
    this.usageLimits.delete(id);
    this.resumeFailed.delete(this.logPathFor('session', id));
    if (!willRestart) {
      this.switchingCodexSession.delete(id);
      return this.getSession(id)!;
    }

    if (willRestart) this.switchingCodexSession.add(id);
    try {
      this.outputFor(`session:${id}`, row.log_path).append(
        switchedAccount
          ? carriedId
            ? `\r\n[supervisor] switching Codex account to ${target.name} — continuing the conversation on the new login\r\n`
            : `\r\n[supervisor] switching Codex account to ${target.name} — starting a new conversation (no saved conversation to carry over)\r\n`
          : `\r\n[supervisor] switching Codex account to ${target.name}\r\n`,
      );
      return await this.restartSession(id, { continuePrompt: options.continuePrompt });
    } finally {
      this.switchingCodexSession.delete(id);
    }
  }

  /**
   * Makes a session's Codex conversation available under another login and returns its id, or
   * null when there is none to carry (never started, or its rollout is gone).
   */
  private carryCodexConversation(row: SessionRow, fromHome: string, toHome: string): string | null {
    if (!this.codexAccounts) return null;
    const resume = row.resume_json ? (JSON.parse(row.resume_json) as string[]) : null;
    const command = (JSON.parse(row.command_json) as { command: string[] }).command;
    const id =
      codexResumeId(resume) ??
      codexResumeId(command) ??
      codexSessionFor(
        row.cwd,
        row.started_at,
        this.claimedConversations(row),
        os.homedir(),
        fromHome,
      );
    if (!id) return null;
    return this.codexAccounts.carryConversation(fromHome, toHome, id) ? id : null;
  }

  /** Resolve before stopping the original process. Missing/ambiguous targets fail closed. */
  private pinCodexForRestart(row: SessionRow): void {
    if (row.provider_id !== 'codex') return;
    const parsed = JSON.parse(row.command_json) as {
      command: string[];
      env?: Record<string, string>;
    };
    if (parsed.command[0] !== 'codex') return;
    const home = parsed.env?.CODEX_HOME ?? this.codexAccounts?.runHome();
    const id = home ? this.carryCodexConversation(row, home, home) : null;
    if (!id)
      throw new AgentError(
        409,
        'Cannot identify the exact saved Codex conversation. Restart cancelled to preserve the current session.',
      );
    this.saveResume(row.id, ['codex', 'resume', id]);
  }

  /** The login recorded on this session. Does not fall back to Settings. */
  private storedCodexProfile(row: SessionRow): { id: string; name: string; home: string } | null {
    if (row.provider_id !== 'codex' || !this.codexAccounts) return null;
    try {
      const parsed = JSON.parse(row.command_json) as {
        env?: Record<string, string>;
        codexAccountId?: string;
      };
      const key =
        parsed.codexAccountId ?? this.codexAccounts.keyForHome(parsed.env?.CODEX_HOME) ?? null;
      if (!key) return null;
      return this.codexAccounts.profile(key);
    } catch {
      return null;
    }
  }

  /** The Codex login from Settings. Every Codex CLI uses this, not a per-session account. */
  private sessionCodexProfile(
    row: SessionRow,
    batch?: SessionBatch,
  ): { id: string; name: string; home: string } | null {
    if (row.provider_id !== 'codex' || !this.codexAccounts) return null;
    if (!batch) return this.codexAccounts.selectedProfile();
    return (batch.codexProfile ??= this.codexAccounts.selectedProfile());
  }

  private withCodexAccounts<T>(run: (accounts: CodexAccounts) => T): T {
    if (!this.codexAccounts)
      throw new AgentError(400, 'Codex accounts require a configured data directory');
    try {
      return run(this.codexAccounts);
    } catch (error) {
      if (error instanceof CodexAccountError) throw new AgentError(error.status, error.message);
      throw error;
    }
  }

  private withClaudeAccounts<T>(run: (accounts: ClaudeAccounts) => T): T {
    if (!this.claudeAccounts)
      throw new AgentError(400, 'Claude accounts require a configured data directory');
    try {
      return run(this.claudeAccounts);
    } catch (error) {
      if (error instanceof CodexAccountError) throw new AgentError(error.status, error.message);
      throw error;
    }
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

  /** The governor's latest measurements (Windows), or null when it isn't running. */
  cpuGovernorStats(): GovernorStats | null {
    return this.cpuGovernor?.latest() ?? null;
  }

  /** Re-applies the CPU budget to every agent process (after the setting changed). */
  async refreshCpuBudget(): Promise<void> {
    const budget = getCpuBudget(this.db);
    this.cpuGovernor?.configure({ threads: budget.threads, total: budget.totalThreads });
    const pids = [...this.live.values()]
      .filter((live) => !(live.proc instanceof HostedProc))
      .map((live) => live.proc.pid);
    await this.limitCpu([this.host?.connected ? this.host.hostPid : undefined, ...pids]);
    if (!this.cpuBudget || this.closed || !this.dataDir) return;
    const owned = this.db
      .prepare(
        `SELECT 1 FROM agent_runs r WHERE r.status IN ('queued','running')
      AND EXISTS (SELECT 1 FROM agent_run_executions e WHERE e.run_id=r.id AND e.run_log_path=r.log_path) LIMIT 1`,
      )
      .get();
    if (!owned) return;
    let client: RunClient | undefined;
    try {
      // Refresh never starts a replacement host to resolve uncertain ownership.
      const connection = readRunRendezvous(this.dataDir);
      client = await RunClient.connect(connection.address, connection.token, 35000);
      if (client.hostInstance !== connection.instance)
        throw new Error('Run host identity mismatch');
      if (!this.closed) {
        const result = await client.refreshCpuBudget(getCpuBudget(this.db).threads);
        if (result.owned > 0 && result.updated === 0)
          console.warn('[agents] Hosted CPU budget was not applied');
      }
    } catch (error) {
      console.warn('[agents] Hosted CPU refresh unavailable:', (error as Error).message);
    } finally {
      client?.close();
    }
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
    // Installs never relaunch: they are quick and idempotent enough to retry by hand.
    this.db
      .prepare(
        `UPDATE agent_installs SET status = 'failed', error = ?, ended_at = ? WHERE status = 'running'`,
      )
      .run('Server shut down before completion', now());
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
      if (hasManagedExecution(this.db, row.id, row.log_path)) continue;
      if (row.attempts < row.max_attempts) {
        this.log(
          row.log_path,
          `\n[supervisor] server restarted — relaunching run (attempt ${row.attempts + 1}/${row.max_attempts})\n`,
        );
        void this.spawnRun(row, true);
      } else {
        this.db
          .prepare(`UPDATE agent_runs SET status = 'failed', error = ?, ended_at = ? WHERE id = ?`)
          .run(
            'Server restarted before completion (attempts exhausted). The previous worker may still be running; inspect it before retrying.',
            now(),
            row.id,
          );
      }
    }
    await this.pollManagedRuns();
  }

  // ---- Sessions -------------------------------------------------------------------------------

  listSessions(projectId: number): AgentSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_sessions WHERE project_id = ? ORDER BY id`)
      .all(projectId) as unknown as SessionRow[];
    const batch = this.sessionBatch();
    return rows.map((r) => this.toSession(r, batch));
  }

  /** Every session in every project, newest last (the workspace shows sessions side by side). */
  listAllSessions(): AgentSession[] {
    const rows = this.db
      .prepare(`SELECT * FROM agent_sessions ORDER BY id`)
      .all() as unknown as SessionRow[];
    const batch = this.sessionBatch();
    return rows.map((r) => this.toSession(r, batch));
  }

  /**
   * Per-session settings and queued input for a whole list in two queries. The lists are polled
   * every couple of seconds by several views, and compiling four statements per session each time
   * made them the dearest request the server handles.
   */
  private sessionBatch(): SessionBatch {
    const autoContinue = new Map<number, AgentSession['autoContinue']>();
    const prefix = 'session-auto-continue:';
    for (const r of this.db
      .prepare(`SELECT key, value FROM settings WHERE key LIKE 'session-auto-continue:%'`)
      .all() as { key: string; value: string }[]) {
      try {
        autoContinue.set(Number(r.key.slice(prefix.length)), JSON.parse(r.value));
      } catch {
        // Unreadable value: the default applies, as with getSetting.
      }
    }
    const queued = new Map<number, number>();
    for (const r of this.db
      .prepare(
        `SELECT session_id, COALESCE(SUM(LENGTH(data)), 0) AS bytes FROM agent_input_queue GROUP BY session_id`,
      )
      .all() as { session_id: number; bytes: number }[])
      queued.set(r.session_id, r.bytes);
    return { autoContinue, queued, baseFiles: new Map() };
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
    // One Codex login for the app. A caller cannot pin a different CODEX_HOME on this session.
    const codexProfile =
      providerId === 'codex' && this.codexAccounts ? this.codexAccounts.selectedProfile() : null;
    if (codexProfile) env.CODEX_HOME = codexProfile.home;
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
        JSON.stringify({
          command,
          env,
          ...(codexProfile ? { codexAccountId: codexProfile.id } : {}),
        }),
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
    if (live && !isTerminalReport(data) && /[\r\n]/.test(data)) this.noTurnSinceStart.delete(id);
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
  async restartSession(
    id: number,
    options: { continuePrompt?: boolean } = {},
  ): Promise<AgentSession> {
    const row = this.getSessionRow(id);
    if (!row) throw new AgentError(404, 'Session not found');
    this.pinCodexForRestart(row);
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
      if (options.continuePrompt) {
        this.db
          .prepare(`INSERT INTO agent_input_queue (session_id, data, created_at) VALUES (?, ?, ?)`)
          .run(id, CONTINUE_PROMPT, now());
      }
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

  /**
   * "Try again" on the usage-limit notice (PM-58): sends the continuation now, once, and only
   * into an empty prompt so typed text is never overwritten. It counts as your own input, so
   * it cancels a pending auto-continue (no second continuation at the reset).
   */
  continueNow(id: number): AgentSession {
    const row = this.getSessionRow(id);
    if (!row) throw new AgentError(404, 'Session not found');
    if (row.provider_id !== 'codex' || row.terminal !== 'pty')
      throw new AgentError(400, 'Try again supports Codex terminals.');
    if (!this.live.has(`session:${id}`)) throw new AgentError(409, 'Session is not running');
    if (!emptyCodexPrompt(this.logTail(row.log_path) ?? ''))
      throw new AgentError(409, 'The terminal has text in its prompt: continue there');
    this.sendInput(id, CONTINUE_PROMPT);
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

  /**
   * Whether a Codex session shows its usage limit, checked every 10s for every running one.
   * Rendering the screen (a terminal emulation over 256 KB of log) and reading quota for every
   * session each tick stalled the whole server for 200-300 ms, so:
   * - an unchanged log (or terminal size) reuses the last render;
   * - a log still changing is re-rendered at most every 30s: Codex goes quiet once it hits the
   *   limit, so the tick after it settles renders it at once;
   * - quota is read only when the message is on screen.
   */
  private usageLimitOnScreen(row: SessionRow): { resetsAt: string | null } | undefined {
    const { size, mtime } = this.fileStat(row.log_path);
    const dims = this.sessionSizes.get(row.id);
    const version = `${size}|${mtime}|${dims?.cols}x${dims?.rows}`;
    let cached = this.limitScreens.get(row.id);
    const now = Date.now();
    const settled = cached?.lastSeen === version;
    if (!cached || (cached.version !== version && (settled || now - cached.at >= 30_000))) {
      cached = {
        version,
        lastSeen: version,
        at: now,
        screen: this.sessionScreen(row.id, 4000) ?? '',
      };
      this.limitScreens.set(row.id, cached);
    } else cached.lastSeen = version;
    if (!mentionsUsageLimit(cached.screen)) return undefined;
    return usageLimitShown(cached.screen, this.codexWindowsForSession(row), Date.now());
  }

  private codexWindowsForSession(row: SessionRow) {
    const profile = this.sessionCodexProfile(row);
    const state = this.codexAccounts?.state();
    if (!profile || !state) return [];
    return (
      (profile.id === 'default'
        ? state.defaultAccount?.limits
        : state.accounts.find((a) => a.id === profile.id)?.limits
      )?.windows ?? []
    );
  }

  private armContinuation(row: SessionRow): void {
    const key = `session-auto-continue:${row.id}`;
    const state = getSetting<{ enabled: boolean; resumesAt: string | null; attempts: number }>(
      this.db,
      key,
    );
    if (!state?.enabled || state.resumesAt) return;
    const windows = this.codexWindowsForSession(row);
    const resumesAt = allowanceReset(this.logTail(row.log_path) ?? '', windows, Date.now());
    if (!resumesAt) return;
    setSetting(this.db, key, { ...state, resumesAt, message: 'Waiting for allowance reset' });
  }

  /** The rotation's tried accounts plus the current one, minus any whose quota is back. */
  private codexTried(currentKey: string): string[] {
    for (const [id, since] of this.codexRotationTried)
      if (this.codexAccounts?.quotaRecovered(id, since)) this.codexRotationTried.delete(id);
    return [...new Set([...this.codexRotationTried.keys(), currentKey])];
  }

  private tickContinuation(): void {
    const rows = this.db
      .prepare(`SELECT * FROM agent_sessions WHERE provider_id = 'codex' AND status = 'running'`)
      .all() as unknown as SessionRow[];
    // Whether each one is showing its usage limit, opted in or not, for the limit notice.
    const running = new Set(rows.map((r) => r.id));
    for (const id of this.usageLimits.keys()) if (!running.has(id)) this.usageLimits.delete(id);
    for (const id of this.limitScreens.keys()) if (!running.has(id)) this.limitScreens.delete(id);
    // Every Codex CLI uses the one selected login, so the switch decision is the same for all of
    // them: worked out once per tick, and only if a session shows its limit (it reads several
    // credential and usage files).
    let decision: { currentKey: string; next: { id: string } | null } | null | undefined;
    const switchDecision = () => {
      if (decision !== undefined) return decision;
      const accounts = this.codexAccounts;
      if (!accounts?.state().autoSwitch) return (decision = null);
      const currentKey = accounts.selectedId();
      accounts.refreshUsageIfStale();
      const next = accounts.nextUnused(currentKey, this.codexTried(currentKey), Date.now());
      return (decision = { currentKey, next });
    };
    for (const row of rows) {
      const shown = this.noTurnSinceStart.has(row.id) ? null : this.usageLimitOnScreen(row);
      if (shown) {
        this.usageLimits.set(row.id, shown);
        if (!this.switchingCodexSession.has(row.id) && !this.restarting.has(row.id)) {
          if (this.switchingCodexSession.size > 0) continue;
          const choice = switchDecision();
          if (!choice) continue;
          const { currentKey, next } = choice;
          const tail = this.logTail(row.log_path) ?? '';
          if (next && next.id !== currentKey && emptyCodexPrompt(tail)) {
            this.codexRotationTried.set(currentKey, Date.now());
            void this.switchSessionCodexAccount(row.id, next.id, {
              continuePrompt: true,
              setGlobal: true,
              keepRotation: true,
              automatic: true,
            }).catch(() => undefined);
            continue;
          }
        }
      } else {
        this.usageLimits.delete(row.id);
      }
    }
    for (const row of rows) {
      if (this.switchingCodexSession.has(row.id)) continue;
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
      if (!live.proc.write(CONTINUE_PROMPT)) {
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
    this.switchingCodexSession.delete(id);
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
    const providerId = input.providerId ?? (input.command ? 'custom' : 'claude');
    const prompt = this.withImages(
      input.prompt ??
        defaultPrompt(card.key, card.title, card.description, input.context, card.issueUrl),
      card.id,
      providerId,
    ).slice(0, 20_000);
    const existingDispatch = () =>
      input.dispatchKey
        ? (this.db
            .prepare('SELECT * FROM agent_runs WHERE dispatch_key = ?')
            .get(input.dispatchKey) as unknown as RunRow | undefined)
        : undefined;
    const validateDispatchReplay = (run: RunRow) => {
      if (run.project_id !== projectId || run.card_id !== cardId)
        throw new AgentError(409, 'Dispatch key belongs to another task');
      if ((run.orchestrator_id ?? null) !== (input.orchestratorId ?? null))
        throw new AgentError(409, 'Dispatch key belongs to another orchestrator');
      const stored = JSON.parse(run.command_json) as { command: string[]; timeoutMs: number };
      const provider = getProvider(providerId);
      const requestedCommand =
        input.command ??
        (provider
          ? buildDispatchArgv(provider, prompt, input.autonomy ?? 'edit', this.imagePaths(card.id))
          : []);

      if (
        run.provider_id !== providerId ||
        run.prompt !== prompt ||
        run.autonomy !== (input.autonomy ?? 'edit') ||
        run.max_attempts !== (input.maxAttempts ?? 3) ||
        stored.timeoutMs !==
          (input.timeoutMin === undefined ? RUN_DEFAULT_TIMEOUT_MS : input.timeoutMin * 60_000) ||
        JSON.stringify(stored.command) !== JSON.stringify(requestedCommand)
      )
        throw new AgentError(409, 'Dispatch key conflicts with different execution inputs');
    };
    const existing = existingDispatch();
    if (existing) {
      validateDispatchReplay(existing);
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
      validateDispatchReplay(repeated);
      return this.toRun(repeated);
    }
    if (input.canCommit && !input.canCommit())
      throw new AgentError(409, 'Orchestrator ownership or policy changed before dispatch');
    const ts = now();
    const logPath = path.join(
      this.logDir,
      `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`,
    );
    const codexAccountId =
      providerId === 'codex' && this.codexAccounts ? this.codexAccounts.selectedId() : undefined;
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
          JSON.stringify({
            command,
            timeoutMs,
            ...(codexAccountId ? { codexAccountId } : {}),
          }),
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
    if (
      (row.status === 'queued' || row.status === 'running') &&
      hasManagedExecution(this.db, id, row.log_path)
    ) {
      // Serialize with observation so a stale poll cannot overwrite the stop acknowledgment.
      await this.managedPolling;
      try {
        await stopManagedRun(this.db, this.dataDir, id, row.log_path);
      } catch {
        throw new AgentError(
          409,
          'Stop unconfirmed; execution may still be running. Reconnect to its host and try again',
        );
      }
      this.startQueuedRuns();
      return this.getRun(id);
    }
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

  /** User attestation resolves reservation, never claims host-confirmed stop or task success. */
  async resolveUnknownRun(id: number, nonce: string): Promise<AgentRun> {
    await this.pollManagedRuns();
    if (this.closed) throw new AgentError(409, 'Supervisor is shutting down');
    const resolvedAt = now();
    const resolution = JSON.stringify({ source: 'manual-confirmation', nonce, resolvedAt });
    const result = this.db
      .prepare(
        `UPDATE agent_runs SET status='failed',execution_state='complete',
      execution_resolution_json=?,ended_at=?,error='Worker termination confirmed manually; task outcome remains unverified'
      WHERE id=? AND status IN ('queued','running') AND execution_state='unknown'
      AND ?=(SELECT e.nonce FROM agent_run_executions e WHERE e.run_id=agent_runs.id
        AND e.run_log_path=agent_runs.log_path ORDER BY e.attempt DESC LIMIT 1)`,
      )
      .run(resolution, resolvedAt, id, nonce);
    if (!result.changes)
      throw new AgentError(
        409,
        'Execution changed or is no longer unknown; refresh before resolving it',
      );
    this.startQueuedRuns();
    return this.getRun(id)!;
  }

  retryRun(id: number): AgentRun {
    const row = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(id) as unknown as
      RunRow | undefined;
    if (!row) throw new AgentError(404, 'Run not found');
    if (row.status === 'queued' || row.status === 'running') {
      throw new AgentError(409, 'Run is still active; stop it before retrying');
    }
    this.db.exec('BEGIN IMMEDIATE');
    let next: number;
    try {
      if (
        row.card_id != null &&
        this.db
          .prepare(
            "SELECT id FROM agent_runs WHERE card_id = ? AND status IN ('queued', 'running') LIMIT 1",
          )
          .get(row.card_id)
      )
        throw new AgentError(
          409,
          'This task already has an active worker; stop it before retrying',
        );
      const ts = now();
      const logPath = path.join(
        this.logDir,
        `run-${Date.now()}-${Math.floor(Math.random() * 1e6)}.log`,
      );
      next = Number(
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
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
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

  /** Resolve hosted owners before project deletion can cascade their run records. */
  async stopHostedProjectRuns(projectId: number): Promise<void> {
    const runs = this.db
      .prepare(
        `SELECT r.id FROM agent_runs r
      WHERE r.project_id=? AND r.status IN ('queued','running') AND EXISTS (
        SELECT 1 FROM agent_run_executions e WHERE e.run_id=r.id AND e.run_log_path=r.log_path
      )`,
      )
      .all(projectId) as { id: number }[];
    for (const run of runs) await this.stopRun(run.id);
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
    // Agents get their full budget back as the governor leaves.
    this.cpuGovernor?.stop();
    clearInterval(this.continuationTimer);
    clearInterval(this.managedTimer);
    await this.managedPolling;
    await Promise.allSettled([...this.managedDispatches]);
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
      if (/[\r\n]/.test(data)) this.noTurnSinceStart.delete(sessionId);
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
      const parsedCmd = JSON.parse(row.command_json) as {
        command: string[];
        env: Record<string, string>;
        codexAccountId?: string;
        codexFreshStart?: boolean;
      };
      const command = parsedCmd.command;
      // Settings picks the Codex login. A home stored on the session does not override it.
      const codexProfile = this.sessionCodexProfile(row);
      // The project's git identity (PM-186) sits under any env the session was started with.
      const gitEnv = await this.projectGitEnv(row.project_id);
      // `storedEnv` is what may be saved to the database; the git env carries a token and never is.
      const storedEnv = codexProfile
        ? { ...parsedCmd.env, CODEX_HOME: codexProfile.home }
        : { ...parsedCmd.env };
      const env = { ...gitEnv, ...storedEnv };
      // An account change never changes the conversation target.
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
        const id =
          codexResumeId(command) ??
          codexSessionFor(
            row.cwd,
            row.started_at,
            this.claimedConversations(row),
            os.homedir(),
            env.CODEX_HOME,
          );
        if (id) resume = this.saveResume(row.id, [command[0], 'resume', id]);
      }
      if (isRelaunch && row.provider_id === 'codex' && !resume)
        throw new AgentError(
          409,
          'Cannot identify the exact Codex conversation. Restart cancelled instead of starting a different conversation.',
        );
      // A resumed Codex re-sends its whole history at once; too many screenshots in it and the
      // connection is dropped on every retry (PM-276). Slim them first; best effort.
      if (isRelaunch && resume && row.provider_id === 'codex') {
        const id = codexResumeId(resume);
        const accounts = this.codexAccounts;
        const rollout =
          id && accounts ? accounts.findRollout(env.CODEX_HOME ?? accounts.runHome(), id) : null;
        if (rollout) {
          try {
            const slimmed = await slimResumeImages(rollout);
            if (slimmed)
              note(
                `Kept the newest ${slimmed.images - slimmed.removed} of ${slimmed.images} screenshots in the resumed conversation (${Math.round(slimmed.bytesBefore / 1048576)} MB was too large to send); the originals stay in its saved history`,
              );
          } catch (e) {
            console.error('[agents] slimming Codex screenshots failed:', (e as Error).message);
          }
        }
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
      const resumeFailed = !byUser && row.provider_id !== 'codex' && this.resumeFailed.delete(key);
      if ((byUser || row.provider_id === 'codex') && this.resumeFailed.has(key)) {
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
      // Global / per-CLI permission level (Settings), applied at every launch and relaunch. A
      // relaunched Claude Code keeps the mode it was cycled to (its last screen's footer), read
      // before this relaunch resets the terminal.
      const carried =
        isRelaunch && row.provider_id === 'claude'
          ? claudeModeOnScreen(this.sessionScreen(row.id, 4000) ?? '')
          : null;
      const permitted = withPermissions(
        row.provider_id,
        effectiveLevel(getPermissions(this.db), row.provider_id),
        connection.command,
        connection.env,
        carried,
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
      this.noTurnSinceStart.add(row.id);

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

  /** Recent conversation lookups for the chat view, shared by its polls (one per session). */
  private pinning = new Map<number, { at: number; run: Promise<void> }>();

  /**
   * OpenCode and Antigravity name their conversation only once it starts, so a new session has
   * none pinned and its chat view had nothing to read until a relaunch. Finds it for the chat
   * view with the relaunch lookup: this folder, begun since this session started, not another
   * session's (never just the latest). At most every 15 s per session: OpenCode's lookup runs
   * its CLI.
   */
  pinConversation(id: number): Promise<void> {
    const row = this.getSessionRow(id);
    if (!row || row.resume_json) return Promise.resolve();
    const command = (JSON.parse(row.command_json) as { command: string[] }).command;
    const opencode = row.provider_id === 'opencode' && command[0] === 'opencode';
    const agy = row.provider_id === 'antigravity' && command[0] === 'agy';
    if (!opencode && !agy) return Promise.resolve();
    const last = this.pinning.get(id);
    if (last && Date.now() - last.at < 15_000) return last.run;
    const run = (async () => {
      const claimed = this.claimedConversations(row);
      const found = opencode
        ? await openCodeSessionFor(row.cwd, row.created_at, claimed)
        : antigravityConversationFor(row.cwd, row.created_at, claimed);
      if (found && !this.getSessionRow(id)?.resume_json)
        this.saveResume(id, [command[0]!, opencode ? '--session' : '--conversation', found]);
    })().catch(() => undefined);
    this.pinning.set(id, { at: Date.now(), run });
    return run;
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
    // The selected Codex login reads several credential files: once per pass, not per session.
    const batch = { autoContinue: new Map(), queued: new Map(), baseFiles: new Map() };
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
      const id = this.conversationOf(row, batch);
      const title = id ? this.cliTitle(row, id, batch) : null;
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
  private conversationOf(row: SessionRow, batch?: SessionBatch): string | null {
    const resume = row.resume_json ? (JSON.parse(row.resume_json) as string[]) : null;
    const { command } = JSON.parse(row.command_json) as { command: string[] };
    if (row.provider_id !== 'codex') return claudeSessionId(resume, command);
    const pinned = codexResumeId(resume) ?? codexResumeId(command);
    if (pinned) return pinned;
    if (command[0] !== 'codex') return null;
    const codexHome = this.sessionCodexProfile(row, batch)?.home;
    const id = codexSessionFor(
      row.cwd,
      row.started_at,
      this.claimedConversations(row),
      os.homedir(),
      codexHome,
    );
    if (id) this.saveResume(row.id, [command[0], 'resume', id]);
    return id;
  }

  private cliTitle(row: SessionRow, id: string, batch?: SessionBatch): string | null {
    if (row.provider_id === 'claude') return claudeCustomTitle(row.cwd, id);
    if (row.provider_id === 'codex')
      return codexThreadName(id, os.homedir(), this.sessionCodexProfile(row, batch)?.home);
    return grokManualTitle(row.cwd, id);
  }

  /**
   * For CLIs that can only "resume the latest conversation" (Codex, OpenCode, Antigravity): that is the
   * right conversation only if this is the sole session of that CLI in the folder. Otherwise
   * (or for explicit commands) relaunch fresh rather than risk resuming another pane's chat.
   */
  private resumeLatestArgv(row: SessionRow): string[] | null {
    // Codex resolves its own session rollout via `codexSessionFor` in the profile's CODEX_HOME;
    // falling back to `codex resume --last` when a switched account has no rollout yet fails or
    // grabs an unrelated thread (PM-173).
    if (row.provider_id === 'codex') return null;
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

  private pollManagedRuns(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.managedPolling ??= recoverManagedRuns(
      this.db,
      this.dataDir,
      () => !this.closed,
      (id, file) => {
        const log = this.logs.get(`run:${id}`);
        const size = logicalSize(file);
        if (log && log.totalBytes !== size) {
          log.resync(size);
          this.events.emit(`output:run:${id}`);
        }
      },
    ).finally(() => {
      this.managedPolling = null;
      this.startQueuedRuns();
    });
    return this.managedPolling;
  }

  /** Runs holding a slot: live, or between the spawn decision and the process start. */
  private activeRuns(): number {
    let n = 0;
    for (const live of this.live.values()) if (live.kind === 'run') n++;
    for (const key of this.starting) if (key.startsWith('run:')) n++;
    const hosted = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM agent_runs r WHERE r.status IN ('queued','running') AND EXISTS (SELECT 1 FROM agent_run_executions e WHERE e.run_id=r.id AND e.run_log_path=r.log_path)`,
      )
      .get() as { n: number };
    return n + hosted.n;
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

  private runCodexProfile(row: RunRow): { id: string; name: string; home: string } | null {
    if (row.provider_id !== 'codex' || !this.codexAccounts) return null;
    return this.codexAccounts.selectedProfile();
  }

  private runHitUsageLimit(logPath: string, codexHome?: string): boolean {
    const tail = stripTerminal(this.logTail(logPath, 8192) ?? '');
    if (
      /you[’']ve hit your usage limit|usage_limit_reached|usage limit reached|insufficient_quota|quota exceeded/i.test(
        tail,
      )
    ) {
      return true;
    }
    const windows =
      codexHome === this.codexAccounts?.runHome()
        ? (this.codexAccounts?.state().defaultAccount?.limits?.windows ?? [])
        : [];
    return allowanceReset(tail, windows, Date.now()) !== null;
  }

  /** Commit author and GitHub account for this project's agent processes; never throws. */
  private async projectGitEnv(projectId: number): Promise<Record<string, string>> {
    const project = getProjectRow(this.db, projectId);
    if (!project) return {};
    try {
      return await projectGitEnv(this.db, project);
    } catch {
      return {};
    }
  }

  private async spawnRun(row: RunRow, isRelaunch: boolean): Promise<void> {
    if (hasManagedExecution(this.db, row.id, row.log_path)) {
      await this.pollManagedRuns();
      return;
    }
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
      const storedCmd = JSON.parse(row.command_json) as {
        command: string[];
        timeoutMs: number;
        codexAccountId?: string;
        triedCodexAccounts?: string[];
      };
      const { command, timeoutMs } = storedCmd;
      const codexProfile = this.runCodexProfile(row);
      const runEnv: Record<string, string> = {
        ...(await this.projectGitEnv(row.project_id)),
        ...(codexProfile ? { CODEX_HOME: codexProfile.home } : {}),
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
              runEnv,
            )
          : { command, env: runEnv };
        const resolved = await resolveArgv(connection.command);
        if (this.managedRuns) {
          const pending = this.spawnManagedRun(row, {
            argv: resolved,
            cwd,
            env: processEnv(connection.env),
            timeoutMs,
          });
          this.managedDispatches.add(pending);
          try {
            await pending;
          } finally {
            this.managedDispatches.delete(pending);
          }
          return;
        }
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
      proc.onExit(async (code) => {
        clearTimeout(timer);
        if (this.live.get(key) === live) this.live.delete(key);
        // Shutdown kills everything: leave wanted rows alone so the next boot relaunches them.
        if (this.closed) return;
        const current = this.db.prepare(`SELECT * FROM agent_runs WHERE id = ?`).get(row.id) as
          RunRow | undefined;
        if (!current || current.log_path !== row.log_path) return; // Deleted (id maybe reused).
        if (current.status !== 'running' && current.status !== 'queued') return;
        if (
          code !== 0 &&
          !live.stoppedByUser &&
          !timedOut &&
          row.provider_id === 'codex' &&
          codexProfile &&
          this.codexAccounts?.state().autoSwitch &&
          this.runHitUsageLimit(row.log_path, codexProfile.home)
        ) {
          const tried = [...new Set([...(storedCmd.triedCodexAccounts ?? []), codexProfile.id])];
          try {
            await this.codexAccounts.refreshUsage();
          } catch {
            // Selection fails closed unless existing identity-verified readings are still fresh.
          }
          if (this.closed) return;
          // Stop/delete can happen while quota requests are pending; never revive ended work.
          const latest = this.db
            .prepare('SELECT status, log_path FROM agent_runs WHERE id = ?')
            .get(row.id) as { status: string; log_path: string } | undefined;
          if (!latest || latest.status !== 'running' || latest.log_path !== row.log_path) return;
          const next =
            !live.stoppedByUser && this.codexAccounts.state().autoSwitch
              ? this.codexAccounts.nextUnused(codexProfile.id, tried, Date.now())
              : null;
          if (next && next.id !== codexProfile.id) {
            this.codexRotationTried.set(codexProfile.id, Date.now());
            try {
              this.setActiveCodexAccount(next.id === 'default' ? null : next.id, {
                keepRotation: true,
                activeOnly: true,
              });
            } catch (error) {
              const message = `Account rotation cancelled: ${(error as Error).message}`;
              log.append(`\n[supervisor] ${message}\n`);
              this.finishRun(row, 'failed', code, message);
              return;
            }
            const nextCmdJson = JSON.stringify({
              ...storedCmd,
              codexAccountId: next.id,
              triedCodexAccounts: tried,
            });
            this.db
              .prepare(
                `UPDATE agent_runs SET command_json = ?, status = 'queued', attempts = ? WHERE id = ? AND log_path = ?`,
              )
              .run(nextCmdJson, Math.max(0, attempts - 1), row.id, row.log_path);
            log.append(
              `\n[supervisor] usage limit reached on ${codexProfile.name} — switching to ${next.name} and retrying run\n`,
            );
            const updated = this.db
              .prepare(`SELECT * FROM agent_runs WHERE id = ?`)
              .get(row.id) as unknown as RunRow | undefined;
            if (updated) void this.spawnRun(updated, true);
            return;
          }
        }
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

  private async spawnManagedRun(
    row: RunRow,
    launch: Omit<PipeRunLaunch, 'nonce' | 'logPath'>,
  ): Promise<void> {
    let client: Awaited<ReturnType<typeof connectRunHost>> | undefined;
    try {
      if (!this.dataDir) throw new Error('Hosted runs require a data directory');
      if (this.cpuBudget)
        launch = { ...launch, argv: budgetedRunArgv(launch.argv, getCpuBudget(this.db).threads) };
      client = await connectRunHost(this.dataDir);
      const current = this.db
        .prepare('SELECT status,log_path FROM agent_runs WHERE id=?')
        .get(row.id) as { status: string; log_path: string } | undefined;
      if (
        this.closed ||
        !current ||
        current.log_path !== row.log_path ||
        !['queued', 'running'].includes(current.status)
      )
        return;
      await launchManagedRun(this.db, client, row.id, row.attempts + 1, launch, () => {
        if (this.closed) return false;
        const current = this.db
          .prepare('SELECT status,log_path FROM agent_runs WHERE id=?')
          .get(row.id) as { status: string; log_path: string } | undefined;
        return (
          !!current &&
          current.log_path === row.log_path &&
          ['queued', 'running'].includes(current.status)
        );
      });
      if (!this.closed) {
        this.db
          .prepare(
            `UPDATE agent_runs SET status='running',execution_state='active',started_at=COALESCE(started_at,?),attempts=MAX(attempts,?)
          WHERE id=? AND log_path=? AND status IN ('queued','running')`,
          )
          .run(now(), row.attempts + 1, row.id, row.log_path);
      }
    } catch (error) {
      if (this.closed) return;
      if (hasManagedExecution(this.db, row.id, row.log_path)) {
        this.db
          .prepare(
            `UPDATE agent_runs SET status='running',execution_state='unknown',attempts=MAX(attempts,?),error=?
          WHERE id=? AND log_path=? AND status IN ('queued','running')`,
          )
          .run(
            row.attempts + 1,
            `Launch unconfirmed: ${(error as Error).message}`,
            row.id,
            row.log_path,
          );
      } else {
        this.finishRun(
          row,
          'failed',
          null,
          `Hosted runtime unavailable: ${(error as Error).message}`,
        );
      }
    } finally {
      client?.close();
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

  private toSession(row: SessionRow, batch?: SessionBatch): AgentSession {
    const { command } = JSON.parse(row.command_json) as { command: string[] };
    const codexProfile = this.sessionCodexProfile(row, batch);
    const live = this.live.get(`session:${row.id}`);
    const { size: diskLogBytes, mtime: lastOutputAt } = this.fileStat(row.log_path, batch);
    const progress = this.restarting.get(row.id);
    if (progress?.phase === 'restoring') {
      const activity = this.sessionActivity(row, lastOutputAt, diskLogBytes);
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
      usageLimit: this.usageLimits.get(row.id) ?? null,
      autoContinue: (batch
        ? (batch.autoContinue.get(row.id) ?? null)
        : getSetting<AgentSession['autoContinue']>(this.db, `session-auto-continue:${row.id}`)) ?? {
        enabled: false,
        resumesAt: null,
        message: '',
      },
      codexAccountId: codexProfile?.id ?? null,
      codexAccountName: codexProfile?.name ?? null,
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
      queuedInputBytes: batch ? (batch.queued.get(row.id) ?? 0) : this.queuedInputBytes(row.id),
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      logBytes: live ? live.log.totalBytes : diskLogBytes,
      lastOutputAt,
      tailState:
        row.status === 'running' || live
          ? this.sessionActivity(row, lastOutputAt, diskLogBytes)
          : null,
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
    const execution =
      row.execution_state === 'unknown'
        ? (this.db
            .prepare(
              `SELECT nonce FROM agent_run_executions
      WHERE run_id=? AND run_log_path=? ORDER BY attempt DESC LIMIT 1`,
            )
            .get(row.id, row.log_path) as { nonce: string } | undefined)
        : undefined;
    return {
      ...(execution ? { executionNonce: execution.nonce } : {}),
      ...(row.execution_resolution_json
        ? {
            executionResolution: JSON.parse(
              row.execution_resolution_json,
            ) as AgentRun['executionResolution'],
          }
        : {}),
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
      ...(row.execution_state ? { executionState: row.execution_state } : {}),
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
  private fileStat(file: string, batch?: SessionBatch): { size: number; mtime: string | null } {
    try {
      const st = statSync(file);
      return {
        size: (!batch || this.hasLogBase(file, batch) ? logBase(file) : 0) + st.size,
        mtime: st.mtime.toISOString(),
      };
    } catch {
      return { size: 0, mtime: null };
    }
  }

  /**
   * Whether a log has a `.base` sidecar, from one folder listing per list: reading every
   * session's sidecar, almost all missing, cost more than the rest of the list together.
   */
  private hasLogBase(file: string, batch: SessionBatch): boolean {
    const dir = path.dirname(file);
    let names = batch.baseFiles.get(dir);
    if (!names) {
      try {
        names = new Set(readdirSync(dir).filter((name) => name.endsWith('.base')));
      } catch {
        names = new Set();
      }
      batch.baseFiles.set(dir, names);
    }
    return names.has(`${path.basename(file)}.base`);
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
  private sessionActivity(
    row: SessionRow,
    lastOutputAt: string | null,
    logBytes?: number,
  ): AgentSession['tailState'] {
    const tail =
      logBytes === undefined
        ? this.logTail(row.log_path)
        : this.unchangedTail(row.log_path, `${logBytes}|${lastOutputAt}`);
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
  sessionResume(
    id: number,
  ): { providerId: string; resumeJson: string | null; codexHome?: string } | null {
    const row = this.getSessionRow(id);
    return row
      ? {
          providerId: row.provider_id,
          resumeJson: row.resume_json,
          codexHome: this.sessionCodexProfile(row)?.home,
        }
      : null;
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
  /**
   * `logTail` for a log whose size and modified time the caller has just read: an unchanged log
   * (most sessions sit idle) is not opened again. The session lists are polled every couple of
   * seconds, and re-reading every running session's tail was most of their cost.
   */
  private unchangedTail(file: string, version: string): string | null {
    const cached = this.tailCache.get(file);
    if (cached?.version === version) return cached.tail;
    const tail = this.logTail(file);
    if (this.tailCache.size > 500) this.tailCache.clear();
    this.tailCache.set(file, { version, tail });
    return tail;
  }

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
