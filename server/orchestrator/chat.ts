import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../db.js';
import { AgentError, type AgentSupervisor } from '../agents/supervisor.js';
import { providerStatuses } from '../agents/providers.js';
import { stripTerminal } from '../agents/activity.js';
import { getCard, getSetting, setSetting, insertCard, listCards, updateCard } from '../store.js';
import {
  CARD_STATUSES,
  type AgentRun,
  type AgentSession,
  type Card,
  type CardStatus,
  type ProjectSummary,
} from '../../shared/types.js';
import type {
  OrchestratorConfig,
  OrchestratorEvent,
  OrchestratorChatWork,
} from '../../shared/orchestrator.js';
import type { OrchestratorToolHost } from '../boardMcp.js';
import { cardContext } from './situation.js';
import { planOrchestration } from './planner.js';
import { planningRuns } from './planningRuns.js';
import { OrchestratorAssignments } from './assignments.js';
import { readLimits } from '../agents/limits.js';
import { ChatDispatchIntent } from './chatIntent.js';
import type { OrchestratorService } from './service.js';

// An orchestrator's own chat CLI (PM-89). The user talks to it like any agent terminal;
// it knows the orchestrator's projects (a briefing file in its own folder, written at every open) and
// acts through board tools scoped to those projects: read the board and the workers' screens,
// move cards, add notes, create cards, start one-time workers and nudge idle ones. It never gets
// a project folder as its working directory, and its rules say changes go through workers.

/** CLIs that can load our MCP board tools (server/boardMcp.ts boardConnection). */
const CHAT_PROVIDERS = ['claude', 'codex', 'opencode', 'antigravity'];
const NOTE_LIMIT = 20_000;
const LIST_LIMIT = 200;

export type CheckFocus = 'all' | 'todo' | 'in_progress' | 'review' | 'attention';

const cardRef = z.union([
  z.number().int().positive(),
  z
    .string()
    .trim()
    .regex(/^(?:[A-Za-z]+-)?\d+$/, 'Use a card key like PM-12 or its id'),
]);

export const ORCHESTRATOR_TOOLS = [
  {
    name: 'report_work',
    description:
      'Report the task you are actually working on above this chat terminal. Supply a scoped card, or projectId and title for repository attention work. Call with clear: true when finished or blocked. This is progress, not completion evidence.',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: ['string', 'integer'] },
        projectId: { type: 'integer', minimum: 1 },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        clear: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'overview',
    description:
      'Live state of your scope: your settings and worker capacity, each project (path, git, board counts), To do tasks, Needs attention (alerts, sessions asking for input, runs awaiting review, stalled cards) and Being worked on (in progress / review cards with their workers). Call it first and whenever you need fresh state.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_cards',
    description:
      'Board cards in your scope, newest first. Filter by project id, status and/or text in the title or description.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'integer' },
        status: { type: 'string', enum: CARD_STATUSES },
        query: { type: 'string', maxLength: 200 },
        limit: { type: 'integer', minimum: 1, maximum: LIST_LIMIT },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_card',
    description:
      "One card in full: description and notes, its live workers and their state, its recent runs (outcome, files changed, commits, review) and what agents did on it. Use it to check a task's progress.",
    inputSchema: {
      type: 'object',
      properties: { card: { type: ['string', 'integer'], description: 'Key (PM-12) or id' } },
      required: ['card'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_card',
    description:
      'Move a card (status) and/or append a note: progress, evidence, a blocker, a question for the user. Move to review only with evidence; to done only when the requirements are clearly met.',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: ['string', 'integer'] },
        status: { type: 'string', enum: CARD_STATUSES },
        note: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['card'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_card',
    description:
      'Create a card in one of your projects: split a large task, or record follow-up work.',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'integer' },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        notes: { type: 'string', maxLength: 4000 },
        status: { type: 'string', enum: CARD_STATUSES },
      },
      required: ['projectId', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'dispatch_worker',
    description:
      'Start a one-time agent worker on a card. It gets the card, its board context and your instructions, works in the project folder, and its commits move the card. Respects your worker limits; finished runs wait for the user to review.',
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: ['string', 'integer'] },
        providerId: {
          type: 'string',
          description: 'One of your providers; default: the first available',
        },
        instructions: { type: 'string', maxLength: 4000, description: 'What to focus on or check' },
        requestId: {
          type: 'string',
          maxLength: 128,
          description:
            'Unique dispatch request ID. Reuse exactly this ID and arguments after response loss to recover the original run; use a new ID for new work.',
        },
      },
      required: ['card'],
      additionalProperties: false,
    },
  },
  {
    name: 'worker_output',
    description:
      'What a worker shows right now: the screen of a session (sessionId) or the output tail of a run (runId). Use it to check progress.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'integer' },
        runId: { type: 'integer' },
        chars: { type: 'integer', minimum: 200, maximum: 8000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'message_worker',
    description:
      "Send a message to a worker session that is idle (waiting for its next instruction), e.g. to ask for a status update or continue. Refused while it's working or asking the user something.",
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'integer' },
        text: { type: 'string', minLength: 1, maxLength: 4000 },
      },
      required: ['sessionId', 'text'],
      additionalProperties: false,
    },
  },
];

