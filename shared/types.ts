// Types shared by the server API and the React client. Keep this file free of runtime code
// other than small constants so it can be imported from both sides.

export const CARD_STATUSES = ['backlog', 'todo', 'in_progress', 'review', 'done'] as const;
export type CardStatus = (typeof CARD_STATUSES)[number];

export const CARD_STATUS_LABELS: Record<CardStatus, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  in_progress: 'In progress',
  review: 'Review',
  done: 'Done',
};

/** Prefix used to reference cards from commit messages, e.g. "Fixes PM-12". */
export const CARD_KEY_PREFIX = 'PM';

/** Board column presets: which statuses get a visible column. Every preset keeps all
    five statuses valid — cards in hidden columns keep their status and reappear when
    the preset changes back. */
export const BOARD_PRESETS = ['full', 'simple', 'capture'] as const;
export type BoardPreset = (typeof BOARD_PRESETS)[number];

export const BOARD_PRESET_LABELS: Record<BoardPreset, string> = {
  full: 'Full flow',
  simple: 'Simple',
  capture: 'Capture flow',
};

export const BOARD_PRESET_COLUMNS: Record<BoardPreset, CardStatus[]> = {
  full: ['backlog', 'todo', 'in_progress', 'review', 'done'],
  simple: ['todo', 'in_progress', 'done'],
  capture: ['backlog', 'in_progress', 'done'],
};

export interface LanguageStats {
  name: string;
  files: number;
  bytes: number;
  code: number;
  comments: number;
  blanks: number;
  complexity: number;
}

export interface CodeStats {
  /** Which engine produced these numbers. */
  engine: 'builtin' | 'scc';
  totalFiles: number;
  /** Files that were recognised as a language and counted. */
  countedFiles: number;
  code: number;
  comments: number;
  blanks: number;
  complexity: number;
  /** Sorted by lines of code, descending. */
  languages: LanguageStats[];
  /** Bytes of all source files considered (tracked / non-ignored files). */
  bytes: number;
  /** Distinct folders containing source files. */
  folders: number;
  /** Largest source files, biggest first. */
  largestFiles: FileSize[];
  /** True when the scan stopped early because the file limit was hit. */
  truncated: boolean;
}

export interface FileSize {
  /** Path relative to the project root, using forward slashes. */
  path: string;
  bytes: number;
  lines: number;
}

export interface FolderSize {
  name: string;
  bytes: number;
  files: number;
}

/** Everything physically inside the folder, including ignored files (node_modules, builds, ...). */
export interface DiskStats {
  files: number;
  folders: number;
  bytes: number;
  /** Size of the .git directory (0 when not a repository). */
  gitBytes: number;
  /** Top-level entries by size, biggest first (loose root files grouped as "(root files)"). */
  topFolders: FolderSize[];
  /** True when the walk stopped early because the entry limit was hit. */
  truncated: boolean;
}

export interface Contributor {
  name: string;
  email: string;
  commits: number;
}

export interface CommitSummary {
  hash: string;
  date: string;
  author: string;
  subject: string;
}

export interface GitStats {
  isRepo: boolean;
  branch: string | null;
  remoteUrl: string | null;
  totalCommits: number;
  firstCommitAt: string | null;
  lastCommitAt: string | null;
  contributors: Contributor[];
  /** Commits per calendar day (author's local date), keyed "YYYY-MM-DD". */
  dailyCommits: Record<string, number>;
  recentCommits: CommitSummary[];
  /** Changed or untracked files in the working tree at scan time (absent in older scans). */
  dirtyFiles?: number;
  /** Commits ahead of / behind the upstream branch; null when there is no upstream. */
  ahead?: number | null;
  behind?: number | null;
}

export type CardCounts = Record<CardStatus, number>;

export interface ProjectSummary {
  id: number;
  name: string;
  path: string;
  createdAt: string;
  lastScannedAt: string | null;
  /** Null until the first scan completes. */
  code: CodeStats | null;
  disk: DiskStats | null;
  git: GitStats | null;
  cardCounts: CardCounts;
  /** Visible board columns. Cards in hidden statuses keep their status. */
  boardPreset: BoardPreset;
  /** Agent/terminal sessions currently running in this project. */
  runningSessions: number;
  /** Set when the folder no longer exists on disk. */
  missing: boolean;
  scan: ScanState;
}

