import type {
  OrchestratorSituation,
  SituationCard,
  SituationItem,
  SituationWorker,
} from '../../shared/orchestrator.js';
import { projectAttention } from '../../shared/projectAttention.js';
import type {
  AgentRun,
  AgentSession,
  CardWithProject,
  ProjectSummary,
} from '../../shared/types.js';

// What an orchestrator sees of Home (PM-70): the dashboard's "Needs attention" and "Being worked
// on", widened with the agent signals Home shows elsewhere (sessions asking for input, finished
// runs awaiting review, stalled cards), and enough identity (card, session, run, commit) on every
// item to trace it back and resolve it. Pure: the service hands in the current state.

/** In progress with no live worker and no change for this long counts as stalled. */
export const STALLED_MS = 24 * 3_600_000;
const SUMMARY_CHARS = 280;
export type SituationRun = Pick<
  AgentRun,
  | 'id'
  | 'projectId'
  | 'cardId'
  | 'name'
  | 'providerId'
  | 'status'
  | 'validation'
  | 'changes'
  | 'endedAt'
>;

export interface SituationInput {
  projects: ProjectSummary[];
  /** Cards in progress or in review (store.listCardsInFlight). */
  cards: CardWithProject[];
  sessions: AgentSession[];
  runs: SituationRun[];
  /** Per project: Home attention kinds the user dismissed. */
  dismissed?: (projectId: number) => string[];
  /** What a session is showing right now (for "needs input": what it asks). */
  screen?: (sessionId: number) => string | null;
  /** Limit to these projects (empty or absent: all). */
  projectIds?: number[];
  now?: number;
}

export function buildSituation(input: SituationInput, includeWork = true): OrchestratorSituation {
  const now = input.now ?? Date.now();
  const inScope = (id: number) => !input.projectIds?.length || input.projectIds.includes(id);
  const names = new Map(input.projects.map((p) => [p.id, p.name]));
  const name = (id: number) => names.get(id) ?? `Project ${id}`;
  const needsAttention: SituationItem[] = [];

  // Home's project alerts, as the dashboard shows them (dismissed kinds left out).
  for (const project of input.projects.filter((p) => inScope(p.id))) {
    for (const item of projectAttention(project, now, input.dismissed?.(project.id) ?? [])) {
      needsAttention.push({
        kind: 'project-alert',
        projectId: project.id,
        projectName: project.name,
        title: `${item.kind}: ${project.name}`,
        detail: item.detail,
      });
    }
  }

  const liveSessions = input.sessions.filter((s) => s.status === 'running' && inScope(s.projectId));
  for (const s of liveSessions.filter((x) => x.tailState === 'input')) {
    const asking = input.screen?.(s.id)?.trim();
    needsAttention.push({
      kind: 'needs-input',
      projectId: s.projectId,
      projectName: name(s.projectId),
      title: `${s.name} is waiting for your choice`,
      detail: asking ? `On screen: ${asking}` : 'The agent is asking you to choose or approve.',
      sessionId: s.id,
      cardId: s.cardId ?? undefined,
      cardKey: s.cardKey ?? undefined,
      since: s.lastOutputAt ?? undefined,
    });
  }

  const latestRun = new Map<number, SituationRun>();
  for (const r of includeWork ? input.runs : []) {
    if (r.cardId != null && r.id > (latestRun.get(r.cardId)?.id ?? -1)) latestRun.set(r.cardId, r);
  }
  const cardKeys = new Map(input.cards.map((c) => [c.id, c.key]));
  const finished = (r: SituationRun) => r.status === 'succeeded' || r.status === 'failed';
  for (const r of input.runs.filter((x) => finished(x) && !x.validation && inScope(x.projectId))) {
    const files = r.changes?.files.length ?? 0;
    needsAttention.push({
      kind: 'awaiting-review',
      projectId: r.projectId,
      projectName: name(r.projectId),
      title: `Review run ${r.id}: ${r.name}`,
      detail: `${r.status === 'failed' ? 'Failed' : 'Finished'}; ${files} file${files === 1 ? '' : 's'} changed, ${r.changes?.commits ?? 0} commit(s). Accept or reject it.`,
      runId: r.id,
      cardId: r.cardId ?? undefined,
      cardKey: (r.cardId != null && cardKeys.get(r.cardId)) || undefined,
      since: r.endedAt ?? undefined,
    });
  }

  // Index live workers once; historical runs must not be rescanned for every card.
  const workersByCard = new Map<number, SituationWorker[]>();
  const addWorker = (cardId: number, worker: SituationWorker) => {
    const workers = workersByCard.get(cardId) ?? [];
    workers.push(worker);
    workersByCard.set(cardId, workers);
  };
  for (const s of liveSessions) {
    if (s.cardId != null)
      addWorker(s.cardId, {
        kind: 'session',
        id: s.id,
        name: s.name,
        providerId: s.providerId,
        state: s.tailState ?? 'unknown',
        lastOutputAt: s.lastOutputAt,
      });
  }
  for (const r of input.runs) {
    if (
      r.cardId != null &&
      inScope(r.projectId) &&
      (r.status === 'running' || r.status === 'queued')
    )
      addWorker(r.cardId, {
        kind: 'run',
        id: r.id,
        name: r.name,
        providerId: r.providerId,
        state: r.status,
      });
  }

  const beingWorkedOn: SituationCard[] = input.cards
    .filter((c) => (c.status === 'in_progress' || c.status === 'review') && inScope(c.projectId))
    .flatMap((c) => {
      const run = latestRun.get(c.id) ?? null;
      const workers = workersByCard.get(c.id) ?? [];
      if (
        c.status === 'in_progress' &&
        workers.length === 0 &&
        now - Date.parse(c.updatedAt) > STALLED_MS
      ) {
        needsAttention.push({
          kind: 'stalled',
          projectId: c.projectId,
          projectName: c.projectName,
          title: `${c.key} has stalled: ${c.title}`,
          detail: `In progress with no live worker since ${c.updatedAt}.`,
          cardId: c.id,
          cardKey: c.key,
          since: c.updatedAt,
        });
      }
      if (!includeWork) return [];
      return [
        {
          cardId: c.id,
          cardKey: c.key,
          projectId: c.projectId,
          projectName: c.projectName,
          title: c.title,
          status: c.status as 'in_progress' | 'review',
          updatedAt: c.updatedAt,
          summary: c.description.trim().slice(0, SUMMARY_CHARS),
          movedBy: c.linkedCommit,
          workers,
          latestRun: run
            ? {
                id: run.id,
                status: run.status,
                validation: run.validation,
                filesChanged: run.changes?.files.length ?? 0,
                commits: run.changes?.commits ?? 0,
                endedAt: run.endedAt,
              }
            : null,
          flags: [],
        },
      ];
    });

  // Tie card-level attention back to cards without a cards-by-attention cross product.
  const flagsByCard = new Map<number, Set<SituationItem['kind']>>();
  for (const item of needsAttention) {
    if (item.cardId == null) continue;
    const flags = flagsByCard.get(item.cardId) ?? new Set<SituationItem['kind']>();
    flags.add(item.kind);
    flagsByCard.set(item.cardId, flags);
  }
  for (const card of beingWorkedOn) card.flags = [...(flagsByCard.get(card.cardId) ?? [])];
  return { generatedAt: new Date(now).toISOString(), needsAttention, beingWorkedOn };
}

