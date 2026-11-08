import type { AgentRun, AgentSession, Card } from '../../shared/types.js';
import type { ProviderLimits } from '../../shared/limits.js';
import { MAX_SESSIONS_PER_PROJECT } from '../agents/supervisor.js';
import type {
  OrchestratorWaitReason,
  OrchestratorProviderBlocker,
} from '../../shared/orchestrator.js';

export type PlanningRun = Pick<
  AgentRun,
  'id' | 'projectId' | 'cardId' | 'providerId' | 'status' | 'validation'
> & { orchestratorId?: string | null; executionState?: AgentRun['executionState'] | null };

export interface OrchestratorPolicy {
  /** The orchestrator's id: its own runs carry it (`agent_runs.orchestrator_id`). */
  id?: string;
  projectIds: number[];
  /** Projects served before the rest (PM-430); rotation still applies within each group. */
  priorityProjectIds?: number[];
  providers: string[];
  maxWorkers: number;
  maxWorkersPerProject: number;
  maxWorkersPerProvider: number;
  reservePercent: number;
  allowUnknownQuota: boolean;
  quotaMaxAgeMs: number;
}
export interface OrchestratorDecision {
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
  providerBlockers?: (OrchestratorProviderBlocker & {
    code: NonNullable<OrchestratorProviderBlocker['code']>;
  })[];
}

export interface OrchestratorPlanningSnapshot {
  /** Session starts use the project's CLI slots rather than the run-worker allocation. */
  workerKind?: 'run' | 'session';
  cards: Card[];
  runs: PlanningRun[];
  sessions: AgentSession[];
  availableProviders: string[];
  limits: ProviderLimits[];
  blockedCardIds?: ReadonlySet<number>;
  /**
   * Sessions this orchestrator started or handed a card to (PM-417, `ownedSessionIds` in
   * ownedWorkers.ts). When given, the worker limits count only its own workers: those sessions
   * and the runs carrying its id. Every live worker still blocks its card and counts toward the
   * global safety cap. Without it every live worker counts, as before.
   */
  ownedSessionIds?: ReadonlySet<number>;
  /**
   * Cards this orchestrator has worked on (PM-420, `ownedCardIds`). When given, an In progress
   * card with no live worker is only recovered when it is one of these: other In progress cards
   * belong to work it did not start (often a session not linked to the card), and its chat
   * decides about them.
   */
  ownedCardIds?: ReadonlySet<number>;
  /**
   * Why the machine cannot take another worker now (PM-424, `resourceBlock` in resources.ts):
   * low disk space or memory. Cards that would start a worker wait with this reason.
   */
  resourceBlock?: string;
}

