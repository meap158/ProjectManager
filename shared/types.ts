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
  /** Set when the folder no longer exists on disk. */
  missing: boolean;
  scan: ScanState;
}

export type ProjectDetail = ProjectSummary;

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

export interface AgentProvider {
  /** Stable id: 'shell' and 'custom' are built in, the rest name an AI CLI. */
  id: string;
  name: string;
  /** Binary looked up on PATH. Null for 'shell' (OS default) and 'custom'. */
  binary: string | null;
  /** Non-interactive argv; '{prompt}' is replaced by the dispatch prompt. */
  argsTemplate: string[];
  /** argv tail for relaunching a supervised session with conversational continuity. */
  resumeArgs?: string[];
  description: string;
  /** Install link shown when the binary is missing (Quil-style). */
  installUrl?: string;
}

export interface AgentProviderStatus extends AgentProvider {
  available: boolean;
  resolvedPath: string | null;
}

export type AgentSessionStatus = 'running' | 'exited' | 'killed' | 'dead';
export type AgentDesiredState = 'running' | 'stopped';

export interface AgentSession {
  id: number;
  projectId: number;
  name: string;
  providerId: string;
  command: string[];
  cwd: string;
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
}