const fail = (message: string): never => {
  throw new Error(message);
};

export class OrchestratorChat implements OrchestratorToolHost {
  readonly tools = ORCHESTRATOR_TOOLS;

  constructor(
    private db: Db,
    private supervisor: AgentSupervisor,
    private service: OrchestratorService,
    private projects: () => ProjectSummary[],
    private dataDir: string | null,
  ) {}

  private instance(id: string): OrchestratorConfig {
    const instance = this.service.state().instances.find((i) => i.id === id);
    if (!instance) throw new AgentError(404, 'Orchestrator not found');
    return instance;
  }

  private scope(instance: OrchestratorConfig): ProjectSummary[] {
    const all = this.projects();
    return instance.projectIds.length ? all.filter((p) => instance.projectIds.includes(p.id)) : all;
  }

  /** The newest chat session of an orchestrator, live or stopped. */
  session(id: string): AgentSession | null {
    const row = this.db
      .prepare('SELECT id FROM agent_sessions WHERE orchestrator_id = ? ORDER BY id DESC LIMIT 1')
      .get(id) as { id: number } | undefined;
    return row ? this.supervisor.getSession(row.id) : null;
  }

  currentWork(id: string): OrchestratorChatWork | null {
    const instance = this.instance(id);
    const work = getSetting<OrchestratorChatWork | null>(this.db, 'orchestrator-chat-work:' + id);
    const session = this.session(id);
    if (!work || !session || session.id !== work.sessionId || session.status !== 'running')
      return null;
    if (!this.scope(instance).some((p) => p.id === work.projectId)) return null;
    if (work.cardId !== null) {
      const card = getCard(this.db, work.cardId);
      if (
        !card ||
        card.projectId !== work.projectId ||
        card.status === 'done' ||
        card.status === 'review'
      )
        return null;
      return { ...work, cardKey: card.key, title: card.title };
    }
    return work;
  }

  /** The chat's own folder (never a project folder), holding its briefing. */
  private home(id: string): string {
    if (!this.dataDir) throw new AgentError(400, 'No data folder for the orchestrator chat');
    const dir = path.join(this.dataDir, 'orchestrators', id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Writes the briefing every CLI reads at start (CLAUDE.md, AGENTS.md, GEMINI.md). */
  private writeBriefing(instance: OrchestratorConfig): string {
    const dir = this.home(instance.id);
    const text = briefing(instance, this.scope(instance));
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'GEMINI.md'])
      writeFileSync(path.join(dir, file), text);
    return dir;
  }

  /** Opens the orchestrator's chat: reuses its session (restarting it if stopped) or starts one. */
  async open(id: string, providerId?: string, prompt?: string): Promise<AgentSession> {
    if (this.opening.has(id))
      throw new AgentError(409, 'This orchestrator chat is opening; wait a moment and try again');
    this.opening.add(id);
    try {
      return await this.openOnce(id, providerId, prompt);
    } finally {
      this.opening.delete(id);
    }
  }

  private opening = new Set<string>();