export type ProjectDetail = ProjectSummary;

/** An image attached to a card as context (stored in the data folder, not the project). */
export interface CardAttachment {
  /** Stored file name; identifies the attachment. */
  file: string;
  /** Original name, for display. */
  name: string;
  type: string;
  bytes: number;
  addedAt: string;
  /** Same-origin URL serving the image. */
  url: string;
}

export interface Card {
  id: number;
  /** Owning project, or 0 for an "All projects" card that belongs to no project (PM-138). */
  projectId: number;
  key: string;
  title: string;
  description: string;
  status: CardStatus;
  position: number;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  /** Commit hash that moved this card automatically, if any. */
  linkedCommit: string | null;
  /** Explicit issue identity; GitHub issue numbers are separate from PM card keys. */
  issueUrl?: string | null;
}

/** A card plus its project's name, for cross-project lists (dashboard "In flight"). */
export interface CardWithProject extends Card {
  projectName: string;
}

export interface CardMove {
  cardId: number;
  key: string;
  from: CardStatus;
  to: CardStatus;
  commit: string;
}

export interface ScanState {
  status: 'idle' | 'scanning' | 'error';
  error: string | null;
  startedAt: string | null;
  /** Cards moved automatically by the most recent scan (commit references). */
  moves: CardMove[];
}

export interface DirectoryEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
  /** True when this exact folder is already tracked as a project. */
  isTracked: boolean;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: DirectoryEntry[];
  /** Filesystem roots (drive letters on Windows, "/" elsewhere). */
  roots: string[];
  home: string;
  /** Project name already tracking this exact folder, if any. */
  trackedAs: string | null;
}

export interface ApiError {
  error: string;
}

export interface BulkAddResult {
  added: ProjectSummary[];
  skipped: { path: string; reason: string }[];
}

// ---- Agent CLI sessions and runs ------------------------------------------------------------
// Persistent, server-side processes for driving AI coding CLIs (Claude Code, Codex,
// OpenCode, Antigravity, …) or any shell command. Sessions are interactive terminals that
// survive GUI navigation; the supervisor relaunches them after server restarts and
// machine reboots when they are supervised and still wanted (desiredState).
// Runs are one-shot dispatches, usually of a Kanban card, with a validate step that
// moves the card through its lifecycle.

/**
 * How much a one-shot run may do without asking. Each provider maps these onto its own flags:
 * read = look but don't touch, edit = change files in the project, full = also run commands freely.
 */
export const AGENT_AUTONOMY = ['read', 'edit', 'full'] as const;
export type AgentAutonomy = (typeof AGENT_AUTONOMY)[number];

export const AGENT_AUTONOMY_LABELS: Record<AgentAutonomy, string> = {
  read: 'Read-only',
  edit: 'Edit files',
  full: 'Full access',
};

/** A device signed in to LAN access. */
export interface LanDevice {
  id: string;
  /** e.g. "iPhone · Safari", from its browser. */
  label: string;
  address: string;
  signedInAt: string;
  lastSeenAt: string;
}

/** Opt-in LAN access (Settings; only ever answered on this computer). */
export interface LanStatus {
  enabled: boolean;
  running: boolean;
  port: number | null;
  /** Plain addresses (no secrets): devices open one and type the code. */
  urls: string[];
  /** Current one-time sign-in code while listening. */
  code: string | null;
  codeExpiresAt: string | null;
  devices: LanDevice[];
  error: string | null;
}

/** A signed-in remote browser session (Cloudflare Access identity + authenticator code). */
export interface RemoteSession {
  id: string;
  email: string;
  signedInAt: string;
  lastSeenAt: string;
  expiresAt: string;
}

/** What the Cloudflare tunnel front door needs (Settings; only ever answered on this computer). */
export interface RemoteConfig {
  /** Cloudflare Zero Trust team name: `<team>.cloudflareaccess.com`. */
  team: string;
  /** The Access application's AUD tag (64 hex characters). */
  aud: string;
  /** The public hostname the tunnel serves, for example `pm.example.com`. */
  hostname: string;
  /** Emails allowed in. Never empty while enabled. */
  emails: string[];
}

