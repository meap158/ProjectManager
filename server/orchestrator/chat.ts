import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../db.js';
import { AgentError, type AgentSupervisor } from '../agents/supervisor.js';
import { providerStatuses } from '../agents/providers.js';
import { stripTerminal } from '../agents/activity.js';
import { getCard, insertCard, listCards, updateCard } from '../store.js';
import {
  CARD_STATUSES,
  type AgentRun,
  type AgentSession,
  type Card,
  type CardStatus,
  type ProjectSummary,
} from '../../shared/types.js';
import type { OrchestratorConfig, OrchestratorEvent } from '../../shared/orchestrator.js';
import type { OrchestratorToolHost } from '../boardMcp.js';
import { cardContext } from './situation.js';
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

export type CheckFocus = 'all' | 'todo' | 'in_progress' | 'review';

const cardRef = z.union([
  z.number().int().positive(),
  z
    .string()
    .trim()
    .regex(/^(?:[A-Za-z]+-)?\d+$/, 'Use a card key like PM-12 or its id'),
]);

export const ORCHESTRATOR_TOOLS = [
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
    const instance = this.instance(id);
    const cwd = this.writeBriefing(instance);
    const existing = this.session(id);
    if (existing && (!providerId || providerId === existing.providerId)) {
      return existing.status === 'running' ? existing : this.supervisor.startSession(existing.id);
    }
    const home = this.scope(instance)[0];
    if (!home) throw new AgentError(400, 'This orchestrator has no projects in scope');
    const available = new Set(
      (await providerStatuses()).filter((p) => p.available).map((p) => p.id),
    );
    const provider =
      providerId ??
      [...instance.providers, ...CHAT_PROVIDERS].find(
        (p) => CHAT_PROVIDERS.includes(p) && available.has(p),
      );
    if (!provider || !CHAT_PROVIDERS.includes(provider))
      throw new AgentError(
        400,
        `The orchestrator chat needs one of: ${CHAT_PROVIDERS.join(', ')} (installed)`,
      );
    return this.supervisor.createSession(home.id, {
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
    const existing = this.session(id);
    if (!existing || existing.status !== 'running') {
      if (!existing) return this.open(id, undefined, `${openingLine(instance)}\n\n${request}`);
      await this.open(id);
      await this.waitUntilReady(existing.id);
    }
    const live = this.supervisor.getSession(existing!.id)!;
    if (live.tailState === 'running' || live.tailState === 'input')
      throw new AgentError(
        409,
        live.tailState === 'input'
          ? 'The orchestrator chat is asking you something; answer it first'
          : 'The orchestrator chat is busy; wait for it or open it to steer',
      );
    this.writeBriefing(instance);
    this.supervisor.sendInput(live.id, `\x1b[200~${request}\x1b[201~\r`, false);
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
        })
        .strict()
        .parse(args);
      const c = card(input.card);
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
      const context = [
        cardContext(this.service.situation(orchestratorId)!, c.id),
        input.instructions ? `Instructions from the orchestrator:\n${input.instructions}` : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      const run = await this.supervisor.dispatchCard(c.projectId, c.id, {
        providerId,
        ...(context ? { context } : {}),
      });
      this.record(
        orchestratorId,
        'dispatched',
        `${c.key}: one-time ${providerId} worker, run #${run.id} (chat)`,
        c.id,
      );
      return { dispatched: runBrief(run), card: brief(getCard(this.db, c.id) ?? c) };
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
  todo: 'To do: go through each To do task. Decide whether it is ready to work on. Start workers (dispatch_worker) for ready ones within your worker limits, most important first; split large ones with create_card; add a note with your question on unclear ones.',
  in_progress:
    "In progress: check each card's progress (get_card, worker_output, and the project's git log in its folder). Move finished work to Review with a note of the evidence; nudge idle workers with message_worker; add a note on stalled cards saying what's blocking and what you suggest.",
  review:
    'Review: for each card in Review, check the evidence (latest run outcome, commits, notes) and tell me which are ready for me to accept and which need more work (note why on the card).',
  all: '',
};

function checkPrompt(instance: OrchestratorConfig, focus: CheckFocus): string {
  const steps =
    focus === 'all'
      ? [
          CHECKS.in_progress,
          CHECKS.review,
          CHECKS.todo,
          'Needs attention: handle or explain each item.',
        ]
      : [CHECKS[focus]];
  const observe =
    instance.strategy === 'observe'
      ? '\nYou are set to watch only: do not start workers; recommend instead.'
      : '';
  return [
    'Check on pending work in your scope now. Call overview first.',
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
and starting agent workers. This folder is only your home; the work happens in the projects.

## Your settings

- Mode: ${instance.strategy === 'observe' ? 'Watch only (recommend; start workers only when the user explicitly asks)' : 'Starts workers on its own'}
- Providers for workers: ${instance.providers.join(', ')}
- Worker limits: ${instance.maxWorkers} in total, ${instance.maxWorkersPerProject} per project

## Projects in your scope (snapshot when this chat opened; call overview for live state)

${projects.map(project).join('\n') || '- (none)'}

## Your tools (MCP server "projectmanager")

- \`overview\`: live state. Projects, To do tasks, Needs attention, Being worked on, capacity. Call it first.
- \`list_cards\`, \`get_card\`: read the board; get_card shows a card's workers, recent runs and agent activity.
- \`update_card\`: move a card and/or append a note (evidence, blocker, question).
- \`create_card\`: split work or record follow-ups.
- \`dispatch_worker\`: start a one-time agent worker on a card, with your instructions.
- \`worker_output\`: what a worker session or run shows now.
- \`message_worker\`: message an idle worker session (e.g. ask for a status update).

## How to work

- To do: decide what's ready, start workers within the limits (most important first), split
  large tasks, and note questions on unclear ones.
- In progress: check progress (get_card, worker_output, the project's \`git log\`/\`git status\`).
  Move finished work to Review with evidence; nudge idle workers; note what blocks stalled ones.
- Review: check the evidence and tell the user what's ready to accept. Move to Done only when
  the requirements are clearly met; the user accepts or rejects finished runs.
- Read project folders freely, but never change files there yourself: changes go through
  workers. Never push, merge, delete branches or run destructive commands.
- Keep the board truthful: every move gets a short note saying why.
- Report concisely: what you did, what's blocked, what needs the user.
`;
}