  private async openOnce(id: string, providerId?: string, prompt?: string): Promise<AgentSession> {
    let instance = this.instance(id);
    if (providerId && !instance.providers.includes(providerId))
      throw new AgentError(400, `Choose a configured provider: ${instance.providers.join(', ')}`);
    const cwd = this.writeBriefing(instance);
    const existing = this.session(id);
    if (
      existing &&
      instance.providers.includes(existing.providerId) &&
      (!providerId || providerId === existing.providerId)
    ) {
      return existing.status === 'running' ? existing : this.supervisor.startSession(existing.id);
    }
    if (existing?.status === 'running')
      throw new AgentError(409, 'Stop the current orchestrator chat before changing agents');
    const home = this.scope(instance)[0];
    if (!home) throw new AgentError(400, 'This orchestrator has no projects in scope');
    const available = new Set(
      (await providerStatuses()).filter((p) => p.available).map((p) => p.id),
    );
    // Discovery can yield while the user edits or deletes this master.
    instance = this.instance(id);
    if (providerId && !instance.providers.includes(providerId))
      throw new AgentError(400, `Choose a configured provider: ${instance.providers.join(', ')}`);
    const currentHome = this.scope(instance)[0];
    if (!currentHome) throw new AgentError(400, 'This orchestrator has no projects in scope');
    this.writeBriefing(instance);
    const provider =
      providerId ?? instance.providers.find((p) => CHAT_PROVIDERS.includes(p) && available.has(p));
    if (!provider || !CHAT_PROVIDERS.includes(provider) || !available.has(provider))
      throw new AgentError(
        400,
        `The orchestrator chat needs one of: ${CHAT_PROVIDERS.join(', ')} (installed)`,
      );
    return this.supervisor.createSession(currentHome.id, {
      providerId: provider,
      name: `Orchestrator · ${instance.name}`.slice(0, 80),
      cwd,
      orchestratorId: id,
      prompt: prompt ?? openingPrompt(instance),
    });
  }

  /**
   * A one-time check on pending work: sends the orchestrator's chat a request to go through To do,
   * In progress and Review (or one of them) and act on it. Starts the chat when needed.
   */
  async check(id: string, focus: CheckFocus = 'all'): Promise<AgentSession> {
    const instance = this.instance(id);
    const request = checkPrompt(instance, focus);
    let existing = this.session(id);
    if (!existing || !instance.providers.includes(existing.providerId))
      return this.open(id, undefined, `${openingLine(instance)}\n\n${request}`);
    if (existing.status !== 'running') {
      existing = await this.open(id);
      await this.waitUntilReady(existing.id);
    }
    const live = this.supervisor.getSession(existing.id);
    if (!live || live.status !== 'running')
      throw new AgentError(409, 'The orchestrator chat is stopped; reopen it before checking');
    const currentInstance = this.instance(id);
    if (!currentInstance.providers.includes(live.providerId))
      throw new AgentError(
        409,
        'The chat agent was removed from this orchestrator; stop it and choose a configured agent',
      );
    if (live.tailState === 'running' || live.tailState === 'input')
      throw new AgentError(
        409,
        live.tailState === 'input'
          ? 'The orchestrator chat is asking you something; answer it first'
          : 'The orchestrator chat is busy; wait for it or open it to steer',
      );
    this.writeBriefing(currentInstance);
    this.supervisor.sendInput(
      live.id,
      `\x1b[200~${checkPrompt(currentInstance, focus)}\x1b[201~\r`,
      false,
    );
    this.record(id, 'check', `Asked the chat to check pending work (${focus})`);
    return this.supervisor.getSession(live.id)!;
  }

