import type { AgentRun, AgentSession, Card } from '../../shared/types.js';
import type { ProviderLimits } from '../../shared/limits.js';
import type {
  OrchestratorWaitReason,
  OrchestratorProviderBlocker,
} from '../../shared/orchestrator.js';

export type PlanningRun = Pick<
  AgentRun,
  'id' | 'projectId' | 'cardId' | 'providerId' | 'status' | 'validation'
> & { orchestratorId?: string | null; executionState?: AgentRun['executionState'] | null };

export interface OrchestratorPolicy {
  projectIds: number[];
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

/** Pure scheduling: execution must revalidate the snapshot before dispatching. */
export function planOrchestration(
  policy: OrchestratorPolicy,
  snapshot: {
    cards: Card[];
    runs: PlanningRun[];
    sessions: AgentSession[];
    availableProviders: string[];
    limits: ProviderLimits[];
    blockedCardIds?: ReadonlySet<number>;
  },
  now = Date.now(),
): OrchestratorDecision[] {
  const scope = (projectId: number) =>
    !policy.projectIds.length || policy.projectIds.includes(projectId);
  const workers = [
    ...snapshot.runs.filter((r) => r.status === 'running' || r.status === 'queued'),
    ...snapshot.sessions.filter((s) => s.status === 'running'),
  ];
  const scopedWorkers = workers.filter((w) => scope(w.projectId));
  const externalWorkers = workers.filter((w) => !scope(w.projectId));
  let totalScoped = scopedWorkers.length;
  let totalWorkers = workers.length;
  const GLOBAL_SAFETY_CAP = 32;

  const projectCounts = new Map<number, number>();
  const providerCounts = new Map<string, number>();
  const liveCards = new Set<number>();
  for (const worker of workers) {
    projectCounts.set(worker.projectId, (projectCounts.get(worker.projectId) ?? 0) + 1);
    providerCounts.set(worker.providerId, (providerCounts.get(worker.providerId) ?? 0) + 1);
    if (worker.cardId != null) liveCards.add(worker.cardId);
  }
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
  // Prefer projects least recently served, then alternate their board-ordered tasks.
  const lastServed = new Map<number, number>();
  for (const run of snapshot.runs)
    if (scope(run.projectId) && run.cardId != null)
      lastServed.set(run.projectId, Math.max(lastServed.get(run.projectId) ?? 0, run.id));
  const projects = [...queues.keys()].sort(
    (a, b) => (lastServed.get(a) ?? 0) - (lastServed.get(b) ?? 0),
  );
  const cards: Card[] = [];
  const longest = Math.max(0, ...[...queues.values()].map((queue) => queue.length));
  for (let index = 0; index < longest; index++)
    for (const project of projects) {
      const card = queues.get(project)?.[index];
      if (card) cards.push(card);
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
    if (totalScoped >= policy.maxWorkers) {
      decide('wait', 'Worker capacity reached', undefined, 'managed_capacity');
      continue;
    }
    if (
      projectCount(card.projectId) + (reservedProjects.get(card.projectId) ?? 0) >=
      policy.maxWorkersPerProject
    ) {
      decide('wait', 'Worker capacity reached', undefined, 'project_capacity');
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
      // A known exhausted window takes precedence over another malformed window.
      if (
        limits.windows.some(
          (w) => validPercent(w.usedPercent) && w.usedPercent >= 100 - policy.reservePercent,
        )
      )
        return block(
          'quota_reserve',
          `Quota reaches the ${policy.reservePercent}% reserve; wait for renewed allowance and a fresh usage report`,
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