/** Opt-in remote access through a Cloudflare Tunnel (server/remote.ts). */
export interface RemoteStatus {
  enabled: boolean;
  running: boolean;
  /** The loopback port cloudflared must send traffic to; null while stopped. */
  port: number | null;
  config: RemoteConfig;
  /** True once an authenticator code has been confirmed. */
  totpConfirmed: boolean;
  /** Shown on this computer only, while enrolling: the secret and its otpauth link. */
  pendingTotp: { secret: string; otpauth: string } | null;
  sessions: RemoteSession[];
  /** What is still missing before access can be switched on. */
  missing: string[];
  error: string | null;
}

/** A permission choice: one of the levels, or 'cli' = pass no flags, the CLI's own settings apply. */
/** 'auto' is Claude Code's own auto mode (PM-326): only Claude offers it. */
export type PermissionLevel = 'cli' | 'auto' | AgentAutonomy;

/** Global agent permissions, with per-CLI overrides ('inherit' follows the global level). */
export interface AgentPermissions {
  global: PermissionLevel;
  providers: Record<string, PermissionLevel | 'inherit'>;
  /** Read only: whether the installed Claude Code offers auto mode (null when unknown). */
  claudeAuto?: boolean | null;
}

/** Settings → CPU budget: how many logical CPUs agent processes may use together. */
export interface CpuBudget {
  /** False where the OS offers no way to apply it (macOS). */
  supported: boolean;
  totalThreads: number;
  threads: number;
  defaultThreads: number;
  /** Current overall CPU utilization (0–100%), sampled via os.cpus() delta without spawning a process. */
  usagePercent?: number | null;
  /**
   * From the governor (Windows), which keeps the whole machine under the threshold: what the
   * agents themselves use (% of the machine) and how many threads they may use right now
   * (fewer than `threads` while other load is high). Null when it isn't running.
   */
  agentPercent?: number | null;
  allowedThreads?: number | null;
}

/** One entry of a session's chat view (mobile): a message, a tool call or its result. */
export interface ChatItem {
  id: string;
  /** `note`: a marker in the conversation, not a message (interrupted, compacted). */
  kind: 'user' | 'assistant' | 'tool' | 'result' | 'note';
  text?: string;
  /** Tool calls and results pair up by this id. */
  toolId?: string;
  /** Tool name and a one-line summary (the command, the file…); input is the full arguments. */
  name?: string;
  summary?: string;
  input?: string;
  isError?: boolean;
  at: string | null;
}

/** A slash command a session's CLI offers, for the chat view's suggestions (PM-117). */
export interface SlashCommand {
  /** Without the slash, e.g. "compact" or "frontend:test". */
  name: string;
  description: string;
  /** Built into the CLI, a custom command (project / user), or a skill. */
  source: 'builtin' | 'project' | 'user' | 'skill';
}

/** A slice of a session's transcript; `next` is the offset to read from next time. */
export interface SessionTranscript {
  /** False for CLIs without a readable transcript (the terminal is the only view). */
  supported: boolean;
  items: ChatItem[];
  next: number;
  /** The transcript was rewritten (e.g. compacted): replace, don't append. */
  reset: boolean;
  /** Why there is none to read, when the CLI normally has one (shown instead of "no messages"). */
  unavailable?: string;
}

export interface SensorFan {
  label: string;
  rpm: number;
}

/** CPU temperature and fan speeds, from the best source on this machine (PM-113). */
export interface MachineSensors {
  /** Where they come from; null when nothing is readable. */
  source: 'hwinfo' | 'librehardwaremonitor' | 'hwmon' | 'acpi' | null;
  /** Degrees Celsius: the CPU package / Tctl / hottest core where known. */
  cpuTempC: number | null;
  cpuTempLabel: string | null;
  /** Current overall CPU utilization (0–100%), sampled via os.cpus() delta. */
  cpuUsagePercent?: number | null;
  /** The CPU fan (and pump) first. */
  fans: SensorFan[];
  /** What the reading is or how to get better ones (e.g. ACPI zone, enable HWiNFO). */
  note: string | null;
  at: string;
}

export const PERMISSION_LEVEL_LABELS: Record<PermissionLevel, string> = {
  cli: "CLI's own settings",
  auto: 'Auto mode',
  ...AGENT_AUTONOMY_LABELS,
};

