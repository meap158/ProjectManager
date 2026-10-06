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
// OpenCode, Gemini, …) or any shell command. Sessions are interactive terminals that
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

/** A permission choice: one of the levels, or 'cli' = pass no flags, the CLI's own settings apply. */
export type PermissionLevel = 'cli' | AgentAutonomy;

/** Global agent permissions, with per-CLI overrides ('inherit' follows the global level). */
export interface AgentPermissions {
  global: PermissionLevel;
  providers: Record<string, PermissionLevel | 'inherit'>;
}

export const PERMISSION_LEVEL_LABELS: Record<PermissionLevel, string> = {
  cli: "CLI's own settings",
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
  /** Replaced by another provider: never offered for new sessions or runs, but existing
      sessions keep their name, open, and relaunch as before. */
  retired?: boolean;
}

export interface AgentProviderStatus extends AgentProvider {
  available: boolean;
  resolvedPath: string | null;
  /** Why the provider can't be used, when it is unavailable. */
  unavailableReason?: string;
  /** How to install it on this machine right now (null: no automatic install). */
  install: InstallPreview | null;
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
  /** What the CLI's last screen frame says: 'running' (busy, or a shell/subtask it started is
      still going), 'idle' (at its prompt), or null (unknown: fall back to output recency). */
  tailState: 'running' | 'idle' | null;
}

export type AgentRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'killed';

export interface AgentRun {
  id: number;
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
  /** Files that changed during the run (working tree or committed), project-relative. */
  files: string[];
  /** Commits the run created. */
  commits: number;
}

/** A slice of a session/run log, addressed by byte offset. */
export interface AgentOutput {
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

export interface PullRequestsResult {
  requests: {
    number: number;
    title: string;
    url: string;
    author: { login: string } | null;
    isDraft: boolean;
    headRefName: string;
    baseRefName: string;
    updatedAt: string;
    reviewDecision: string | null;
  }[];
  error: string | null;
  fetchedAt: string;
}