/** Pure scheduling: execution must revalidate the snapshot before dispatching. */
export function planOrchestration(
  policy: OrchestratorPolicy,
  snapshot: OrchestratorPlanningSnapshot,
  now = Date.now(),
): OrchestratorDecision[] {
  const scope = (projectId: number) =>
    !policy.projectIds.length || policy.projectIds.includes(projectId);
  const workers = [
    ...snapshot.runs.filter((r) => r.status === 'running' || r.status === 'queued'),
    ...snapshot.sessions.filter((s) => s.status === 'running'),
  ];
  const owned = snapshot.ownedSessionIds;
  // The workers the limits count: with ownership known, only this orchestrator's own.
  const managed = owned
    ? [
        ...snapshot.runs.filter(
          (r) =>
            (r.status === 'running' || r.status === 'queued') &&
            policy.id != null &&
            r.orchestratorId === policy.id,
        ),
        ...snapshot.sessions.filter((s) => s.status === 'running' && owned.has(s.id)),
      ].filter((w) => scope(w.projectId))
    : workers.filter((w) => scope(w.projectId));
  const externalWorkers = owned
    ? workers.filter((w) => !managed.includes(w))
    : workers.filter((w) => !scope(w.projectId));
  let totalScoped = managed.length;
  let totalWorkers = workers.length;
  const GLOBAL_SAFETY_CAP = 32;

  const projectCounts = new Map<number, number>();
  const providerCounts = new Map<string, number>();
  const liveCards = new Set<number>();
  for (const worker of owned ? managed : workers) {
    projectCounts.set(worker.projectId, (projectCounts.get(worker.projectId) ?? 0) + 1);
    providerCounts.set(worker.providerId, (providerCounts.get(worker.providerId) ?? 0) + 1);
  }
  for (const worker of workers) if (worker.cardId != null) liveCards.add(worker.cardId);
  const latestRuns = new Map<number, PlanningRun>();
  for (const run of snapshot.runs) {
    if (run.cardId != null && run.id > (latestRuns.get(run.cardId)?.id ?? -1))
      latestRuns.set(run.cardId, run);
  }
  const projectCount = (id: number) => projectCounts.get(id) ?? 0;
  const providerCount = (id: string) => providerCounts.get(id) ?? 0;
  const reservedProjects = new Map<number, number>();
  const reservedProviders = new Map<string, number>();
  const decisions: OrchestratorDecision[] = [];
  const orderedCards = snapshot.cards
    .filter((c) => scope(c.projectId) && ['todo', 'in_progress', 'review'].includes(c.status))
    .sort(
      (a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
    );
  const queues = new Map<number, Card[]>();
  for (const card of orderedCards) {
    const queue = queues.get(card.projectId) ?? [];
    queue.push(card);
    queues.set(card.projectId, queue);
  }
  // Prefer projects least recently served, then alternate their board-ordered tasks. Priority
  // projects (PM-430) form their own group, taken in full before the rest get a turn.
  const lastServed = new Map<number, number>();
  for (const run of snapshot.runs)
    if (scope(run.projectId) && run.cardId != null)
      lastServed.set(run.projectId, Math.max(lastServed.get(run.projectId) ?? 0, run.id));
  const priority = new Set(policy.priorityProjectIds ?? []);
  const byService = (a: number, b: number) => (lastServed.get(a) ?? 0) - (lastServed.get(b) ?? 0);
  const all = [...queues.keys()];
  const cards: Card[] = [];
  for (const group of [all.filter((p) => priority.has(p)), all.filter((p) => !priority.has(p))]) {
    group.sort(byService);
    const longest = Math.max(0, ...group.map((p) => queues.get(p)!.length));
    for (let index = 0; index < longest; index++)
      for (const project of group) {
        const card = queues.get(project)?.[index];
        if (card) cards.push(card);
      }
  }
  for (const card of cards) {
    const decide = (
      action: OrchestratorDecision['action'],
      reason: string,
      providerId?: string,
      waitReason?: OrchestratorWaitReason,
      providerBlockers?: OrchestratorDecision['providerBlockers'],
    ) =>
      decisions.push({
        cardId: card.id,
        projectId: card.projectId,
        action,
        reason,
        ...(providerId ? { providerId } : {}),
        ...(waitReason ? { waitReason } : {}),
        occupancy: {
          managedWorkers: totalScoped,
          externalWorkers: externalWorkers.length,
          projectWorkers: projectCount(card.projectId),
        },
        ...(providerBlockers?.length ? { providerBlockers } : {}),
      });

    if (liveCards.has(card.id)) {
      decide('wait', 'Already assigned to a live worker', undefined, 'active_worker');
      continue;
    }
    const latest = latestRuns.get(card.id);
    if (
      card.status === 'review' ||
      (latest && ['succeeded', 'failed'].includes(latest.status) && !latest.validation)
    ) {
      decide(
        'review',
        'Completion or failure needs review before more work is assigned',
        undefined,
        'review_required',
      );
      continue;
    }
    if (
      card.status === 'in_progress' &&
      snapshot.ownedCardIds &&
      !snapshot.ownedCardIds.has(card.id)
    ) {
      decide(
        'wait',
        'In progress under work this orchestrator did not start; its chat decides',
        undefined,
        'foreign_work',
      );
      continue;
    }
    if (snapshot.blockedCardIds?.has(card.id)) {
      decide(
        'wait',
        'Assignment reserved or retry cooldown/budget reached',
        undefined,
        'assignment_reserved',
      );
      continue;
    }
    if (totalWorkers >= GLOBAL_SAFETY_CAP) {
      decide('wait', 'Worker capacity reached', undefined, 'global_capacity');
      continue;
    }
    // Session starts follow only the project's CLI limit; the orchestrator's total and
    // per-provider worker limits cap run workers (PM-571). The machine-wide safety cap holds.
    const sessionStart = snapshot.workerKind === 'session';
    if (!sessionStart && totalScoped >= policy.maxWorkers) {
      decide('wait', 'Worker capacity reached', undefined, 'managed_capacity');
      continue;
    }
    const projectLimit = sessionStart ? MAX_SESSIONS_PER_PROJECT : policy.maxWorkersPerProject;
    const projectOccupancy = sessionStart
      ? snapshot.sessions.filter((s) => s.projectId === card.projectId && !s.orchestratorId).length
      : projectCount(card.projectId);
    if (projectOccupancy + (reservedProjects.get(card.projectId) ?? 0) >= projectLimit) {
      decide(
        'wait',
        sessionStart
          ? `Project CLI limit reached (${projectLimit} sessions)`
          : 'Worker capacity reached',
        undefined,
        'project_capacity',
      );
      continue;
    }
    if (snapshot.resourceBlock) {
      decide('wait', snapshot.resourceBlock, undefined, 'low_resources');
      continue;
    }
    const providerBlockers: NonNullable<OrchestratorDecision['providerBlockers']> = [];
    const eligible = policy.providers.filter((providerId) => {
      const block = (code: NonNullable<OrchestratorProviderBlocker['code']>, detail: string) => {
        providerBlockers.push({ providerId, code, detail });
        return false;
      };
      if (!snapshot.availableProviders.includes(providerId))
        return block('unavailable', 'CLI unavailable; check installation and PATH');
      if (
        !sessionStart &&
        providerCount(providerId) + (reservedProviders.get(providerId) ?? 0) >=
          policy.maxWorkersPerProvider
      )
        return block('capacity', 'Provider worker limit reached; wait for a worker to finish');
      const limits = snapshot.limits.find((l) => l.providerId === providerId);
      if (
        !limits ||
        !limits.windows.length ||
        !Number.isFinite(Date.parse(limits.asOf)) ||
        Date.parse(limits.asOf) > now ||
        now - Date.parse(limits.asOf) > policy.quotaMaxAgeMs
      )
        return (
          policy.allowUnknownQuota ||
          block('quota_unknown', 'Quota missing or stale; obtain a fresh usage report')
        );
      const validPercent = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;
      // A known exhausted window takes precedence over another malformed window. A window whose
      // reset has passed since the report is not known any more (its old percentage is stale), so
      // it falls through to the "obtain a fresh usage report" check below.
      if (
        limits.windows.some(
          (w) =>
            !w.resetSinceReport &&
            validPercent(w.usedPercent) &&
            w.usedPercent >= 100 - policy.reservePercent,
        )
      )
        return block(
          'quota_reserve',
          `Quota reaches the ${policy.reservePercent}% reserve; wait for renewed allowance and a fresh usage report`,
        );
      if (limits.windows.some((w) => w.resetSinceReport))
        return (
          policy.allowUnknownQuota ||
          block(
            'quota_unknown',
            'Allowance reset since the last report; obtain a fresh usage report before dispatch',
          )
        );
      if (limits.windows.some((w) => !validPercent(w.usedPercent)))
        return (
          policy.allowUnknownQuota ||
          block('quota_unknown', 'Quota report contains invalid usage; obtain a fresh usage report')
        );
      return true;
    });
    const providerId = eligible[0];
    if (!providerId) {
      const waitReason: OrchestratorWaitReason = providerBlockers.some((b) => b.code === 'capacity')
        ? 'provider_capacity'
        : providerBlockers.some((b) => b.code === 'quota_reserve')
          ? 'quota_exceeded'
          : providerBlockers.some((b) => b.code === 'quota_unknown')
            ? 'quota_unknown'
            : 'no_provider_available';
      decide('wait', 'No eligible provider', undefined, waitReason, providerBlockers);
      continue;
    }
    totalScoped++;
    totalWorkers++;
    reservedProjects.set(card.projectId, (reservedProjects.get(card.projectId) ?? 0) + 1);
    reservedProviders.set(providerId, (reservedProviders.get(providerId) ?? 0) + 1);
    decide(
      'dispatch',
      card.status === 'in_progress'
        ? 'Recover work with no live worker'
        : 'Start the next ready board task',
      providerId,
    );
  }
  return decisions;
}