export interface AgentProvider {
  /** Stable id: 'shell' and 'custom' are built in, the rest name an AI CLI. */
  id: string;
  name: string;
  /** Binary looked up on PATH. Null for 'shell' (OS default) and 'custom'. */
  binary: string | null;
  /** Non-interactive argv; '{prompt}' is replaced by the dispatch prompt. */
  argsTemplate: string[];
  /** argv tail for relaunching a supervised session with conversational continuity.
      May contain '{sessionId}' (see sessionIdArgs). */
  resumeArgs?: string[];
  /** argv tail that pins a new interactive conversation to our own id ('{sessionId}'), so
      resume reopens exactly that conversation even with several sessions per project. */
  sessionIdArgs?: string[];
  /** Flag that names a new interactive conversation (the name follows it), e.g. Claude's --name. */
  nameArg?: string;
  /** argv tail resuming the CLI's most recent conversation in the working folder. Only safe when
      no other session of this CLI shares the folder, so it is used just in that case. */
  resumeLatestArgs?: string[];
  /** Extra args per autonomy level for one-shot runs; a missing level is unsupported. */
  autonomyArgs?: Partial<Record<AgentAutonomy, string[]>>;
  /** argv tail that starts the interactive CLI with a first prompt ('{prompt}' placeholder).
      Absent when the CLI can't take one; the user then types it in the terminal. */
  interactivePromptArgs?: string[];
  description: string;
  /** Install link shown when the binary is missing (Quil-style). */
  installUrl?: string;
}

export interface AgentProviderStatus extends AgentProvider {
  available: boolean;
  resolvedPath: string | null;
  /** Why the provider can't be used, when it is unavailable. */
  unavailableReason?: string;
  /** How to install it on this machine right now (null: no automatic install). */
  install: InstallPreview | null;
}

/** Codex authentication profiles kept in the local app data directory. Credentials are never returned. */
export type AccountUsageStatus =
  'fresh' | 'stale' | 'expired' | 'unavailable' | 'unsupported' | 'not_loaded';

export interface CodexAccount {
  /** Missing on older profiles means eligible for automatic switching. */
  autoSwitchEligible?: boolean;
  usageStatus?: AccountUsageStatus;
  usageCheckedAt?: string | null;
  id: string;
  name: string;
  createdAt: string;
  /** Non-secret account label extracted from JWT claims (e.g. email or "API key"), if any. */
  email?: string | null;
  plan?: string | null;
  /** Latest locally recorded usage windows for this account profile, if any. */
  limits?: import('./limits.js').ProviderLimits | null;
}

export interface CodexAccountsState {
  accounts: CodexAccount[];
  /** null selects the user's normal CODEX_HOME login. */
  activeProfileId: string | null;
  autoSwitch: boolean;
  /** Usage is being re-read in the background (PM-173); poll until false. */
  usageRefreshing?: boolean;
  /** What automatic switching will do next for the account in use, from the latest readings. */
  forecast?: AccountSwitchForecast | null;
  /** Non-secret metadata for the default CODEX_HOME login, if auth.json exists there. */
  defaultAccount?: {
    usageStatus?: AccountUsageStatus;
    usageCheckedAt?: string | null;
    available: boolean;
    email?: string | null;
    plan?: string | null;
    limits?: import('./limits.js').ProviderLimits | null;
  };
}

/** One official way to install an agent CLI, exactly as its vendor documents it. */
export interface InstallRecipe {
  /** Shown in the UI before anything runs, e.g. "Official installer (claude.ai)". */
  label: string;
  /** Shown alongside: what will happen, e.g. which URL is fetched and how. */
  detail: string;
  /** Source of the official instructions (linked in the UI). */
  docUrl: string;
  kind: 'command' | 'script';
  /** kind=command: argv executed directly (resolved like any other spawn). */
  command?: string[];
  /** kind=script: installer downloaded and piped to this interpreter's stdin. */
  scriptUrl?: string;
  interpreter?: string[];
}

/** The recipe preview the API exposes (identical shape; execution needs the POST). */
export type InstallPreview = InstallRecipe;

export type AgentInstallStatus = 'running' | 'succeeded' | 'failed' | 'killed';

export interface AgentInstall {
  id: number;
  providerId: string;
  providerName: string;
  status: AgentInstallStatus;
  exitCode: number | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  logBytes: number;
}

