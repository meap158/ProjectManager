import { OrchestratorAssignments } from './assignments.js';
import { randomUUID } from 'node:crypto';
import type { Db } from '../db.js';
import type { AgentSupervisor } from '../agents/supervisor.js';
import { getSetting, setSetting, getCard, listCards, listCardsInFlight } from '../store.js';
import { providerStatuses } from '../agents/providers.js';
import { readLimits } from '../agents/limits.js';
import type {
  OrchestratorConfig,
  OrchestratorEvent,
  OrchestratorSituation,
  OrchestratorState,
} from '../../shared/orchestrator.js';
import { buildSituation, cardContext } from './situation.js';
import { situationRunIds } from './situationRuns.js';
import { planOrchestration } from './planner.js';
import { planningRuns } from './planningRuns.js';
import { liveRunProjects } from './liveProjects.js';
import { attentionRunIds } from './attentionRuns.js';
import {
  clearDismissedAttention,
  dismissProjectAttention,
  followProjectAttention,
  getDismissedAttention,
  pruneProjectAttention,
} from './attention.js';
import type { ProjectSummary } from '../../shared/types.js';

const KEY = 'master-orchestrators';
export class OrchestratorService {
  private owner = randomUUID();
  private executing = false;
  private currentExecution: Promise<void> | null = null;
  private pendingTick: {
    instanceId?: string;
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: unknown) => void;
  } | null = null;
  private lastTickAt: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private started = false;
  private generation = 0;
  constructor(
    private db: Db,
    private supervisor: AgentSupervisor,
    private dataDir: string | null,
    private attentionProjects?: () => ProjectSummary[],
  ) {}
  state(): OrchestratorState {
    const saved = getSetting<OrchestratorState>(this.db, KEY) ?? { instances: [], events: [] };
    return {
      ...saved,
      status: {
        executing: this.executing,
        lastTickAt: this.lastTickAt,
      },
    };
  }
  /**
   * What this orchestrator sees of Home (PM-70): needs attention and being worked on, with the
   * identity to trace each item back. Limited to one master's projects when given.
   */
  situation(instanceId?: string): OrchestratorSituation | null {
    const instance = instanceId ? this.state().instances.find((i) => i.id === instanceId) : null;
    if (instanceId && !instance) return null;
    return buildSituation({
      projects: this.attentionProjects?.() ?? [],
      cards: listCardsInFlight(this.db),
      sessions: this.supervisor.listAllSessions(),
      runs: situationRunIds(this.db, instance?.projectIds).flatMap((id) => {
        const run = this.supervisor.getRun(id);
        return run ? [run] : [];
      }),
      dismissed: (projectId) => getDismissedAttention(this.db, projectId),
      screen: (sessionId) => this.supervisor.sessionScreen(sessionId),
      projectIds: instance?.projectIds,
    });
  }

  async preview(id: string, offset = 0, limit = 100) {
    const instance = this.state().instances.find((i) => i.id === id);
    if (!instance) return null;
    const projects = this.db.prepare('SELECT id FROM projects').all() as { id: number }[];
    const providers = await providerStatuses();
    const decisions = planOrchestration(instance, {
      cards: projects
        .filter((p) => !instance.projectIds.length || instance.projectIds.includes(p.id))
        .flatMap((p) => listCards(this.db, p.id)),
      runs: planningRuns(this.db, instance.projectIds),
      sessions: this.supervisor.listAllSessions(),
      availableProviders: providers.filter((p) => p.available).map((p) => p.id),
      limits: readLimits(this.dataDir),
      blockedCardIds: new OrchestratorAssignments(this.db).blockedCards(),
    });
    const page = decisions.slice(offset, offset + limit);
    const retryPlans = new OrchestratorAssignments(this.db).retryPlans(
      Date.now(),
      page.map((decision) => decision.cardId),
    );
    return {
      at: new Date().toISOString(),
      enabled: instance.enabled,
      strategy: instance.strategy ?? 'autonomous',
      total: decisions.length,
      offset,
      limit,
      summary: {
        dispatch: decisions.filter((d) => d.action === 'dispatch').length,
        review: decisions.filter((d) => d.action === 'review').length,
        wait: decisions.filter((d) => d.action === 'wait').length,
      },
      decisions: page.map((decision) => ({
        ...decision,
        retry: retryPlans.get(decision.cardId) ?? {
          attemptsUsed: 0,
          attemptsRemaining: 3,
          retryAt: null,
          blocker: null,
        },
        execution: { autonomy: 'edit' as const, supervisorAttempts: 1, requiresReview: true },
      })),
    };
  }
  save(input: Omit<OrchestratorConfig, 'id'> & { id?: string }): OrchestratorConfig {
    const state = this.state();
    const instance = { ...input, id: input.id ?? randomUUID() };
    const index = state.instances.findIndex((i) => i.id === instance.id);
    if (index < 0) state.instances.push(instance);
    else state.instances[index] = instance;
    setSetting(this.db, KEY, state);
    return instance;
  }
  clearEvents(): void {
    const state = this.state();
    state.events = [];
    setSetting(this.db, KEY, state);
  }
  delete(id: string): boolean {
    const state = this.state();
    const index = state.instances.findIndex((i) => i.id === id);
    if (index < 0) return false;
    state.instances.splice(index, 1);
    setSetting(this.db, KEY, state);
    return true;
  }
  pruneAttention(
    instanceId?: string,
    projectId?: number,
  ): { prunedCards: number[]; prunedProjects: number[] } {
    const state = this.state();
    const instances = state.instances.filter((i) => !instanceId || i.id === instanceId);
    const projects = this.attentionProjects?.() ?? [];
    const prunedCards: number[] = [];
    const prunedProjects: number[] = [];

    for (const inst of instances) {
      const scopedProjects = inst.projectIds.length
        ? projects.filter(
            (p) => inst.projectIds.includes(p.id) && (!projectId || p.id === projectId),
          )
        : projects.filter((p) => !projectId || p.id === projectId);
      for (const p of scopedProjects) {
        const result = pruneProjectAttention(this.db, p);
        if (result.prunedCardId) {
          prunedCards.push(result.prunedCardId);
          if (!prunedProjects.includes(p.id)) prunedProjects.push(p.id);
          this.event({
            orchestratorId: inst.id,
            cardId: result.prunedCardId,
            action: 'pruned',
            message: `Pruned resolved Dashboard attention follow-up for ${p.name}`,
          });
        }
      }
    }
    return { prunedCards, prunedProjects };
  }
  dismissAttention(
    projectId: number,
    kinds?: string[],
  ): { dismissed: string[]; prunedCardId: number | null } {
    const res = dismissProjectAttention(this.db, projectId, kinds);
    if (res.prunedCardId) {
      for (const inst of this.state().instances) {
        if (!inst.projectIds.length || inst.projectIds.includes(projectId)) {
          this.event({
            orchestratorId: inst.id,
            cardId: res.prunedCardId,
            action: 'pruned',
            message: `Dismissed attention for Project ${projectId}`,
          });
        }
      }
    }
    return res;
  }
  clearDismissedAttention(projectId: number): void {
    clearDismissedAttention(this.db, projectId);
  }
  async resolveAttention(
    orchestratorId?: string,
    projectId?: number,
  ): Promise<{ resolvedCards: number[]; dispatchedRuns: number[] }> {
    const instances = orchestratorId
      ? this.state().instances.filter((i) => i.id === orchestratorId)
      : this.state().instances;
    const projects = this.attentionProjects?.() ?? [];
    const resolvedCards: number[] = [];

    for (const inst of instances) {
      const scopedProjects = inst.projectIds.length
        ? projects.filter(
            (p) => inst.projectIds.includes(p.id) && (!projectId || p.id === projectId),
          )
        : projects.filter((p) => !projectId || p.id === projectId);

      for (const p of scopedProjects) {
        clearDismissedAttention(this.db, p.id);
        const cardId = followProjectAttention(this.db, p);
        const actualCardId =
          cardId ??
          getSetting<{ cardId: number }>(this.db, `orchestrator-attention:${p.id}`)?.cardId;
        if (actualCardId) {
          resolvedCards.push(actualCardId);
        }
      }
    }
    const cardIds = [...new Set(resolvedCards)];
    const previousRuns = new Set(attentionRunIds(this.db, cardIds));
    await this.tick(orchestratorId);
    const dispatchedRuns = attentionRunIds(this.db, cardIds).filter((id) => !previousRuns.has(id));
    return { resolvedCards: cardIds, dispatchedRuns };
  }
  /** Records something done outside a tick (the master's chat, PM-89) in Decision history. */
  record(event: Omit<OrchestratorEvent, 'at'>): void {
    this.event(event);
  }
  private event(event: Omit<OrchestratorEvent, 'at'>) {
    const state = this.state();
    const last = [...state.events]
      .reverse()
      .find(
        (previous) =>
          previous.orchestratorId === event.orchestratorId && previous.cardId === event.cardId,
      );
    if (
      last &&
      last.orchestratorId === event.orchestratorId &&
      last.cardId === event.cardId &&
      last.action === event.action &&
      last.message === event.message
    ) {
      // These are state observations, not new occurrences. Preserve transition time
      // and avoid rewriting the entire settings blob every idle tick.
      if (['wait', 'review', 'observe'].includes(event.action)) return;
      state.events = [...state.events, { ...event, count: 1, at: new Date().toISOString() }].slice(
        -500,
      );
      setSetting(this.db, KEY, state);
      return;
    }
    state.events = [...state.events, { ...event, count: 1, at: new Date().toISOString() }].slice(
      -500,
    );
    setSetting(this.db, KEY, state);
  }
  start() {
    if (this.started) return;
    this.started = true;
    const generation = ++this.generation;
    const schedule = () => {
      if (!this.started || generation !== this.generation) return;
      this.timer = setTimeout(() => {
        void this.tick()
          .catch((e: Error) => console.error('[orchestrator]', e.message))
          .finally(schedule);
      }, 30000);
      this.timer.unref();
    };
    schedule();
  }
  stop(): Promise<void> {
    this.started = false;
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pendingTick) {
      this.pendingTick.resolve();
      this.pendingTick = null;
    }
    return this.currentExecution ?? Promise.resolve();
  }

  tick(instanceId?: string): Promise<void> {
    if (!this.executing) {
      this.executing = true;
      const execution = this.runTick(instanceId).finally(() => {
        this.executing = false;
        this.currentExecution = null;
        this.checkPendingTick();
      });
      this.currentExecution = execution;
      return execution;
    }

    if (!this.pendingTick) {
      let resolve!: () => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.pendingTick = {
        instanceId,
        promise,
        resolve,
        reject,
      };
    } else {
      if (!instanceId || this.pendingTick.instanceId !== instanceId) {
        this.pendingTick.instanceId = undefined;
      }
    }
    return this.pendingTick.promise;
  }

  private checkPendingTick() {
    if (!this.pendingTick) return;
    const pending = this.pendingTick;
    this.pendingTick = null;
    this.executing = true;
    const execution = this.runTick(pending.instanceId)
      .finally(() => {
        this.executing = false;
        this.currentExecution = null;
        this.checkPendingTick();
      })
      .then(() => pending.resolve())
      .catch((err) => pending.reject(err));
    this.currentExecution = execution;
  }

  private async runTick(instanceId?: string) {
    this.lastTickAt = new Date().toISOString();
    await this.execute(instanceId);
  }

  private async execute(instanceId?: string) {
    // Paused masters need no provider subprocesses, run-history scans or lease writes.
    if (!this.state().instances.some((i) => i.enabled && (!instanceId || i.id === instanceId)))
      return;
    const assignments = new OrchestratorAssignments(this.db);
    if (!assignments.lease(this.owner)) return;
    const epoch = assignments.currentLease()?.epoch ?? 1;
    const heartbeat = setInterval(() => assignments.renew(this.owner, epoch), 30000);
    heartbeat.unref();
    try {
      await this.executeLeased(assignments, epoch, instanceId);
    } finally {
      clearInterval(heartbeat);
      assignments.release(this.owner, epoch);
    }
  }

  private async executeLeased(
    assignments: OrchestratorAssignments,
    epoch: number,
    instanceId?: string,
  ) {
    assignments.reconcile();
    const providers = (await providerStatuses()).filter((p) => p.available).map((p) => p.id);
    if (!assignments.isLeaseValid(this.owner, epoch)) return;
    for (const initial of this.state().instances.filter(
      (i) => i.enabled && (!instanceId || i.id === instanceId),
    )) {
      if (
        initial.strategy !== 'observe' &&
        (initial.followDashboardAttention || initial.pruneDashboardAttention)
      ) {
        const busy = new Set([
          ...this.supervisor
            .listAllSessions()
            .filter((s) => s.status === 'running')
            .map((s) => s.projectId),
          ...liveRunProjects(this.db),
        ]);
        for (const project of this.attentionProjects?.() ?? []) {
          if (
            busy.has(project.id) ||
            (initial.projectIds.length && !initial.projectIds.includes(project.id))
          )
            continue;
          if (initial.pruneDashboardAttention ?? true) {
            const pruneResult = pruneProjectAttention(this.db, project);
            if (pruneResult.prunedCardId) {
              this.event({
                orchestratorId: initial.id,
                cardId: pruneResult.prunedCardId,
                action: 'pruned',
                message: `Pruned resolved Dashboard attention follow-up for ${project.name}`,
              });
            }
          }
          if (initial.followDashboardAttention) {
            const cardId = followProjectAttention(this.db, project);
            if (cardId)
              this.event({
                orchestratorId: initial.id,
                cardId,
                action: 'follow-up',
                message: 'Created Dashboard attention follow-up',
              });
          }
        }
      }
      const projects = this.db.prepare('SELECT id FROM projects').all() as { id: number }[];

      const snapshot = () => ({
        cards: projects
          .filter((p) => !initial.projectIds.length || initial.projectIds.includes(p.id))
          .flatMap((p) => listCards(this.db, p.id)),
        runs: planningRuns(this.db, initial.projectIds),
        sessions: this.supervisor.listAllSessions(),
        availableProviders: providers,
        limits: readLimits(this.dataDir),
        blockedCardIds: assignments.blockedCards(),
      });
      const decisions = planOrchestration(initial, snapshot());
      for (const decision of decisions) {
        const current = this.state().instances.find((i) => i.id === initial.id);
        if (!current?.enabled) break;
        if (current.strategy === 'observe') {
          this.event({
            orchestratorId: initial.id,
            cardId: decision.cardId,
            action: 'observe',
            message: `${decision.action === 'dispatch' ? 'Would dispatch' : decision.action}: ${decision.reason}`,
          });
          continue;
        }
        // Waiting/review proposals cannot launch work. Re-read expensive snapshots only
        // for potential dispatches; a newly eligible wait is picked up on the next check.
        if (decision.action !== 'dispatch') {
          this.event({
            orchestratorId: initial.id,
            cardId: decision.cardId,
            action: decision.action,
            message: decision.reason,
          });
          continue;
        }
        const fresh = planOrchestration(current, snapshot()).find(
          (d) => d.cardId === decision.cardId,
        );
        if (!fresh || fresh.action !== 'dispatch' || !fresh.providerId) {
          this.event({
            orchestratorId: initial.id,
            cardId: decision.cardId,
            action: fresh?.action ?? 'wait',
            message: fresh?.reason ?? 'Outside current scope',
          });
          continue;
        }
        const task = getCard(this.db, fresh.cardId);
        if (!task) continue;
        // Capture the instructions before any asynchronous dispatch preparation. A newer
        // revision must be planned on a later tick rather than launching this stale intent.
        const taskRevision = {
          title: task.title,
          description: task.description,
          status: task.status,
          updatedAt: task.updatedAt,
        };
        // Fenced lease renewal before claiming
        if (!assignments.renew(this.owner, epoch)) return;
        if (!assignments.claim(fresh.cardId, initial.id, Date.now(), this.owner, epoch)) {
          this.event({
            orchestratorId: initial.id,
            cardId: fresh.cardId,
            action: 'wait',
            message: 'Assignment reserved, awaiting review, or retry cooldown/budget reached',
          });
          continue;
        }
        this.event({
          orchestratorId: initial.id,
          cardId: fresh.cardId,
          action: 'dispatching',
          message: `Assigning to ${fresh.providerId}`,
        });
        const dispatchKey = assignments.dispatchKey(fresh.cardId);
        let superseded = false;
        try {
          // The worker starts from what Home shows about this card and its project.
          const situation = this.situation(initial.id);
          const run = await this.supervisor.dispatchCard(fresh.projectId, fresh.cardId, {
            providerId: fresh.providerId,
            context: situation ? cardContext(situation, fresh.cardId) : undefined,
            maxAttempts: 1,
            dispatchKey,
            canCommit: () => {
              superseded = false;
              const policy = this.state().instances.find((instance) => instance.id === initial.id);
              if (
                !assignments.isLeaseValid(this.owner, epoch) ||
                !policy?.enabled ||
                policy.strategy === 'observe' ||
                !policy.providers.includes(fresh.providerId!)
              )
                return false;
              const latest = snapshot();
              const latestTask = latest.cards.find((card) => card.id === fresh.cardId);
              if (
                !latestTask ||
                latestTask.title !== taskRevision.title ||
                latestTask.description !== taskRevision.description ||
                latestTask.status !== taskRevision.status ||
                latestTask.updatedAt !== taskRevision.updatedAt
              ) {
                superseded = true;
                return false;
              }
              // The current dispatch owns this reservation; all other claims stay blocked.
              latest.blockedCardIds.delete(fresh.cardId);
              const checked = planOrchestration(
                { ...policy, providers: [fresh.providerId!] },
                {
                  ...latest,
                  cards: latest.cards.filter((card) => card.id === fresh.cardId),
                },
              )[0];
              return checked?.action === 'dispatch';
            },
          });
          // Fenced lease renewal after dispatch completes
          if (!assignments.renew(this.owner, epoch)) return;
          assignments.assigned(fresh.cardId, run.id, this.owner, epoch);
          this.event({
            orchestratorId: initial.id,
            cardId: fresh.cardId,
            runId: run.id,
            action: 'dispatched',
            message: `Worker ${run.id} started with ${fresh.providerId}`,
          });
        } catch (e) {
          if (
            superseded &&
            dispatchKey &&
            assignments.superseded(fresh.cardId, dispatchKey, this.owner, epoch)
          ) {
            this.event({
              orchestratorId: initial.id,
              cardId: fresh.cardId,
              action: 'wait',
              message:
                'Task changed before launch; the updated instructions will be reconsidered on the next check',
            });
            continue;
          }
          if (!assignments.failed(fresh.cardId, Date.now(), this.owner, epoch)) return;
          this.event({
            orchestratorId: initial.id,
            cardId: fresh.cardId,
            action: 'error',
            message: (e as Error).message,
          });
        }
      }
    }
  }
}