  /** A restarted CLI needs a moment before it takes input. */
  private async waitUntilReady(sessionId: number, timeoutMs = 45_000): Promise<void> {
    const until = Date.now() + timeoutMs;
    await new Promise((r) => setTimeout(r, 3_000));
    while (Date.now() < until) {
      const s = this.supervisor.getSession(sessionId);
      if (!s || s.status !== 'running') break;
      if (s.tailState === 'idle') return;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }

  private record(orchestratorId: string, action: string, message: string, cardId?: number) {
    const event: Omit<OrchestratorEvent, 'at'> = { orchestratorId, action, message };
    if (cardId !== undefined) event.cardId = cardId;
    this.service.record(event);
  }

  // ---- Tools ----------------------------------------------------------------------------------

  async call(
    orchestratorId: string,
    sessionId: number,
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const instance = this.instance(orchestratorId);
    const projects = this.scope(instance);
    const inScope = (projectId: number) => projects.some((p) => p.id === projectId);
    const projectName = (projectId: number) =>
      projects.find((p) => p.id === projectId)?.name ?? `Project ${projectId}`;
    const card = (ref: unknown): Card => {
      const parsed = cardRef.parse(ref);
      const id = typeof parsed === 'number' ? parsed : Number(/\d+$/.exec(parsed)![0]);
      const found = getCard(this.db, id);
      if (!found || !inScope(found.projectId))
        return fail(`Card ${String(ref)} is not in this orchestrator's projects`);
      return found;
    };
    const workers = () => {
      const sessions = this.supervisor
        .listAllSessions()
        .filter((s) => s.status === 'running' && !s.orchestratorId && inScope(s.projectId));
      const runs = this.supervisor
        .listAllRuns(500)
        .filter((r) => (r.status === 'running' || r.status === 'queued') && inScope(r.projectId));
      return { sessions, runs };
    };
    const audit = (cardId: number, action: string, detail: unknown) =>
      this.db
        .prepare(
          'INSERT INTO board_agent_audit (card_id, owner_kind, owner_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          cardId,
          'session',
          sessionId,
          action,
          JSON.stringify(detail),
          new Date().toISOString(),
        );
    const brief = (c: Card) => ({
      key: c.key,
      id: c.id,
      projectId: c.projectId,
      project: projectName(c.projectId),
      title: c.title,
      status: c.status,
      updatedAt: c.updatedAt,
    });

    if (name === 'report_work') {
      const input = z
        .object({
          card: cardRef.optional(),
          projectId: z.number().int().positive().optional(),
          title: z.string().trim().min(1).max(200).optional(),
          clear: z.boolean().optional(),
        })
        .strict()
        .parse(args);
      const session = this.supervisor.getSession(sessionId);
      if (
        !session ||
        session.orchestratorId !== orchestratorId ||
        session.status !== 'running' ||
        this.session(orchestratorId)?.id !== sessionId
      )
        fail('Only the current running chat can report its work');
      const key = 'orchestrator-chat-work:' + orchestratorId;
      if (input.clear) {
        setSetting(this.db, key, null);
        return { cleared: true };
      }
      const task = input.card === undefined ? null : card(input.card);
      const projectId = task?.projectId ?? input.projectId;
      if (!projectId || !inScope(projectId)) fail('Choose a project in this orchestrator scope');
      if (!task && !input.title) fail('Provide a card or a repository task title');
      if (task && input.projectId !== undefined && input.projectId !== task.projectId)
        fail('Card and project must match');
      const work: OrchestratorChatWork = {
        sessionId,
        projectId: projectId!,
        projectName: projectName(projectId!),
        cardId: task?.id ?? null,
        cardKey: task?.key ?? null,
        title: task?.title ?? input.title!,
        reportedAt: new Date().toISOString(),
      };
      setSetting(this.db, key, work);
      return work;
    }

    if (name === 'overview') {
      z.object({}).strict().parse(args);
      const situation = this.service.situation(orchestratorId)!;
      const { sessions, runs } = workers();
      const todo = projects
        .flatMap((p) => listCards(this.db, p.id))
        .filter((c) => c.status === 'todo')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        orchestrator: {
          name: instance.name,
          enabled: instance.enabled,
          strategy: instance.strategy ?? 'autonomous',
          providers: instance.providers,
        },
        capacity: {
          liveWorkers: sessions.length + runs.length,
          maxWorkers: instance.maxWorkers,
          maxWorkersPerProject: instance.maxWorkersPerProject,
        },
        projects: projects.map(projectBrief),
        todo: { total: todo.length, cards: todo.slice(0, 60).map(brief) },
        needsAttention: situation.needsAttention.slice(0, 80),
        beingWorkedOn: situation.beingWorkedOn.slice(0, 80),
      };
    }

    if (name === 'list_cards') {
      const input = z
        .object({
          projectId: z.number().int().positive().optional(),
          status: z.enum(CARD_STATUSES).optional(),
          query: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(LIST_LIMIT).default(50),
        })
        .strict()
        .parse(args);
      if (input.projectId !== undefined && !inScope(input.projectId))
        fail(`Project ${input.projectId} is not in this orchestrator's scope`);
      const q = input.query?.trim().toLowerCase();
      const cards = projects
        .filter((p) => input.projectId === undefined || p.id === input.projectId)
        .flatMap((p) => listCards(this.db, p.id))
        .filter((c) => !input.status || c.status === input.status)
        .filter(
          (c) => !q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q),
        )
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        total: cards.length,
        cards: cards.slice(0, input.limit).map((c) => ({
          ...brief(c),
          summary: c.description.replace(/\s+/g, ' ').slice(0, 200),
        })),
      };
    }

    if (name === 'get_card') {
      const { card: ref } = z.object({ card: z.unknown() }).strict().parse(args);
      const c = card(ref);
      const sessions = this.supervisor
        .listAllSessions()
        .filter((s) => s.cardId === c.id && s.status === 'running');
      const runs = this.supervisor.listRuns(c.projectId, c.id).slice(0, 5);
      const activity = this.db
        .prepare(
          'SELECT owner_kind, owner_id, action, detail, created_at FROM board_agent_audit WHERE card_id = ? ORDER BY id DESC LIMIT 10',
        )
        .all(c.id);
      return {
        ...brief(c),
        description: c.description,
        closedAt: c.closedAt,
        linkedCommit: c.linkedCommit,
        liveSessions: sessions.map((s) => ({
          sessionId: s.id,
          name: s.name,
          providerId: s.providerId,
          state: s.tailState ?? 'running',
          lastOutputAt: s.lastOutputAt,
        })),
        recentRuns: runs.map(runBrief),
        agentActivity: activity,
      };
    }

    if (name === 'update_card') {
      const input = z
        .object({
          card: z.unknown(),
          status: z.enum(CARD_STATUSES).optional(),
          note: z.string().trim().min(1).max(4000).optional(),
        })
        .strict()
        .parse(args);
      if (!input.status && !input.note) fail('Give a status, a note, or both');
      const c = card(input.card);
      const patch: { status?: CardStatus; description?: string } = {};
      if (input.status) patch.status = input.status;
      if (input.note) {
        patch.description = `${c.description}\n\nOrchestrator note (${new Date().toISOString()}):\n${input.note}`;
        if (patch.description.length > NOTE_LIMIT)
          fail(`Card notes are full (${NOTE_LIMIT} characters)`);
      }
      const updated = updateCard(this.db, c.id, patch);
      audit(c.id, 'update_card', { status: input.status, note: input.note });
      if (input.status && input.status !== c.status)
        this.record(
          orchestratorId,
          'moved',
          `${c.key}: ${c.status} → ${input.status} (chat)`,
          c.id,
        );
      return brief(updated ?? c);
    }

    if (name === 'create_card') {
      const input = z
        .object({
          projectId: z.number().int().positive(),
          title: z.string().trim().min(1).max(200),
          notes: z.string().max(4000).default(''),
          status: z.enum(CARD_STATUSES).default('todo'),
        })
        .strict()
        .parse(args);
      if (!inScope(input.projectId))
        fail(`Project ${input.projectId} is not in this orchestrator's scope`);
      const created = insertCard(this.db, input.projectId, {
        title: input.title,
        description: input.notes,
        status: input.status,
      });
      audit(created.id, 'create_card', input);
      this.record(orchestratorId, 'created', `${created.key}: ${created.title} (chat)`, created.id);
      return brief(created);
    }

    if (name === 'dispatch_worker') {
      const input = z
        .object({
          card: z.unknown(),
          providerId: z.string().optional(),
          instructions: z.string().trim().max(4000).optional(),
          requestId: z.string().trim().min(1).max(128).optional(),
        })
        .strict()
        .parse(args);
      const c = card(input.card);
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            cardId: c.id,
            providerId: input.providerId ?? null,
            instructions: input.instructions ?? '',
          }),
        )
        .digest('hex');
      const replay = () => {
        if (!input.requestId) return null;
        const existing = ChatDispatchIntent.replay(
          this.db,
          orchestratorId,
          input.requestId,
          fingerprint,
        );
        if (!existing) return null;
        const run = existing.runId ? this.supervisor.getRun(existing.runId) : null;
        return {
          replayed: true,
          request: existing,
          ...(existing.status === 'pending'
            ? {
                note: 'Dispatch acknowledgement is pending. Recheck with the same request ID; do not start a replacement.',
              }
            : {}),
          ...(existing.status === 'interrupted'
            ? {
                note: 'No recoverable worker remains for this request. Inspect the task and retry policy before submitting new work with a new request ID.',
              }
            : {}),
          ...(run ? { dispatched: runBrief(run) } : {}),
          card: brief(c),
        };
      };
      const prior = replay();
      if (prior) return prior;
      if (c.status === 'done') fail(`${c.key} is done; move it back first if it needs more work`);
      const { sessions, runs } = workers();
      const live = sessions.length + runs.length;
      if (live >= instance.maxWorkers)
        fail(`At capacity: ${live} of ${instance.maxWorkers} workers are busy in your scope`);
      const inProject =
        sessions.filter((s) => s.projectId === c.projectId).length +
        runs.filter((r) => r.projectId === c.projectId).length;
      if (inProject >= instance.maxWorkersPerProject)
        fail(
          `${projectName(c.projectId)} already has ${inProject} of ${instance.maxWorkersPerProject} workers`,
        );
      if (runs.some((r) => r.cardId === c.id) || sessions.some((s) => s.cardId === c.id))
        fail(`${c.key} already has a live worker; check it with get_card / worker_output`);
      const available = new Set(
        (await providerStatuses()).filter((p) => p.available).map((p) => p.id),
      );
      if (input.providerId && !instance.providers.includes(input.providerId))
        fail(`Use one of your providers: ${instance.providers.join(', ')}`);
      const providerId = input.providerId ?? instance.providers.find((p) => available.has(p));
      if (!providerId || !available.has(providerId))
        fail(`None of your providers is installed: ${instance.providers.join(', ')}`);
      // Provider discovery yielded: another caller may already have reserved this request.
      const concurrent = replay();
      if (concurrent) return concurrent;
      const reservation: { intent?: ChatDispatchIntent } = {};
      const check = () => {
        if (reservation.intent && !reservation.intent.current())
          return { allowed: false, reason: 'Dispatch reservation changed' };
        if (!providerId) return { allowed: false, reason: 'No provider selected' };
        const policy = this.instance(orchestratorId);
        const latest = getCard(this.db, c.id);
        if (
          !latest ||
          latest.title !== c.title ||
          latest.description !== c.description ||
          latest.status !== c.status ||
          latest.updatedAt !== c.updatedAt
        )
          return { allowed: false, reason: 'Task changed before launch; inspect it again' };
        const blockedCardIds = new OrchestratorAssignments(this.db).blockedCards();
        if (reservation.intent) blockedCardIds.delete(c.id);
        const decision = planOrchestration(
          { ...policy, providers: [providerId] },
          {
            cards: [latest],
            runs: planningRuns(this.db, policy.projectIds),
            sessions: this.supervisor.listAllSessions().filter((s) => !s.orchestratorId),
            availableProviders:
              available.has(providerId) && policy.providers.includes(providerId)
                ? [providerId]
                : [],
            limits: readLimits(this.dataDir),
            blockedCardIds,
          },
        )[0];
        return {
          allowed: decision?.action === 'dispatch',
          reason: decision?.reason ?? 'Task is outside current scope or not ready',
        };
      };
      const permission = check();
      if (!permission.allowed) {
        const raced = replay();
        if (raced) return raced;
        fail(permission.reason);
      }
      let intent: ChatDispatchIntent;
      try {
        intent = new ChatDispatchIntent(
          this.db,
          c.id,
          orchestratorId,
          Date.now(),
          input.requestId ? { id: input.requestId, fingerprint, revision: c.updatedAt } : undefined,
        );
      } catch (error) {
        // Another process may have committed the same request after our last lookup.
        const raced = replay();
        if (raced) return raced;
        throw error;
      }
      reservation.intent = intent;
      const heartbeat = setInterval(() => intent?.heartbeat(), 30000);
      heartbeat.unref();
      let insertionDenied = false;
      try {
        const context = [
          cardContext(this.service.situation(orchestratorId)!, c.id, c.projectId),
          input.instructions ? `Instructions from the orchestrator:\n${input.instructions}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        const run = await this.supervisor.dispatchCard(c.projectId, c.id, {
          providerId,
          ...(context ? { context } : {}),
          dispatchKey: intent.key,
          orchestratorId,
          maxAttempts: 1,
          canCommit: () => {
            const allowed = check().allowed;
            if (!allowed) insertionDenied = true;
            return allowed;
          },
        });
        intent.assigned(run.id);
        this.record(
          orchestratorId,
          'dispatched',
          `${c.key}: one-time ${providerId} worker, run #${run.id} (chat)`,
          c.id,
        );
        return {
          dispatched: runBrief(run),
          card: brief(getCard(this.db, c.id) ?? c),
          ...(input.requestId ? { requestId: input.requestId } : {}),
        };
      } catch (error) {
        if (insertionDenied) intent.superseded();
        else intent.failed();
        throw error;
      } finally {
        clearInterval(heartbeat);
      }
    }

    if (name === 'worker_output') {
      const input = z
        .object({
          sessionId: z.number().int().positive().optional(),
          runId: z.number().int().positive().optional(),
          chars: z.number().int().min(200).max(8000).default(3000),
        })
        .strict()
        .parse(args);
      if (!input.sessionId === !input.runId) fail('Give either sessionId or runId');
      if (input.sessionId) {
        const s = this.supervisor.getSession(input.sessionId);
        if (!s || !inScope(s.projectId)) fail(`Session ${input.sessionId} is not in your scope`);
        return {
          sessionId: s!.id,
          name: s!.name,
          status: s!.status,
          state: s!.tailState,
          lastOutputAt: s!.lastOutputAt,
          screen: this.supervisor.sessionScreen(s!.id, input.chars) ?? '',
        };
      }
      const run = this.supervisor.getRun(input.runId!);
      if (!run || !inScope(run.projectId)) fail(`Run ${input.runId} is not in your scope`);
      const out = this.supervisor.readRunOutput(
        run!.id,
        Math.max(0, run!.logBytes - input.chars * 2),
      );
      return {
        ...runBrief(run!),
        output: stripTerminal(out?.data ?? '').slice(-input.chars),
      };
    }

    if (name === 'message_worker') {
      const input = z
        .object({
          sessionId: z.number().int().positive(),
          text: z.string().trim().min(1).max(4000),
        })
        .strict()
        .parse(args);
      const s = this.supervisor.getSession(input.sessionId);
      if (!s || !inScope(s.projectId) || s.orchestratorId)
        fail(`Session ${input.sessionId} is not a worker in your scope`);
      if (s!.status !== 'running') fail(`Session ${s!.id} is not running`);
      if (s!.tailState !== 'idle')
        fail(
          s!.tailState === 'input'
            ? `Session ${s!.id} is asking the user something; leave it to them`
            : `Session ${s!.id} is working; check back later`,
        );
      this.supervisor.sendInput(s!.id, `\x1b[200~${input.text}\x1b[201~\r`, false);
      this.record(
        orchestratorId,
        'messaged',
        `Session ${s!.id} "${s!.name}": ${input.text.slice(0, 120)}`,
        s!.cardId ?? undefined,
      );
      return { sent: true, sessionId: s!.id };
    }

    return fail(`Unknown tool: ${name}`);
  }
}