/** How a session talks to its process: a pseudo-terminal (full TUI) or plain pipes. */
export type AgentTerminal = 'pty' | 'pipe';

export type AgentSessionStatus = 'running' | 'exited' | 'killed' | 'dead';
export type AgentDesiredState = 'running' | 'stopped';

/** Token usage of one agent session, from the CLI's own transcript (Claude Code only). */
export interface AgentTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Assistant replies counted. */
  replies: number;
}

export interface AgentSession {
  restartProgress?: 'stopping' | 'starting' | 'restoring' | 'failed' | null;
  restartError?: string | null;
  autoContinue?: { enabled: boolean; resumesAt: string | null; message: string };
  /**
   * The CLI is showing its plan usage limit (Codex terminals, PM-58), with when the exhausted
   * windows reset if known. Null once the message is off screen or the reset has passed.
   */
  usageLimit?: { resetsAt: string | null } | null;
  /** Active Codex account profile id ('default' or saved UUID) and display name for Codex sessions (PM-164). */
  codexAccountId?: string | null;
  codexAccountName?: string | null;
  id: number;
  projectId: number;
  name: string;
  providerId: string;
  command: string[];
  cwd: string;
  /** 'pty' sessions take raw keystrokes and render full-screen CLIs; 'pipe' ones are line-based. */
  terminal: AgentTerminal;
  /** Kanban card this session works on, if it was started from one. */
  cardId: number | null;
  /** Set when this session is a master orchestrator's chat CLI (PM-89). */
  orchestratorId?: string | null;
  /** When you last sent it a message (Enter or a pasted line); null if never (PM-94). */
  lastInputAt?: string | null;
  cardKey: string | null;
  pid: number | null;
  status: AgentSessionStatus;
  exitCode: number | null;
  /** Whether the session is wanted up. 'stopped' sessions never auto-relaunch. */
  desiredState: AgentDesiredState;
  /** Relaunch after crashes and restarts/reboots while desiredState is 'running'. */
  supervise: boolean;
  /** True when the session relaunches with conversational continuity (resume flags). */
  resumeSupported: boolean;
  restarts: number;
  lastRestartAt: string | null;
  /** Bytes of stdin queued while no process is attached. */
  queuedInputBytes: number;
  createdAt: string;
  startedAt: string;
  endedAt: string | null;
  logBytes: number;
  /** When the session last produced output (null before any). Tells working from idle. */
  lastOutputAt: string | null;
  /** What the CLI is doing: 'running' (busy, or a shell/subtask it started is still going),
      'input' (asking you to choose or approve something), 'idle' (at its prompt), or null
      (unknown: fall back to output recency). */
  tailState: 'running' | 'idle' | 'input' | null;
  /** Idle at its prompt with a reply that ends by asking you something (in words, not a menu):
      that question, from the CLI's transcript (PM-298). Null or absent otherwise. */
  question?: string | null;
}

export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'killed';

export interface AgentRun {
  executionState?: 'active' | 'unknown' | 'complete';
  executionNonce?: string;
  executionResolution?: { source: 'manual-confirmation'; nonce: string; resolvedAt: string };
  id: number;
  /** Master that dispatched this run; independent of current assignment state. */
  orchestratorId?: string | null;
  projectId: number;
  cardId: number | null;
  cardKey: string | null;
  name: string;
  providerId: string;
  command: string[];
  prompt: string;
  autonomy: AgentAutonomy;
  /** What the run changed in the project's git working tree (null if not a repo or unknown). */
  changes: RunChanges | null;
  status: AgentRunStatus;
  exitCode: number | null;
  error: string | null;
  attempts: number;
  maxAttempts: number;
  validation: 'accepted' | 'rejected' | null;
  validatedAt: string | null;
  validatedMove: CardStatus | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  logBytes: number;
}

export interface RunChanges {
  /** Persisted pre-launch vs later observed worktree; may include other authors' edits. */
  observation?: { baselineAt: string; observedAt: string };
  /** Files that changed during the run (working tree or committed), project-relative. */
  files: string[];
  /** Commits the run created. */
  commits: number;
}

