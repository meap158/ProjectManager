export interface OrchestratorConfig {
  id: string;
  name: string;
  enabled: boolean;
  strategy?: 'observe' | 'autonomous';
  followDashboardAttention?: boolean;
  pruneDashboardAttention?: boolean;
  projectIds: number[];
  providers: string[];
  maxWorkers: number;
  maxWorkersPerProject: number;
  maxWorkersPerProvider: number;
  reservePercent: number;
  allowUnknownQuota: boolean;
  quotaMaxAgeMs: number;
}
export interface OrchestratorEvent {
  at: string;
  orchestratorId: string;
  cardId?: number;
  runId?: number;
  action: string;
  message: string;
  count?: number;
}

export type OrchestratorWaitReason =
  | 'active_worker'
  | 'review_required'
  | 'assignment_reserved'
  | 'retry_cooldown'
  | 'retry_budget_exhausted'
  | 'project_capacity'
  | 'managed_capacity'
  | 'global_capacity'
  | 'provider_capacity'
  | 'quota_exceeded'
  | 'quota_unknown'
  | 'no_provider_available';

export interface OrchestratorExecutionStatus {
  executing: boolean;
  lastTickAt: string | null;
}

export interface OrchestratorPlanDecision {
  worker?: {
    runId: number;
    orchestratorId: string | null;
    executionState?: 'active' | 'unknown' | 'complete';
  };
  cardId: number;
  projectId: number;
  action: 'dispatch' | 'review' | 'wait';
  providerId?: string;
  reason: string;
  waitReason?: OrchestratorWaitReason;
  occupancy?: {
    managedWorkers: number;
    externalWorkers: number;
    projectWorkers: number;
  };
  retry?: {
    attemptsUsed: number;
    attemptsRemaining: number;
    retryAt: string | null;
    blocker: string | null;
  };
  execution?: {
    autonomy: 'edit' | 'read';
    supervisorAttempts: number;
    requiresReview: boolean;
  };
  providerBlockers?: { providerId: string; detail: string }[];
}

export interface OrchestratorState {
  instances: OrchestratorConfig[];
  events: OrchestratorEvent[];
  status?: OrchestratorExecutionStatus;
}

/**
 * What an orchestrator sees of Home (PM-70): the same "needs attention" and "being worked on" as
 * the dashboard, plus the context to trace each item back (card, session, run, commit) and resolve
 * it. Built by server/orchestrator/situation.ts.
 */
export type SituationKind =
  | 'project-alert' /* Folder missing, Scan failed, Stale, Uncommitted, Unpushed */
  | 'needs-input' /* an agent session is asking the user to choose or approve something */
  | 'awaiting-review' /* a finished run waits for Accept / Reject */
  | 'stalled'; /* in progress, no live worker, no change for a while */

export interface SituationItem {
  kind: SituationKind;
  projectId: number;
  projectName: string;
  /** One line: what needs attention. */
  title: string;
  /** Why, with the specifics (alert detail, what the agent asked, run outcome). */
  detail: string;
  cardId?: number;
  cardKey?: string;
  sessionId?: number;
  runId?: number;
  /** When it started (ISO), when known. */
  since?: string;
}

export interface SituationWorker {
  kind: 'session' | 'run';
  id: number;
  name: string;
  providerId: string;
  /** running | input | idle | queued | … */
  state: string;
  lastOutputAt?: string | null;
}

export interface SituationCard {
  cardId: number;
  cardKey: string;
  projectId: number;
  projectName: string;
  title: string;
  status: 'in_progress' | 'review';
  updatedAt: string;
  /** First part of the card description. */
  summary: string;
  /** What last moved it automatically: a commit hash, "PR #12" or a branch name. */
  movedBy: string | null;
  /** Live sessions and runs on this card. */
  workers: SituationWorker[];
  /** The newest run on this card, finished or not. */
  latestRun: {
    id: number;
    status: string;
    validation: 'accepted' | 'rejected' | null;
    filesChanged: number;
    commits: number;
    endedAt: string | null;
  } | null;
  /** Kinds from needsAttention that concern this card. */
  flags: SituationKind[];
}

export interface OrchestratorSituation {
  generatedAt: string;
  needsAttention: SituationItem[];
  beingWorkedOn: SituationCard[];
}

export interface OrchestratorPendingPage {
  version: 1;
  generatedAt: string;
  total: number;
  offset: number;
  limit: number;
  items: SituationItem[];
  nextOffset: number | null;
}