/**
 * The part of the situation that concerns one card, as plain text for a worker's prompt: what
 * Home says about the card and its project, so the worker can trace back (sessions, runs,
 * commits) instead of starting blind.
 */
export function cardContext(
  situation: OrchestratorSituation,
  cardId: number,
  taskProjectId?: number,
): string {
  const card = situation.beingWorkedOn.find((c) => c.cardId === cardId);
  const projectId =
    taskProjectId ??
    card?.projectId ??
    situation.needsAttention.find((i) => i.cardId === cardId)?.projectId;
  const lines: string[] = [];
  if (card) {
    lines.push(
      `Board status: ${card.status === 'review' ? 'Review' : 'In progress'} (updated ${card.updatedAt}).`,
    );
    if (card.movedBy) lines.push(`Last moved automatically by: ${card.movedBy}.`);
    for (const w of card.workers) {
      lines.push(
        `Live ${w.kind} ${w.id} (${w.providerId}, "${w.name}") is on this card: ${w.state}.`,
      );
    }
    if (card.latestRun) {
      const r = card.latestRun;
      lines.push(
        `Latest run ${r.id}: ${r.status}${r.validation ? `, ${r.validation}` : ''}; ${r.filesChanged} file(s) changed, ${r.commits} commit(s).`,
      );
    }
  }
  for (const item of situation.needsAttention.filter(
    (i) => i.cardId === cardId || (i.kind === 'project-alert' && i.projectId === projectId),
  )) {
    lines.push(`Needs attention (${item.kind}): ${item.title}. ${item.detail}`);
  }
  if (!lines.length) return '';
  return [
    'Context from ProjectManager (what its Home dashboard shows for this task):',
    ...lines.map((l) => `- ${l}`),
    'Check the current state before acting, and coordinate with any live worker listed above.',
  ].join('\n');
}