/** A slice of a session/run log, addressed by byte offset. */
export interface AgentOutput {
  terminalSize?: { cols: number; rows: number };
  data: string;
  nextOffset: number;
  running: boolean;
  exitCode: number | null;
  logBytes: number;
}

/** Per-card rollup for Kanban badges. */
export interface CardRunSummary {
  cardId: number;
  running: number;
  succeeded: number;
  failed: number;
  /** Succeeded but not yet accepted/rejected. */
  awaitingValidation: number;
  /** Running interactive session linked to the card (newest), for the board's live badge. */
  liveSessionId: number | null;
}

// ---- Agent workspace -------------------------------------------------------------------------
// One full-width page of terminal panes. Layout presets instead of free-form splitting keep it
// dead simple; any pane can show any session from any project.

export const WORKSPACE_PRESETS = ['1', '2v', '2h', '3v', '2x2'] as const;
export type WorkspacePreset = (typeof WORKSPACE_PRESETS)[number];

export const WORKSPACE_PRESET_INFO: Record<
  WorkspacePreset,
  { panes: number; columns: number; rows: number; label: string }
> = {
  '1': { panes: 1, columns: 1, rows: 1, label: 'Single pane' },
  '2v': { panes: 2, columns: 2, rows: 1, label: 'Two side by side' },
  '2h': { panes: 2, columns: 1, rows: 2, label: 'Two stacked' },
  '3v': { panes: 3, columns: 3, rows: 1, label: 'Three side by side' },
  '2x2': { panes: 4, columns: 2, rows: 2, label: 'Grid of four' },
};

export interface WorkspaceLayout {
  preset: WorkspacePreset;
  /** Session id shown in each pane (null = empty pane), length = preset pane count. */
  panes: (number | null)[];
  /** Pane index shown alone, or null. */
  maximized: number | null;
  /** Terminal font size in px for all panes (default 12.5). */
  fontSize?: number;
}

export const WORKSPACE_FONT_SIZES = { min: 10, max: 20, default: 12.5 } as const;

export const PR_MERGE_METHODS = ['merge', 'squash', 'rebase'] as const;
/** How GitHub merges a pull request: a merge commit, one squashed commit, or rebased commits. */
export type PullRequestMergeMethod = (typeof PR_MERGE_METHODS)[number];

/** Which pull requests the tab lists: open ones, or recently closed and merged ones. */
export type PullRequestListState = 'open' | 'closed';

export interface PullRequestCheck {
  name: string;
  state: 'pass' | 'fail' | 'pending' | 'skipped';
  /** https only; null when GitHub gave none. */
  url: string | null;
}

export interface PullRequestChecks {
  /** Overall: failing beats pending beats passing; 'none' when the head has no checks. */
  state: 'none' | 'passing' | 'failing' | 'pending';
  passing: number;
  failing: number;
  pending: number;
  skipped: number;
  items: PullRequestCheck[];
}

/**
 * Whether a pull request can be merged now, and if not why, as GitHub's merge box words it.
 * Derived on the server from gh's mergeable/mergeStateStatus, checks, review and repo settings.
 */
export interface PullRequestMergeability {
  status:
    'clean' | 'unstable' | 'conflicts' | 'behind' | 'blocked' | 'draft' | 'checking' | 'closed';
  canMerge: boolean;
  /** Why it can't merge (or the warning when it can, e.g. non-required checks failing). */
  reason: string | null;
  /** "Update branch": merge or rebase the base into the head (GitHub offers it when behind). */
  canUpdateBranch: boolean;
  /** "Enable auto-merge": merge once requirements pass (repo setting allow_auto_merge). */
  canAutoMerge: boolean;
  /** Admins may merge without waiting for requirements (gh pr merge --admin). */
  canBypass: boolean;
}

/** The repository's merge settings, from `gh api repos/{owner}/{repo}`. */
export interface PullRequestRepoSettings {
  /** Merge methods the repo allows (all three when GitHub withholds the settings). */
  mergeMethods: PullRequestMergeMethod[];
  allowAutoMerge: boolean;
  /** GitHub deletes head branches itself after a merge. */
  deleteBranchOnMerge: boolean;
  canPush: boolean;
  isAdmin: boolean;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: { login: string } | null;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  isDraft: boolean;
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  /** Head branch lives in a fork: its branch can't be deleted or restored from here. */
  isCrossRepository: boolean;
  /** Whether the head branch still exists on GitHub; null when unknown (forks, lookup failed). */
  headBranchExists: boolean | null;
  updatedAt: string;
  closedAt: string | null;
  mergedAt: string | null;
  reviewDecision: string | null;
  /** Auto-merge is enabled, with this method. */
  autoMerge: { method: PullRequestMergeMethod | null } | null;
  checks: PullRequestChecks;
  mergeability: PullRequestMergeability;
}

