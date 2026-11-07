import type { AgentSession, CardWithProject, ProjectSummary } from './types.js';
export interface OrchestratorConfig {
  id: string;
  name: string;
  enabled: boolean;
  strategy?: 'observe' | 'autonomous';
  followDashboardAttention?: boolean;
  pruneDashboardAttention?: boolean;
  /**
   * The chat may hand cards to CLI sessions in its projects: assign one to an idle session, or
   * start a session within the worker limits (PM-399). Missing means on.
   */
  delegateToSessions?: boolean;
  /** Automatically continue explicitly enrolled sessions while fresh quota permits. Default off. */
  superviseSessions?: boolean;
  /** Ask the chat for its check when something changed in scope, within bounds (PM-418). Default off. */
  autoCheck?: boolean;
  /**
   * When a project in scope has nothing to do, its chat drafts the next cards from the project's
   * ROADMAP.md and Backlog (PM-426). Asked by the automatic check. Default off.
   */
  planFromGoals?: boolean;
  /**
   * The chat accepts finished work itself (PM-427): moving a Review card to Done with an evidence
   * note also accepts its finished runs, and sending it back to To do rejects them. Default off.
   */
  acceptReviews?: boolean;
  /**
   * The chat may push, open and merge pull requests and manage branches on its own through its
   * guarded git tool, as each project's own git identity (PM-428). Default off.
   */
  gitAutonomy?: boolean;
  projectIds: number[];
  /**
   * Projects whose work goes first (PM-430): the scheduler hands out their cards before any
   * other project's, and the chat is told to do the same. Empty or absent: fair rotation only.
   */
  priorityProjectIds?: number[];
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
  /** The full text behind a cut-off message (PM-452): GET /orchestrators/event-details/:id. */
  detailId?: number;
}

export type OrchestratorWaitReason =
  | 'active_worker'
  /** In progress under work this orchestrator did not start (PM-420): its chat decides. */
  | 'foreign_work'
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
  | 'no_provider_available'
  /** The machine is low on disk space or memory (PM-424): new workers wait. */
  | 'low_resources';

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
    /** Workers counted toward this orchestrator's limits: its own (PM-417). */
    managedWorkers: number;
    /** Every other live worker: the owner's sessions and other orchestrators' workers. */
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
    autonomy: 'edit' | 'read' | 'full';
    /** 'auto': the run uses Claude's auto mode, from Settings (PM-419). */
    permissionMode?: 'auto';
    supervisorAttempts: number;
    requiresReview: boolean;
  };
  providerBlockers?: OrchestratorProviderBlocker[];
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

/** One refresh boundary; failed optional sections retain their previous client data. */
export interface OrchestratorOverview {
  version: 1;
  generatedAt: string;
  state: OrchestratorState;
  projects: ProjectSummary[] | null;
  sessions: AgentSession[] | null;
  cards: OrchestratorCardSummary[] | null;
  unavailable: ('projects' | 'sessions' | 'cards')[];
}

export type OrchestratorCardSummary = Pick<
  CardWithProject,
  'id' | 'projectId' | 'key' | 'title' | 'status' | 'projectName'
>;

export interface OrchestratorProviderBlocker {
  providerId: string;
  /** Optional for older persisted/fixture responses; unknown codes get no invented action. */
  code?: 'unavailable' | 'capacity' | 'quota_unknown' | 'quota_reserve';
  detail: string;
}

/** Explicit progress reported by an orchestrator chat, scoped to its current session. */
export interface OrchestratorChatWork {
  sessionId: number;
  projectId: number;
  projectName: string;
  cardId: number | null;
  cardKey: string | null;
  title: string;
  reportedAt: string;
}

/** Goals (PM-433): objectives an orchestrator pursues until done. See server/orchestrator/goals.ts. */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'achieved' | 'dropped';
export interface GoalProgress {
  at: string;
  note: string;
  /** Who wrote it: the chat, the owner (page), or the automatic stall guard. */
  by: 'chat' | 'owner' | 'system';
}

/** One checkable acceptance criterion of a goal (PM-471). */
export interface GoalCriterion {
  id: number;
  text: string;
  state: 'open' | 'passing' | 'failing';
  /** What showed it passing or failing: a command and its result, a PR, a screenshot. */
  evidence?: string;
  checkedBy?: 'chat' | 'owner' | 'verifier';
  checkedAt?: string;
}

export interface OrchestratorGoal {
  id: number;
  title: string;
  objective: string;
  /** The condition that means achieved: checkable, so "done" needs evidence. */
  doneWhen: string;
  status: GoalStatus;
  createdAt: string;
  updatedAt: string;
  progress: GoalProgress[];
  /** The last automatic check that worked on it (ms). */
  lastNudgeAt?: number;
  /** Automatic checks since the chat last reported progress on it. */
  nudgesWithoutProgress?: number;
  /** The linked card set (sorted ids) the chat was last asked to close the goal for (PM-454). */
  closePromptedFor?: string;
  /** Projects it is about (PM-448); empty or missing means all of the orchestrator's projects. */
  projectIds?: number[];
  /** Cards that deliver it, like the tracked issues of an epic (PM-448). */
  cardIds?: number[];
  /**
   * The acceptance checklist (PM-471): achieved needs every criterion passing. Older goals have
   * none until the chat adds them.
   */
  criteria?: GoalCriterion[];
}

/** A card linked to a goal, as the owner and the chat see it (PM-448). */
export interface GoalCard {
  id: number;
  key: string;
  title: string;
  status: CardWithProject['status'];
  projectId: number;
  /** The live session or run on this card right now (PM-454). */
  worker?: { kind: 'session' | 'run'; id: number; name: string; state: string };
}

/** A goal with its projects named and its linked cards resolved (PM-448). */
export interface OrchestratorGoalView extends OrchestratorGoal {
  projects: { id: number; name: string }[];
  cards: GoalCard[];
  /** When the orchestrator last came back to it and when it will next (PM-454). */
  followUp: {
    lastCheckAt: string | null;
    nextCheckAt: string | null;
    note: string;
    /** Every linked card is Done and the next check verifies and closes it. */
    readyToClose?: boolean;
  };
}

/** A goal a card is linked to (PM-467), shown in the card dialog like an issue's parent epic. */
export interface CardGoal {
  orchestratorId: string;
  orchestratorName: string;
  goalId: number;
  title: string;
  status: GoalStatus;
}

/** A goal that reached achieved or blocked recently (PM-436), for the owner's notifications. */
export interface GoalEvent {
  orchestratorId: string;
  orchestratorName: string;
  goalId: number;
  title: string;
  /** stuck: still active, but nothing brings the chat back to it (paused, checks off, chat closed). */
  status: 'achieved' | 'blocked' | 'stuck';
  updatedAt: string;
  /** The latest progress note: the evidence, or what only the owner can do. For stuck, why. */
  note: string | null;
}