function projectBrief(p: ProjectSummary) {
  return {
    id: p.id,
    name: p.name,
    path: p.path,
    missing: p.missing,
    board: p.cardCounts,
    git: p.git?.isRepo
      ? {
          branch: p.git.branch,
          uncommittedFiles: p.git.dirtyFiles ?? null,
          unpushedCommits: p.git.ahead ?? null,
          behind: p.git.behind ?? null,
          lastCommitAt: p.git.lastCommitAt,
          recentCommits: p.git.recentCommits.slice(0, 5).map((c) => `${c.date} ${c.subject}`),
        }
      : null,
  };
}

function runBrief(r: AgentRun) {
  return {
    runId: r.id,
    name: r.name,
    providerId: r.providerId,
    status: r.status,
    error: r.error,
    review: r.validation,
    filesChanged: r.changes?.files.length ?? 0,
    commits: r.changes?.commits ?? 0,
    startedAt: r.startedAt,
    endedAt: r.endedAt,
  };
}

function openingLine(instance: OrchestratorConfig): string {
  return `You are the ProjectManager orchestrator "${instance.name}". Your briefing (scope, tools, rules) is in CLAUDE.md / AGENTS.md in this folder: follow it.`;
}

function openingPrompt(instance: OrchestratorConfig): string {
  return `${openingLine(instance)}\n\nCall the projectmanager overview tool, then give me a short status: what needs attention, what is in progress, what is waiting in To do, and what you suggest next. Don't start workers or change cards until I ask.`;
}