/**
 * The GitHub account the Pull requests tab runs gh as for a project. gh acts as its active
 * account; when several are logged in, the tab uses the one that owns the repo (or the project's
 * chosen account) instead, through GH_TOKEN in that one gh process. No token is ever in here.
 */
export interface PullRequestAccount {
  /** Who gh acts as; null when gh lists no account (missing, or not logged in). */
  login: string | null;
  /** Why: the project's chosen account, the repo owner's own login, or gh's active account. */
  source: 'override' | 'owner' | 'active';
  /** Owner of the GitHub repo gh resolves in the project folder; null when there's none. */
  owner: string | null;
  /** Every account logged in to gh for github.com. */
  accounts: string[];
  /** The account chosen for this project in the tab, or null for automatic. */
  override: string | null;
}

export interface PullRequestsResult {
  state: PullRequestListState;
  requests: PullRequest[];
  /** Null when the repo settings couldn't be read (actions then fall back to gh's own errors). */
  repo: PullRequestRepoSettings | null;
  /** Who the actions run as; null when it couldn't be worked out (error then says why). */
  account: PullRequestAccount | null;
  error: string | null;
  fetchedAt: string;
}

/** One action from the Pull requests tab; the server re-reads the PR before acting on it. */
export type PullRequestAction =
  | {
      action: 'merge';
      method: PullRequestMergeMethod;
      /** Delete the head branch (remote, and local when safe) after merging. */
      deleteBranch: boolean;
      /** Enable auto-merge instead of merging now. */
      auto: boolean;
      /** Merge without waiting for requirements (admins only). */
      admin: boolean;
      /** Only merge if the head is still this commit (what the user saw). */
      headOid?: string;
    }
  | { action: 'disable-auto-merge' }
  | { action: 'update-branch'; rebase: boolean }
  | { action: 'ready' }
  | { action: 'draft' }
  | { action: 'close'; deleteBranch: boolean }
  | { action: 'reopen' }
  | { action: 'delete-branch' }
  | { action: 'restore-branch' };

export interface PullRequestActionResult {
  ok: true;
  /** What happened, e.g. "Merged #12. Deleted branch fix (remote and local)." */
  message: string;
}

/** Keyboard shortcut actions (PM-244); Settings stores only the keys changed from the defaults. */
export const SHORTCUT_IDS = [
  'list.next',
  'list.previous',
  'session.showInPane',
  'session.continue',
  'session.restart',
  'session.toggle',
  'session.delete',
  'preview.expand',
] as const;
export type ShortcutId = (typeof SHORTCUT_IDS)[number];
/** A combo ("Alt+Shift+C"), or null for an action left without one. */
export type ShortcutOverrides = Partial<Record<ShortcutId, string | null>>;

/** Project page Files tab (PM-252): one folder's entry. */
export interface TreeEntry {
  name: string;
  /** Relative to the project, forward slashes. */
  path: string;
  kind: 'dir' | 'file';
  size: number | null;
  /** Ignored by git (shown greyed, like VS Code). */
  ignored: boolean;
  symlink: boolean;
}

export interface FolderListing {
  path: string;
  entries: TreeEntry[];
  truncated: boolean;
}

export type FilePreview =
  | { kind: 'text'; path: string; size: number; mtime: string; content: string }
  | { kind: 'image' | 'binary' | 'too-large'; path: string; size: number; mtime: string };

/** An app listening on this computer's loopback (Preview page, PM-253). */
export interface LocalApp {
  port: number;
  pid: number;
  /** Executable name, like "node.exe". */
  name: string;
  /** Trimmed command line; empty when it can't be read. */
  command: string;
  /** The tracked project whose folder the command line mentions, else null. */
  projectId: number | null;
  /** The page's <title>, when the app answers with HTML on "/". */
  title: string | null;
  /** Its icon: a path on that app ("/favicon.ico") that answered with an image, or a small inline
   * `data:image/...` URL it declares; null when it has none. */
  icon: string | null;
  /** "/" answered with an HTML page: it has a front end you can open (icon or not). */
  web: boolean;
}

/** A saved Preview address: a dev server the owner opens often. */
export interface PreviewLaunch {
  name: string;
  port: number;
  /** Starts with "/". */
  path: string;
  projectId: number | null;
}

/** A pinned file or folder on the Files tab (PM-284). */
export interface FilePin {
  id: number;
  /** A relative path inside the project, "/"-separated. */
  path: string;
  /** "project": this project only. "all": every project that has this relative path. */
  scope: 'project' | 'all';
  /** What is there now; null when this project has no such path (the pin shows as missing). */
  kind: 'file' | 'dir' | null;
}

/** The Files tab's folder previewer (PM-286): one entry with the times asset tracking needs. */
export interface FolderItem {
  name: string;
  /** Relative to the project, forward slashes. */
  path: string;
  kind: 'dir' | 'file';
  size: number | null;
  /** Last modified, ISO. */
  mtime: string | null;
  /** Created where the system records it (birth time), else the last status change. */
  ctime: string | null;
  /** Ignored by git (only known for a single folder, not for a recursive listing). */
  ignored: boolean;
  symlink: boolean;
  /** A picture's pixel size, read from its header; null for anything else or an unreadable header. */
  width: number | null;
  height: number | null;
  /** Its git state when it differs from the last commit (a folder: something inside it does). */
  git: GitMark | null;
}

export type GitMark = 'modified' | 'added' | 'untracked' | 'conflict';

export interface FolderInfo {
  path: string;
  items: FolderItem[];
  recursive: boolean;
  /** Totals over the items returned. */
  folders: number;
  files: number;
  totalSize: number;
  /** The newest modified time among the files returned. */
  newest: string | null;
  /** More entries exist than were returned (the cap, or the walk limit). */
  truncated: boolean;
}

/** One of our SOPs (PM-316): the shared standard each project's agent instructions carry. */
export interface SopInfo {
  id: string;
  title: string;
  /** Column label in the adherence grid. */
  short: string;
  summary: string;
  why: string;
  /** How the read-only check decides. */
  how: string;
  fix: string;
}

/** A deliberate, recorded exception: this project does not follow the SOP, and why. */
export interface SopWaiver {
  reason: string;
  createdAt: string;
}

export interface SopResult {
  /** `waived` is a failing check with a waiver; `na` means the SOP does not apply. */
  state: 'pass' | 'fail' | 'na' | 'waived';
  detail: string;
  waiver?: SopWaiver;
}

export interface SopReport {
  sops: SopInfo[];
  projects: { id: number; name: string; results: Record<string, SopResult> }[];
  checkedAt: string;
  /** The owner's edited copy (data/sops.yml) is in use rather than the defaults. */
  custom: boolean;
  /** The edited copy does not validate, so the defaults are in use. */
  fileError: string | null;
  /** Waivers whose SOP no longer exists in the file, kept so none vanish silently. */
  orphanedWaivers: { projectId: number; sopId: string }[];
}

/** A session that can run an SOP audit: a project's own session, or an orchestrator's chat. */
export interface SopAuditor {
  id: number;
  name: string;
  terminal: AgentSession['terminal'];
  kind: 'session' | 'orchestrator';
  /** The agent CLI it runs, e.g. 'claude' or 'codex'. */
  providerId: string;
  /** What it can audit: "This project", "All projects" or "3 projects". */
  scope: string;
  lastInputAt: string | null;
}

/**
 * What automatic account switching will do next (shown on the account in use), from the latest
 * usage readings and the switcher's own ranking. The switch itself still requires fresh readings.
 *  - next: the account in use is at (or near) its limit; this account has quota and is next.
 *  - wait: no account has quota now; this one comes back first, at `at` (it may be the one in use).
 *  - off: the account in use is at its limit and automatic switching is off.
 */
export type AccountSwitchForecast =
  | { kind: 'next'; name: string; left: number; fiveHour: number; weekly: number; atLimit: boolean }
  | { kind: 'wait'; name: string; at: string; current: boolean }
  | { kind: 'off' };