const CHECKS: Record<CheckFocus, string> = {
  todo: 'To do: go through each To do task. Decide whether it is ready to work on. Implement ready tasks directly in this chat session, most important first. Inspect the project instructions and existing changes, complete the work and verify it before moving cards to Review. Do not dispatch workers or delegate; record concrete blockers on unclear tasks.',
  in_progress:
    "In progress: check each card's progress (get_card, worker_output, and the project's git log in its folder). Continue unfinished work directly here, preserving changes from existing sessions. Move finished work to Review with evidence; do not dispatch workers. Record concrete blockers on stalled cards.",
  review:
    'Review: for each card in Review, check the evidence (latest run outcome, commits, notes) and tell me which are ready for me to accept and which need more work (note why on the card).',
  attention:
    'Needs attention: inspect the live All projects dashboard alerts in overview, including uncommitted and unpushed work. Read the affected project instructions and diffs; address safe, authorized fixes directly here and verify them. Preserve unrelated changes. Do not dismiss unresolved alerts or mark work complete without evidence. Report the exact project, remaining work and any action requiring owner input. Do not push, merge, discard files or delete branches without explicit authorization for that action.',
  all: '',
};

export function checkPrompt(instance: OrchestratorConfig, focus: CheckFocus): string {
  const steps =
    focus === 'all'
      ? [CHECKS.in_progress, CHECKS.review, CHECKS.todo, CHECKS.attention]
      : [CHECKS[focus]];
  const observe =
    instance.strategy === 'observe'
      ? '\nWatch only: inspect and recommend changes; do not edit files or move cards unless the user explicitly authorizes the work.'
      : '';
  return [
    'Check on pending work in your scope now. Call overview first. Work directly in this chat session; do not dispatch workers or delegate. Worker capacity does not gate direct work.',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    `Finish with a short report: what you moved, started or noted, what's blocked, and what needs me.${observe}`,
  ].join('\n');
}

/** The orchestrator's standing briefing, regenerated at every open from the live scope. */
export function briefing(instance: OrchestratorConfig, projects: ProjectSummary[]): string {
  const project = (p: ProjectSummary) => {
    const c = p.cardCounts;
    const git = p.git?.isRepo
      ? `branch ${p.git.branch ?? '?'}, ${p.git.dirtyFiles ?? 0} uncommitted, ${p.git.ahead ?? 0} unpushed, last commit ${p.git.lastCommitAt ?? 'never'}`
      : 'not a git repo';
    return `- **${p.name}** (project ${p.id}) at \`${p.path}\`${p.missing ? ' (FOLDER MISSING)' : ''}: ${git}. Board: ${c.backlog} backlog, ${c.todo} to do, ${c.in_progress} in progress, ${c.review} review, ${c.done} done.`;
  };
  return `# Orchestrator: ${instance.name}

You are this ProjectManager orchestrator. The user chats with you here and you act on
their requests across the projects below: following up on tasks, checking progress, moving cards
and implementing authorized work directly in this chat session. This folder is your home; inspect and edit the scoped projects using their absolute paths.

## Your settings

- Chat mode: ${instance.strategy === 'observe' ? 'Watch only (recommend; implement only when the user explicitly asks)' : 'Process authorized work directly in this chat session'}
- Do not dispatch workers or delegate work from this chat. Worker capacity does not block direct work.
- Background scheduler settings below are separate from this chat's direct work:
- Providers for workers: ${instance.providers.join(', ')}
- Worker limits: ${instance.maxWorkers} in total, ${instance.maxWorkersPerProject} per project

## Projects in your scope (snapshot when this chat opened; call overview for live state)

${projects.map(project).join('\n') || '- (none)'}

## Your tools (MCP server "projectmanager")

- \`overview\`: live state. Projects, To do tasks, Needs attention, Being worked on, capacity. Call it first.
- \`list_cards\`, \`get_card\`: read the board; get_card shows a card's workers, recent runs and agent activity.
- \`update_card\`: move a card and/or append a note (evidence, blocker, question).
- \`create_card\`: split work or record follow-ups.
- \`dispatch_worker\`: start a one-time agent worker on a card, with your instructions. Supply a unique requestId for each new dispatch; reuse it with identical arguments after a lost response to recover the original run. A pending replay means wait; it is not permission to launch another worker.
- \`worker_output\`: what a worker session or run shows now.
- \`message_worker\`: message an idle worker session (e.g. ask for a status update).

## How to work

- Call \`report_work\` before each card or repository task, and clear it when finished or blocked, so the chat shows the actual task above its terminal.

- To do: inspect each task and its project's instructions, then implement authorized work directly here. Preserve existing changes; verify the requirements before moving a card to Review. Do not dispatch workers or delegate.
- In progress: check progress (get_card, worker_output, the project's \`git log\`/\`git status\`).
  Continue unfinished work directly here without overwriting active sessions' changes. Move finished work to Review with evidence; note concrete blockers.
- Review: check the evidence and tell the user what's ready to accept. Move to Done only when
  the requirements are clearly met; the user accepts or rejects finished runs.
- Read scoped project folders and make authorized changes directly in this chat. Follow each project's instructions, preserve unrelated changes, and run appropriate checks. Never push, merge, delete branches or run destructive commands without explicit authorization for that action.
- Keep the board truthful: every move gets a short note saying why.
- Report concisely: what you did, what's blocked, what needs the user.
`;
}
