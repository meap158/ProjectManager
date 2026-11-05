import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cardAttachmentsDir, listAttachments } from '../attachments.js';
import path from 'node:path';
import { z } from 'zod';
import type { Db } from '../db.js';
import { AgentError, defaultPrompt, type AgentSupervisor } from '../agents/supervisor.js';
import { providerStatuses } from '../agents/providers.js';
import { stripTerminal } from '../agents/activity.js';
import {
  getCard,
  getSetting,
  setSetting,
  insertCard,
  listCards,
  listProjectlessCards,
  updateCard,
  scopeFolders,
} from '../store.js';
import { resourceBlock } from './resources.js';

/** How a card that belongs to no project is labelled (PM-138). */
const ALL_PROJECTS = 'All projects';
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
import { ownedSessionIds, recordOwnedSession } from './ownedWorkers.js';
import { orchestratorRunLevel } from './runLevel.js';
import { planningRuns } from './planningRuns.js';
import { OrchestratorAssignments } from './assignments.js';
import { readLimits } from '../agents/limits.js';
import { ChatDispatchIntent } from './chatIntent.js';
import { gitCommandWrites, runProjectGit } from './gitTool.js';
import type { OrchestratorService } from './service.js';
import { type SopStore, checkProject, sopCardText, sopInfo, sopReport } from '../sops.js';

// An orchestrator's own chat CLI (PM-89). The user talks to it like any agent terminal;
// it knows the orchestrator's projects (a briefing file in its own folder, written at every open) and
// acts through board tools scoped to those projects: read the board and the workers' screens,
// move cards, add notes, create cards, start one-time workers and nudge idle ones. It never gets
// a project folder as its working directory, and its rules say changes go through workers.

/** CLIs that can load our MCP board tools (server/boardMcp.ts boardConnection). */
const CHAT_PROVIDERS = ['claude', 'codex', 'opencode', 'antigravity'];
const NOTE_LIMIT = 20_000;
const LIST_LIMIT = 200;

export type CheckFocus = 'all' | 'todo' | 'in_progress' | 'review' | 'attention' | 'plan';

const cardRef = z.union([
  z.number().int().positive(),
  z
    .string()
    .trim()
    .regex(/^(?:[A-Za-z]+-)?\d+$/, 'Use a card key like PM-12 or its id'),
]);

export const ORCHESTRATOR_TOOLS = [
  ...['check_session', 'continue_session', 'wake_session', 'supervise_session'].map((name) => ({
    name,
    description:
      name === 'check_session'
        ? 'Inspect a scoped worker session: progress, quota and readiness, with reasons it cannot continue or wake. Call before acting.'
        : name === 'continue_session'
          ? 'Continue unfinished in-progress card work in an idle worker with fresh quota, no draft or owner question. Deduplicated; check worker_output after sending.'
          : name === 'wake_session'
            ? 'Explicitly resume a stopped scoped worker on its in-progress card, respecting quota and worker capacity. Does not blindly send a second prompt.'
            : 'Enroll or release a scoped worker for automatic card continuation. Requires this orchestrator supervision setting; one orchestrator owns a session at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'integer', minimum: 1 },
        ...(name === 'supervise_session' ? { enabled: { type: 'boolean' } } : {}),
      },
      required: name === 'supervise_session' ? ['sessionId', 'enabled'] : ['sessionId'],
      additionalProperties: false,
    },
  })),

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
    name: 'git',
    description:
      'Run git or gh in one of your projects, as that project\'s own commit author and GitHub account. Only while Git on its own is on (Orchestrators page). Push, pull requests, merges and branch work; force pushes, discarding uncommitted work, deleting the main branch, skipping hooks and deleting repositories are refused. Give the arguments as a list, e.g. ["push", "origin", "main"].',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'integer', minimum: 1 },
        program: { type: 'string', enum: ['git', 'gh'] },
        args: {
          type: 'array',
          items: { type: 'string', maxLength: 500 },
          minItems: 1,
          maxItems: 40,
        },
      },
      required: ['projectId', 'program', 'args'],
      additionalProperties: false,
    },
  },
  {
    name: 'sop_report',
    description:
      "Audit your projects against our SOPs (Settings > SOPs): each gap with what was found and how to fix it. Read-only. Optionally one project. Waivers are the owner's decision only: never treat a gap as acceptable yourself; suggest a waiver with a reason in your reply instead.",
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'integer' },
        includePassing: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'sop_card',
    description:
      'Create a To do card asking for one SOP gap in one of your projects to be fixed, from a fresh check (refused when the project already meets it).',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'integer' }, sopId: { type: 'string' } },
      required: ['projectId', 'sopId'],
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
  {
    name: 'read_image',
    description:
      "Look at one of a card's attached images (index from get_card's attachments), as an image rather than text.",
    inputSchema: {
      type: 'object',
      properties: { card: { type: ['string', 'integer'] }, index: { type: 'integer', minimum: 0 } },
      required: ['card', 'index'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_sessions',
    description:
      'The CLI sessions in your projects: id, project, agent, state (idle = waiting for its next instruction, running = working, input = asking the user), linked card and last output. Use it to find an idle session to hand a card to. check_session gives quota, wake/continue eligibility and blockers.',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'integer' } },
      additionalProperties: false,
    },
  },
  {
    name: 'assign_card',
    description:
      "Hand a card to a running CLI session in the card's project, like the card dialog's Send to session: links the card, moves it to In progress and types the task in. Only an idle session with no other live card; the delivery is not confirmed, so check it with worker_output rather than sending again.",
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: ['string', 'integer'] },
        sessionId: { type: 'integer' },
        instructions: { type: 'string', maxLength: 4000, description: 'Added to the task text' },
      },
      required: ['card', 'sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'start_session',
    description:
      "Start a new interactive CLI session on a card in its project folder, like the card dialog's New terminal: the task is typed in and the card moves to In progress. Respects your worker limits, quota reserve and the per-project session limit. Supply a requestId and reuse it after a lost response to get the same session back.",
    inputSchema: {
      type: 'object',
      properties: {
        card: { type: ['string', 'integer'] },
        providerId: {
          type: 'string',
          description: 'One of your providers; default: the first available',
        },
        instructions: { type: 'string', maxLength: 4000, description: 'Added to the task text' },
        requestId: { type: 'string', maxLength: 128 },
      },
      required: ['card'],
      additionalProperties: false,
    },
  },
];

/** Continuity for long chats (PM-400): its handover notes and artefacts, in its own folder. */
const HANDOVER = 'HANDOVER.md';
const ARTIFACTS = 'artifacts';
const ARTIFACT_FILES = 50;
const ARTIFACT_MB = 100;
const RECENT_EVENTS = 15;

/** Keeps the chat's artefacts folder bounded: the newest files, within the size cap. */
export function pruneArtifacts(
  dir: string,
  maxFiles = ARTIFACT_FILES,
  maxBytes = ARTIFACT_MB * 1024 * 1024,
): void {
  mkdirSync(dir, { recursive: true });
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const file = path.join(dir, e.name);
      const st = statSync(file);
      return { file, size: st.size, at: st.mtimeMs };
    })
    .sort((a, b) => b.at - a.at);
  let total = 0;
  files.forEach((f, i) => {
    total += f.size;
    // Its own folder under data/, holding only what the chat wrote there.
    if (i >= maxFiles || total > maxBytes) rmSync(f.file, { force: true });
  });
}

/**
 * A tool result carrying native MCP content (an image) instead of JSON text; the board bridge
 * (server/boardMcp.ts) passes it through as is (PM-400).
 */
export const MCP_CONTENT = 'mcpContent';

/** Whether an orchestrator's chat may hand work to CLI sessions and workers (PM-399). */
/** Whether this orchestrator drafts the next cards for idle projects (PM-426). */
export function plans(instance: OrchestratorConfig): boolean {
  return instance.strategy !== 'observe' && instance.planFromGoals === true;
}

/** Whether this orchestrator accepts finished work itself (PM-427). */
export function accepts(instance: OrchestratorConfig): boolean {
  return instance.strategy !== 'observe' && instance.acceptReviews === true;
}

/** Whether this orchestrator may push, merge and manage branches itself (PM-428). */
export function doesGit(instance: OrchestratorConfig): boolean {
  return instance.strategy !== 'observe' && instance.gitAutonomy === true;
}

export function delegates(instance: OrchestratorConfig): boolean {
  return instance.strategy !== 'observe' && instance.delegateToSessions !== false;
}

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
    private sops: SopStore | null = null,
    /** Card images (<dataDir>/attachments), for get_card and read_image (PM-400). */
    private attachmentsRoot: string | null = null,
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

  /**
   * Whether a project, by id, is this orchestrator's. Id 0 is "All projects" (a card that belongs
   * to no project, PM-138): it is owned by an orchestrator that covers every project, and not by
   * one limited to chosen projects.
   */
  private inScope(instance: OrchestratorConfig, projectId: number): boolean {
    if (projectId === 0) return instance.projectIds.length === 0;
    return this.scope(instance).some((p) => p.id === projectId);
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
    if (!this.inScope(instance, work.projectId)) return null;
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
    pruneArtifacts(path.join(dir, ARTIFACTS));
    // Its own recent activity, newest first, so a restarted or compacted chat knows what it
    // already handed out and decided (PM-400).
    const recent = this.service
      .state()
      .events.filter((e) => e.orchestratorId === instance.id)
      .slice(-RECENT_EVENTS)
      .reverse();
    const text = briefing(instance, this.scope(instance), recent);
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
  async check(
    id: string,
    focus: CheckFocus = 'all',
    attentionKinds: readonly string[] = [],
  ): Promise<AgentSession> {
    const instance = this.instance(id);
    const request = checkPrompt(instance, focus, attentionKinds);
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
      `\x1b[200~${checkPrompt(currentInstance, focus, attentionKinds)}\x1b[201~\r`,
      false,
    );
    this.record(
      id,
      'check',
      `Asked the chat to check pending work (${focus}${attentionKinds.length ? `: ${attentionKinds.join(', ')}` : ''})`,
    );
    return this.supervisor.getSession(live.id)!;
  }

  /** Whether the chat can take a card now, and why not (for the card dialog, PM-202). */
  chatState(id: string): { running: boolean; state: 'running' | 'idle' | 'input' | null } {
    this.instance(id);
    const session = this.session(id);
    const running = !!session && session.status === 'running';
    return { running, state: running ? session.tailState : null };
  }

  /**
   * Hands one card to the orchestrator's running chat as a message. Never starts or restarts the
   * chat (a stopped chat is the owner's choice), only takes cards inside the orchestrator's scope,
   * and refuses while the chat is busy or asking the owner something, like a check does.
   */
  sendCard(id: string, cardId: number): AgentSession {
    const instance = this.instance(id);
    const found = getCard(this.db, cardId);
    if (!found || found.projectId === null || !this.inScope(instance, found.projectId))
      throw new AgentError(404, "Card not found in this orchestrator's projects");
    if (found.status === 'done')
      throw new AgentError(409, `${found.key} is done; move it back first if it needs more work`);
    const live = this.session(id);
    if (!live || live.status !== 'running')
      throw new AgentError(409, 'The orchestrator chat is stopped; open it before sending a card');
    if (!instance.providers.includes(live.providerId))
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
    const projectLabel =
      this.scope(instance).find((p) => p.id === found.projectId)?.name ?? ALL_PROJECTS;
    this.supervisor.sendInput(
      live.id,
      `\x1b[200~${cardPrompt(instance, found, projectLabel)}\x1b[201~\r`,
      false,
    );
    this.record(id, 'send-card', `Sent ${found.key} to the chat`, found.id);
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
    const inScope = (projectId: number) => this.inScope(instance, projectId);
    const projectName = (projectId: number) =>
      projectId === 0
        ? ALL_PROJECTS
        : (projects.find((p) => p.id === projectId)?.name ?? `Project ${projectId}`);
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
    /**
     * This orchestrator's own live workers (PM-417): the sessions it started, handed a card to or
     * supervises, and the runs it dispatched. Only these count toward its worker limits; the
     * owner's own sessions do not.
     */
    const ownWorkers = () => {
      const { sessions, runs } = workers();
      const owned = ownedSessionIds(this.db, orchestratorId, sessions);
      return {
        sessions: sessions.filter((s) => owned.has(s.id)),
        runs: runs.filter((r) => r.orchestratorId === orchestratorId),
        all: { sessions, runs },
      };
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
    const sessionBrief = (s: AgentSession) => ({
      id: s.id,
      name: s.name,
      projectId: s.projectId,
      project: projectName(s.projectId),
      providerId: s.providerId,
      status: s.status,
      state: s.tailState,
      card: s.cardKey,
      lastOutputAt: s.lastOutputAt,
    });
    /**
     * Handing work out is a setting (PM-399). Watch only stays a briefing rule, as before: the
     * chat acts there only when the user explicitly asks.
     */
    const requireDelegation = () => {
      if (instance.delegateToSessions === false)
        fail(
          'Handing work to CLI sessions is turned off for this orchestrator; work on it directly in this chat',
        );
    };
    /**
     * The checks every new worker passes, run or session (PM-399): the card is open and in a
     * project, has no live worker, your worker limits have room and a provider of yours is
     * installed. Each refusal names the limit, so it is not retried blindly.
     */
    const capacity = async (c: Card, requested?: string) => {
      if (c.projectId === 0)
        fail(
          `${c.key} belongs to no project ("All projects"), so a worker has no folder to run in; ` +
            'work on it directly in this chat, or move it to a project first',
        );
      if (c.status === 'done') fail(`${c.key} is done; move it back first if it needs more work`);
      const { sessions, runs, all } = ownWorkers();
      // Any live worker on the card blocks it, whoever started it.
      if (all.runs.some((r) => r.cardId === c.id) || all.sessions.some((s) => s.cardId === c.id))
        fail(`${c.key} already has a live worker; check it with get_card / worker_output`);
      const live = sessions.length + runs.length;
      if (live >= instance.maxWorkers)
        fail(`At capacity: ${live} of your ${instance.maxWorkers} workers are busy`);
      const inProject =
        sessions.filter((s) => s.projectId === c.projectId).length +
        runs.filter((r) => r.projectId === c.projectId).length;
      if (inProject >= instance.maxWorkersPerProject)
        fail(
          `${projectName(c.projectId)} already has ${inProject} of your ${instance.maxWorkersPerProject} workers`,
        );
      const available = new Set(
        (await providerStatuses()).filter((p) => p.available).map((p) => p.id),
      );
      if (requested && !instance.providers.includes(requested))
        fail(`Use one of your providers: ${instance.providers.join(', ')}`);
      const providerId = requested ?? instance.providers.find((p) => available.has(p));
      if (!providerId || !available.has(providerId))
        fail(`None of your providers is installed: ${instance.providers.join(', ')}`);
      return { providerId: providerId!, available };
    };
    /** The scheduler's own verdict on a card: provider capacity, quota reserve, assignments. */
    const plan = (latest: Card, providerId: string, available: Set<string>, mine?: number) => {
      const policy = this.instance(orchestratorId);
      const blockedCardIds = new OrchestratorAssignments(this.db).blockedCards();
      if (mine !== undefined) blockedCardIds.delete(mine);
      const sessions = this.supervisor.listAllSessions().filter((s) => !s.orchestratorId);
      const decision = planOrchestration(
        { ...policy, providers: [providerId] },
        {
          cards: [latest],
          runs: planningRuns(this.db, policy.projectIds),
          sessions,
          ownedSessionIds: ownedSessionIds(this.db, orchestratorId, sessions),
          availableProviders:
            available.has(providerId) && policy.providers.includes(providerId) ? [providerId] : [],
          limits: readLimits(this.dataDir),
          blockedCardIds,
          resourceBlock: resourceBlock(scopeFolders(this.db, policy.projectIds)),
        },
      )[0];
      return {
        allowed: decision?.action === 'dispatch',
        reason: decision?.reason ?? 'Task is outside current scope or not ready',
      };
    };

    if (['check_session', 'continue_session', 'wake_session', 'supervise_session'].includes(name)) {
      const input = z
        .object({
          sessionId: z.number().int().positive(),
          ...(name === 'supervise_session' ? { enabled: z.boolean() } : {}),
        })
        .strict()
        .parse(args);
      const control = this.service.sessionSupervision;
      if (name === 'check_session') return control.check(orchestratorId, input.sessionId);
      if (name === 'supervise_session')
        return control.enroll(
          orchestratorId,
          input.sessionId,
          (input as { enabled: boolean }).enabled,
        );
      requireDelegation();
      if (name === 'wake_session') return control.wake(orchestratorId, input.sessionId);
      return control.continue(orchestratorId, input.sessionId);
    }

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
      if (projectId === undefined || !inScope(projectId))
        fail('Choose a project in this orchestrator scope');
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

    // SOP audits (PM-316): the same report as Settings > SOPs, limited to this scope. Read-only;
    // waivers stay with the owner.
    if (name === 'sop_report' || name === 'sop_card') {
      if (!this.sops) fail('SOPs are not available here');
      const set = this.sops!.current();
      if (name === 'sop_report') {
        const input = z
          .object({
            projectId: z.number().int().positive().optional(),
            includePassing: z.boolean().optional(),
          })
          .strict()
          .parse(args);
        if (input.projectId !== undefined && !inScope(input.projectId))
          fail(`Project ${input.projectId} is not in this orchestrator's scope`);
        const ids = input.projectId !== undefined ? [input.projectId] : projects.map((p) => p.id);
        const report = await sopReport(this.db, set, ids);
        const byId = new Map(report.sops.map((s) => [s.id, s]));
        return {
          sops: report.sops.map((s) => ({ id: s.id, title: s.title, how: s.how, fix: s.fix })),
          projects: report.projects.map((p) => ({
            projectId: p.id,
            project: p.name,
            results: Object.entries(p.results)
              .filter(([, r]) => input.includePassing || r.state === 'fail' || r.state === 'waived')
              .map(([sopId, r]) => ({
                sopId,
                sop: byId.get(sopId)?.title ?? sopId,
                state: r.state,
                detail: r.detail,
                ...(r.waiver ? { waiverReason: r.waiver.reason } : {}),
              })),
          })),
          note: "Gaps can become cards (sop_card) or be fixed directly when authorized. Waived results are the owner's recorded exceptions.",
          ...(set.error ? { fileError: set.error } : {}),
        };
      }
      const input = z
        .object({ projectId: z.number().int().positive(), sopId: z.string().min(1).max(60) })
        .strict()
        .parse(args);
      const project = projects.find((p) => p.id === input.projectId);
      if (!project) fail(`Project ${input.projectId} is not in this orchestrator's scope`);
      const sop = set.sops.find((s) => s.enabled !== false && s.id === input.sopId);
      if (!sop) fail(`No SOP "${input.sopId}"`);
      const result = (await checkProject([sop!], project!.path))[sop!.id]!;
      if (result.state !== 'fail') fail(`${project!.name} already meets "${sop!.title}"`);
      const created = insertCard(this.db, project!.id, {
        ...sopCardText(sopInfo([sop!])[0]!, result.detail),
        status: 'todo',
      });
      audit(created.id, 'sop_card', input);
      return brief(created);
    }

    if (name === 'overview') {
      z.object({}).strict().parse(args);
      const situation = this.service.situation(orchestratorId)!;
      const { sessions, runs, all } = ownWorkers();
      const todo = [
        ...projects.flatMap((p) => listCards(this.db, p.id)),
        ...(inScope(0) ? listProjectlessCards(this.db) : []),
      ]
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
          // Your own workers count toward the limits; the owner's sessions do not (PM-417). Named
          // so a reader cannot compare the uncounted workers with the limit (a chat once did).
          yourWorkers: sessions.length + runs.length,
          maxWorkers: instance.maxWorkers,
          freeWorkerSlots: Math.max(0, instance.maxWorkers - sessions.length - runs.length),
          maxWorkersPerProject: instance.maxWorkersPerProject,
          notCountedWorkers: all.sessions.length + all.runs.length - sessions.length - runs.length,
          note: "Only yourWorkers count toward maxWorkers. notCountedWorkers are the owner's own sessions and other runs: they never block you, though a card one of them is on stays theirs.",
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
          projectId: z.number().int().nonnegative().optional(),
          status: z.enum(CARD_STATUSES).optional(),
          query: z.string().max(200).optional(),
          limit: z.number().int().min(1).max(LIST_LIMIT).default(50),
        })
        .strict()
        .parse(args);
      if (input.projectId !== undefined && !inScope(input.projectId))
        fail(`Project ${input.projectId} is not in this orchestrator's scope`);
      const q = input.query?.trim().toLowerCase();
      const cards = [
        ...projects
          .filter((p) => input.projectId === undefined || p.id === input.projectId)
          .flatMap((p) => listCards(this.db, p.id)),
        // Cards that belong to no project ("All projects"), for an orchestrator that covers all.
        ...((input.projectId === undefined || input.projectId === 0) && inScope(0)
          ? listProjectlessCards(this.db)
          : []),
      ]
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
        // Read each with read_image (PM-400): never pasted into the conversation as text.
        attachments: this.attachmentsRoot
          ? listAttachments(this.attachmentsRoot, c.id).map((a, index) => ({
              index,
              name: a.name,
              type: a.type,
              bytes: a.bytes,
            }))
          : [],
      };
    }

    if (name === 'read_image') {
      const input = z
        .object({ card: z.unknown(), index: z.number().int().min(0) })
        .strict()
        .parse(args);
      const c = card(input.card);
      if (!this.attachmentsRoot) fail('Card images are not available here');
      const image = listAttachments(this.attachmentsRoot!, c.id)[input.index];
      if (!image) fail(`${c.key} has no image ${input.index}; get_card lists them`);
      const data = readFileSync(
        path.join(cardAttachmentsDir(this.attachmentsRoot!, c.id), image!.file),
      ).toString('base64');
      return { [MCP_CONTENT]: [{ type: 'image', mimeType: image!.type, data }] };
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
      // Accepting work (PM-427): the verdict on its finished runs follows the card, with evidence.
      const verdict =
        accepts(instance) && input.status && input.status !== c.status
          ? input.status === 'done'
            ? ('accepted' as const)
            : input.status === 'todo' && c.status === 'review'
              ? ('rejected' as const)
              : null
          : null;
      if (verdict && !input.note)
        fail(
          verdict === 'accepted'
            ? 'Accepting work needs a note with the evidence'
            : 'Sending work back needs a note saying what is missing',
        );
      const patch: { status?: CardStatus; description?: string } = {};
      if (input.status) patch.status = input.status;
      if (input.note) {
        patch.description = `${c.description}\n\nOrchestrator note (${new Date().toISOString()}):\n${input.note}`;
        if (patch.description.length > NOTE_LIMIT)
          fail(`Card notes are full (${NOTE_LIMIT} characters)`);
      }
      const updated = updateCard(this.db, c.id, patch);
      audit(c.id, 'update_card', { status: input.status, note: input.note });
      if (verdict) {
        const settled = this.supervisor
          .listRuns(c.projectId, c.id)
          .filter((r) => r.status === 'succeeded' && !r.validation);
        for (const r of settled)
          this.supervisor.validateRun(r.id, verdict, verdict === 'accepted' ? 'done' : undefined);
        if (settled.length)
          this.record(
            orchestratorId,
            verdict,
            `${c.key}: ${verdict} run${settled.length > 1 ? 's' : ''} ${settled.map((r) => r.id).join(', ')} (chat)`,
            c.id,
          );
      }
      if (input.status && input.status !== c.status)
        this.record(
          orchestratorId,
          'moved',
          `${c.key}: ${c.status} → ${input.status} (chat)`,
          c.id,
        );
      return brief(updated ?? c);
    }

    if (name === 'git') {
      const input = z
        .object({
          projectId: z.number().int().positive(),
          program: z.enum(['git', 'gh']),
          args: z.array(z.string().max(500)).min(1).max(40),
        })
        .strict()
        .parse(args);
      if (!doesGit(instance))
        fail('Git on its own is off for this orchestrator; the owner turns it on in its settings');
      const project = projects.find((p) => p.id === input.projectId);
      if (!project) fail(`Project ${input.projectId} is not in this orchestrator's scope`);
      const result = await runProjectGit(this.db, project!, input.program, input.args);
      if (gitCommandWrites(input.program, input.args))
        this.record(
          orchestratorId,
          'git',
          `${project!.name}: ${input.program} ${input.args.join(' ').slice(0, 160)} (exit ${result.exitCode}, chat)`,
        );
      return result;
    }

    if (name === 'create_card') {
      const input = z
        .object({
          projectId: z.number().int().nonnegative(),
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
      requireDelegation();
      const c = card(input.card);
      if (c.projectId === 0)
        fail(
          `${c.key} belongs to no project ("All projects"), so a worker has no folder to run in; ` +
            'work on it directly in this chat, or move it to a project first',
        );
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
      const { providerId, available } = await capacity(c, input.providerId);
      // Provider discovery yielded: another caller may already have reserved this request.
      const concurrent = replay();
      if (concurrent) return concurrent;
      const reservation: { intent?: ChatDispatchIntent } = {};
      const check = () => {
        if (reservation.intent && !reservation.intent.current())
          return { allowed: false, reason: 'Dispatch reservation changed' };
        const latest = getCard(this.db, c.id);
        if (
          !latest ||
          latest.title !== c.title ||
          latest.description !== c.description ||
          latest.status !== c.status ||
          latest.updatedAt !== c.updatedAt
        )
          return { allowed: false, reason: 'Task changed before launch; inspect it again' };
        return plan(latest, providerId, available, reservation.intent ? c.id : undefined);
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
          // The Settings permission level, as a session would get (PM-419).
          ...(await orchestratorRunLevel(this.db, providerId)),
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

    if (name === 'list_sessions') {
      const input = z
        .object({ projectId: z.number().int().positive().optional() })
        .strict()
        .parse(args);
      if (input.projectId !== undefined && !inScope(input.projectId))
        fail(`Project ${input.projectId} is not in your scope`);
      const sessions = this.supervisor
        .listAllSessions()
        .filter(
          (s) =>
            !s.orchestratorId &&
            inScope(s.projectId) &&
            (input.projectId === undefined || s.projectId === input.projectId),
        )
        .sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'))
        .slice(0, LIST_LIMIT);
      return { sessions: sessions.map(sessionBrief), delegation: delegates(instance) };
    }

    if (name === 'assign_card') {
      const input = z
        .object({
          card: z.unknown(),
          sessionId: z.number().int().positive(),
          instructions: z.string().trim().max(4000).optional(),
        })
        .strict()
        .parse(args);
      requireDelegation();
      const c = card(input.card);
      if (c.status === 'done') fail(`${c.key} is done; move it back first if it needs more work`);
      const s = this.supervisor.getSession(input.sessionId);
      if (!s || s.orchestratorId || !inScope(s.projectId))
        fail(`Session ${input.sessionId} is not a CLI session in your scope`);
      if (s!.projectId !== c.projectId)
        fail(
          `Session ${s!.id} works in ${projectName(s!.projectId)}, not ${projectName(c.projectId)}; pick a session in the card's project or start one`,
        );
      if (s!.status !== 'running') fail(`Session ${s!.id} is not running`);
      if (s!.cardId !== null && s!.cardId !== c.id)
        fail(`Session ${s!.id} is working on ${s!.cardKey}; pick an idle session without a card`);
      const own = ownWorkers();
      const { sessions, runs } = own.all;
      if (
        runs.some((r) => r.cardId === c.id) ||
        sessions.some((other) => other.cardId === c.id && other.id !== s!.id)
      )
        fail(`${c.key} already has a live worker; check it with get_card / worker_output`);
      // Handing a card to a session makes it one of your workers (PM-417), unless it already is.
      const ownLive = own.sessions.length + own.runs.length;
      if (!own.sessions.some((o) => o.id === s!.id) && ownLive >= instance.maxWorkers)
        fail(`At capacity: ${ownLive} of your ${instance.maxWorkers} workers are busy`);
      // Typing into a session mid-turn or mid-question would mix into its work: re-read the
      // state right before sending.
      const fresh = this.supervisor.getSession(s!.id);
      if (!fresh || fresh.status !== 'running') fail(`Session ${s!.id} is not running`);
      if (fresh!.tailState !== 'idle')
        fail(
          fresh!.tailState === 'input'
            ? `Session ${s!.id} is asking the user something; leave it to them`
            : `Session ${s!.id} is working; check back later or start a session instead`,
        );
      if (fresh!.queuedInputBytes > 0)
        fail(`Session ${s!.id} still has input waiting to be delivered; check back later`);
      const prompt = input.instructions
        ? defaultPrompt(
            c.key,
            c.title,
            c.description,
            `Instructions from the orchestrator:\n${input.instructions}`,
            c.issueUrl,
          )
        : undefined;
      if (instance.superviseSessions)
        this.service.sessionSupervision.assertCanEnroll(orchestratorId, s!.id);
      const result = this.supervisor.attachCard(s!.id, c.id, {
        send: true,
        ...(prompt ? { prompt } : {}),
      });
      recordOwnedSession(this.db, orchestratorId, s!.id, c.id);
      if (instance.superviseSessions)
        this.service.sessionSupervision.enroll(orchestratorId, s!.id, true);
      audit(c.id, 'assign_card', { sessionId: s!.id, instructions: input.instructions ?? null });
      this.record(
        orchestratorId,
        'assigned',
        `${c.key} handed to session ${s!.id} "${s!.name}" (chat)`,
        c.id,
      );
      return {
        assigned: true,
        delivery: result.sent
          ? result.queued
            ? 'queued: the session is down; it gets the task when it comes back'
            : 'sent, not confirmed: check with worker_output before sending anything again'
          : 'linked only: this session is not an AI CLI, so the task was not typed in',
        session: sessionBrief(result.session),
        card: brief(getCard(this.db, c.id) ?? c),
      };
    }

    if (name === 'start_session') {
      const input = z
        .object({
          card: z.unknown(),
          providerId: z.string().optional(),
          instructions: z.string().trim().max(4000).optional(),
          requestId: z.string().trim().min(1).max(128).optional(),
        })
        .strict()
        .parse(args);
      requireDelegation();
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
      const requests = new SessionRequests(this.db, orchestratorId);
      if (input.requestId) {
        const prior = requests.get(input.requestId);
        if (prior) {
          if (prior.fingerprint !== fingerprint)
            fail(`Request ID ${input.requestId} was used for different work; use a new ID`);
          const existing = prior.sessionId ? this.supervisor.getSession(prior.sessionId) : null;
          return {
            replayed: true,
            ...(existing
              ? { session: sessionBrief(existing) }
              : {
                  note: 'That request is still starting, or failed; do not start a replacement yet',
                }),
            card: brief(getCard(this.db, c.id) ?? c),
          };
        }
      }
      if (this.starting.has(c.id)) fail(`A session for ${c.key} is already starting`);
      this.starting.add(c.id);
      try {
        return await this.startSession(c, input, fingerprint, requests, {
          capacity,
          plan,
          audit,
          sessionBrief,
          brief,
          orchestratorId,
        });
      } finally {
        this.starting.delete(c.id);
      }
    }

    return fail(`Unknown tool: ${name}`);
  }

  /** Cards with a start_session in flight, so two concurrent calls cannot both start one. */
  private starting = new Set<number>();

  private async startSession(
    c: Card,
    input: { providerId?: string; instructions?: string; requestId?: string },
    fingerprint: string,
    requests: SessionRequests,
    h: {
      capacity: (
        c: Card,
        requested?: string,
      ) => Promise<{ providerId: string; available: Set<string> }>;
      plan: (
        latest: Card,
        providerId: string,
        available: Set<string>,
      ) => { allowed: boolean; reason: string };
      audit: (cardId: number, action: string, detail: unknown) => unknown;
      sessionBrief: (s: AgentSession) => unknown;
      brief: (c: Card) => unknown;
      orchestratorId: string;
    },
  ): Promise<unknown> {
    const { capacity, plan, audit, sessionBrief, brief, orchestratorId } = h;
    {
      const { providerId, available } = await capacity(c, input.providerId);
      const verdict = plan(getCard(this.db, c.id) ?? c, providerId, available);
      if (!verdict.allowed) fail(verdict.reason);
      if (input.requestId) requests.reserve(input.requestId, fingerprint);
      const prompt = input.instructions
        ? defaultPrompt(
            c.key,
            c.title,
            c.description,
            `Instructions from the orchestrator:\n${input.instructions}`,
            c.issueUrl,
          )
        : undefined;
      let session: AgentSession;
      try {
        session = await this.supervisor.createSession(c.projectId, {
          providerId,
          cardId: c.id,
          ...(prompt ? { prompt } : {}),
        });
      } catch (error) {
        if (input.requestId) requests.forget(input.requestId);
        throw error;
      }
      if (input.requestId) requests.started(input.requestId, session.id);
      recordOwnedSession(this.db, orchestratorId, session.id, c.id);
      if (this.instance(orchestratorId).superviseSessions)
        this.service.sessionSupervision.enroll(orchestratorId, session.id, true);
      audit(c.id, 'start_session', {
        sessionId: session.id,
        providerId,
        instructions: input.instructions ?? null,
      });
      this.record(
        orchestratorId,
        'started',
        `${c.key}: ${providerId} session ${session.id} started (chat)`,
        c.id,
      );
      return {
        started: sessionBrief(session),
        card: brief(getCard(this.db, c.id) ?? c),
        ...(input.requestId ? { requestId: input.requestId } : {}),
      };
    }
  }
}

/**
 * start_session request IDs of one orchestrator (PM-399): a lost response replays the same
 * session instead of starting another. Kept in settings, the newest 100.
 */
class SessionRequests {
  private key: string;
  constructor(
    private db: Db,
    orchestratorId: string,
  ) {
    this.key = `orchestrator-session-requests:${orchestratorId}`;
  }
  private all(): Record<string, { fingerprint: string; sessionId: number | null; at: string }> {
    return getSetting(this.db, this.key) ?? {};
  }
  private save(map: ReturnType<SessionRequests['all']>) {
    const entries = Object.entries(map)
      .sort((a, b) => b[1].at.localeCompare(a[1].at))
      .slice(0, 100);
    setSetting(this.db, this.key, Object.fromEntries(entries));
  }
  get(id: string) {
    return this.all()[id] ?? null;
  }
  reserve(id: string, fingerprint: string) {
    this.save({
      ...this.all(),
      [id]: { fingerprint, sessionId: null, at: new Date().toISOString() },
    });
  }
  started(id: string, sessionId: number) {
    const map = this.all();
    if (map[id]) map[id] = { ...map[id], sessionId };
    this.save(map);
  }
  forget(id: string) {
    const map = this.all();
    delete map[id];
    this.save(map);
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

/**
 * How the chat gets work done when it may hand it out (PM-399): to a session already in the
 * project, else a new one within the limits, else directly.
 */
const HAND_OVER =
  "Hand ready work to a CLI session: assign_card to an idle session in the card's project with no card (list_sessions), or start_session within your worker limits when none fits. Work directly here only when no session can take it or the task is about this orchestrator itself. Never type into a session that is working or asking the user; check hand-overs with worker_output instead of resending.";
/**
 * Drafting the next work for a project with nothing to do (PM-426). Only from what the owner has
 * committed to: a missing or Draft roadmap yields Backlog cards, never To do, because the
 * scheduler starts workers on To do cards by itself.
 */
export const PLAN_CARDS_PER_PROJECT = 3;
const PLAN_STEP = `Plan next work: for each project in your scope with nothing in To do or In progress, read its ROADMAP.md (the current phase and its exit criteria), its handover or notes file if it has one, and its Backlog cards. Call list_cards for the project first (every status, Done included) so you never duplicate a card. Then move up to ${PLAN_CARDS_PER_PROJECT} ready Backlog cards from the current phase to To do, or create up to ${PLAN_CARDS_PER_PROJECT} new cards: each one small and verifiable, with acceptance criteria and its source (file and section) in the notes. Draft only what the roadmap or the owner has committed to; when ROADMAP.md is missing or marked Draft, create cards in Backlog, not To do, and say so. Skip work only the owner can do (accounts, credentials, payments, decisions, real-device checks) and list it in your report instead. When a roadmap has nothing left, say so and draft nothing.`;

/** Accepting finished work (PM-427): verified against the card, never on the worker's word alone. */
const ACCEPT_STEP =
  "Review: for each card in Review, verify it against its requirements yourself: read its notes, the commits and diff in the project folder, and run the project's checks when they are quick. Clearly met: update_card to done with a note giving the evidence (this accepts its finished runs). Not met: update_card to todo with a note saying exactly what is missing (this rejects them). Leave in Review, with a note, only what needs the owner's judgment: visual or product decisions, real devices, accounts or payments.";

const CHECKS_DELEGATING: Partial<Record<CheckFocus, string>> = {
  todo: `To do: go through each To do task and decide whether it is ready to work on. ${HAND_OVER} Record concrete blockers on unclear tasks.`,
  in_progress:
    "In progress: check each card's progress (get_card, worker_output, list_sessions and the project's git log). Nudge an idle session that stopped short with message_worker; continue work directly only when its session is gone, preserving its changes. Move finished work to Review with evidence. Record concrete blockers on stalled cards.",
};

/** The Needs attention step's last rule, by whether git work is the orchestrator's own (PM-428). */
const ATTENTION_GIT_OFF =
  'Do not push, merge, discard files or delete branches without explicit authorization for that action.';
const ATTENTION_GIT_ON =
  'Git on its own is on: push verified unpushed work and merge ready pull requests with the git tool. Do not discard files without explicit authorization.';

const CHECKS: Record<CheckFocus, string> = {
  todo: 'To do: go through each To do task. Decide whether it is ready to work on. Implement ready tasks directly in this chat session, most important first. Inspect the project instructions and existing changes, complete the work and verify it before moving cards to Review. Do not dispatch workers or delegate; record concrete blockers on unclear tasks.',
  in_progress:
    "In progress: check each card's progress (get_card, worker_output, and the project's git log in its folder). Continue unfinished work directly here, preserving changes from existing sessions. Move finished work to Review with evidence; do not dispatch workers. Record concrete blockers on stalled cards.",
  review:
    'Review: for each card in Review, check the evidence (latest run outcome, commits, notes) and tell me which are ready for me to accept and which need more work (note why on the card).',
  attention:
    'Needs attention: inspect the live All projects dashboard alerts in overview, including uncommitted and unpushed work. Read the affected project instructions and diffs; address safe, authorized fixes directly here and verify them. Preserve unrelated changes. Do not dismiss unresolved alerts or mark work complete without evidence. Report the exact project, remaining work and any action requiring owner input. ' +
    ATTENTION_GIT_OFF,
  plan: PLAN_STEP,
  all: '',
};

/** The message that hands one card to the orchestrator chat (PM-202). */
export function cardPrompt(instance: OrchestratorConfig, card: Card, projectName: string): string {
  const notes = card.description.trim();
  const observe =
    instance.strategy === 'observe'
      ? ' Watch only: inspect and recommend; do not edit files or move cards unless I explicitly authorize it.'
      : '';
  return [
    `Pick up ${card.key} (${projectName}, ${card.status.replace('_', ' ')}): ${card.title}`,
    notes
      ? `Card notes:
${notes.length > 1500 ? `${notes.slice(0, 1500)}…` : notes}`
      : '',
    delegates(instance)
      ? `Call get_card ${card.key} for its full notes and history and read the project's instructions. ${HAND_OVER} Verify before moving it to Review, and keep the board truthful.`
      : `Call get_card ${card.key} for its full notes and history, read the project's instructions, and work it directly in this chat session; do not dispatch workers or delegate. Verify before moving it to Review, and keep the board truthful.${observe}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function checkPrompt(
  instance: OrchestratorConfig,
  focus: CheckFocus,
  attentionKinds: readonly string[] = [],
): string {
  const only =
    attentionKinds.length > 0
      ? ` Handle only these alert kinds: ${attentionKinds.join(', ')}; leave every other alert untouched and say so.`
      : '';
  const delegating = delegates(instance);
  const attention = doesGit(instance)
    ? CHECKS.attention.replace(ATTENTION_GIT_OFF, ATTENTION_GIT_ON)
    : CHECKS.attention;
  const step = (f: Exclude<CheckFocus, 'all'>) =>
    f === 'attention'
      ? attention
      : f === 'review' && accepts(instance)
        ? ACCEPT_STEP
        : ((delegating ? CHECKS_DELEGATING[f] : undefined) ?? CHECKS[f]);
  const steps =
    focus === 'all'
      ? [
          step('in_progress'),
          step('review'),
          step('todo'),
          step('attention'),
          ...(plans(instance) ? [step('plan')] : []),
        ]
      : [focus === 'attention' ? attention + only : step(focus)];
  const observe =
    instance.strategy === 'observe'
      ? '\nWatch only: inspect and recommend changes; do not edit files or move cards unless the user explicitly authorizes the work.'
      : '';
  return [
    delegating
      ? 'Check on pending work in your scope now. Call overview first. Hand work to CLI sessions in your projects where one fits, within your worker limits; work directly here otherwise.'
      : 'Check on pending work in your scope now. Call overview first. Work directly in this chat session; do not dispatch workers or delegate. Worker capacity does not gate direct work.',
    ...steps.map((s, i) => `${i + 1}. ${s}`),
    `Finish with a short report: what you moved, started or noted, what's blocked, and what needs me.${observe}`,
  ].join('\n');
}

/** The orchestrator's standing briefing, regenerated at every open from the live scope. */
export function briefing(
  instance: OrchestratorConfig,
  projects: ProjectSummary[],
  recent: readonly OrchestratorEvent[] = [],
): string {
  const project = (p: ProjectSummary) => {
    const c = p.cardCounts;
    const git = p.git?.isRepo
      ? `branch ${p.git.branch ?? '?'}, ${p.git.dirtyFiles ?? 0} uncommitted, ${p.git.ahead ?? 0} unpushed, last commit ${p.git.lastCommitAt ?? 'never'}`
      : 'not a git repo';
    return `- **${p.name}** (project ${p.id}) at \`${p.path}\`${p.missing ? ' (FOLDER MISSING)' : ''}: ${git}. Board: ${c.backlog} backlog, ${c.todo} to do, ${c.in_progress} in progress, ${c.review} review, ${c.done} done.`;
  };
  const supervision = instance.superviseSessions
    ? 'Session supervision is enabled. Use check_session to inspect progress and eligibility, supervise_session to enroll/release existing workers, continue_session for unfinished idle card work, and wake_session only for an explicit stopped-session wake request. Assigned and newly started sessions enroll automatically. Never retry an uncertain send without checking worker_output. Quota waits, questions and drafts must remain with their existing owner.'
    : 'Automatic session supervision is off. check_session can inspect readiness; ask the owner to enable supervision before enrolling sessions.';
  return `# Orchestrator: ${instance.name}

${supervision}

You are this ProjectManager orchestrator. The user chats with you here and you act on
their requests across the projects below: following up on tasks, checking progress, moving cards
and implementing authorized work directly in this chat session. This folder is your home; inspect and edit the scoped projects using their absolute paths.

## Your settings

- Chat mode: ${instance.strategy === 'observe' ? 'Watch only (recommend; implement only when the user explicitly asks)' : delegates(instance) ? 'Hand authorized work to CLI sessions in your projects; work directly when none can take it' : 'Process authorized work directly in this chat session'}
${
  delegates(instance)
    ? '- Handing work to CLI sessions is on: assign_card, start_session, dispatch_worker and message_worker are available, within the limits below.'
    : '- Do not dispatch workers or delegate work from this chat. Worker capacity does not block direct work.'
}
- Background scheduler settings below are separate from this chat's direct work:
- Providers for workers: ${instance.providers.join(', ')}
- Worker limits: ${instance.maxWorkers} in total, ${instance.maxWorkersPerProject} per project, counting only the workers you started, handed a card or supervise; the owner's own sessions never use them up

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
- \`read_image\`: look at a card's attached image (index from get_card).
- \`list_sessions\`: the CLI sessions in your projects, with their state and linked card.
- \`assign_card\`: hand a card to an idle session in its project (links it, moves it to In progress, types the task in). Delivery is not confirmed: check with worker_output, never resend blindly.
- \`start_session\`: start a new CLI session on a card in its project, within your worker limits and the quota reserve. Use a unique requestId and reuse it after a lost response.
${doesGit(instance) ? '- `git`: git or gh in a project, as its own identity (Git on its own is on).\n' : ''}- \`sop_report\`, \`sop_card\`: audit your projects against our SOPs (Settings > SOPs) and turn a gap into a card. Waivers are the owner's decision; suggest one with a reason instead of treating a gap as fine.

## How to work

- Call \`report_work\` before each card or repository task, and clear it when finished or blocked, so the chat shows the actual task above its terminal.

${
  delegates(instance)
    ? `- To do: inspect each task and its project's instructions. ${HAND_OVER} Verify the requirements before moving a card to Review.
- In progress: check progress (get_card, worker_output, list_sessions, the project's \`git log\`/\`git status\`).
  Nudge an idle session that stopped short; continue directly only when its session is gone, without overwriting its changes. Move finished work to Review with evidence; note concrete blockers.`
    : `- To do: inspect each task and its project's instructions, then implement authorized work directly here. Preserve existing changes; verify the requirements before moving a card to Review. Do not dispatch workers or delegate.
- In progress: check progress (get_card, worker_output, the project's \`git log\`/\`git status\`).
  Continue unfinished work directly here without overwriting active sessions' changes. Move finished work to Review with evidence; note concrete blockers.`
}
${
  plans(instance)
    ? `- Plan: when a project has nothing in To do or In progress, draft its next cards from its ROADMAP.md and Backlog (at most ${PLAN_CARDS_PER_PROJECT} per project per check, no duplicates, the source in each card's notes). A missing or Draft roadmap gives Backlog cards only.
`
    : ''
}${
    accepts(instance)
      ? `- Review: accepting finished work is on. Verify each Review card yourself (notes, commits and diff, quick checks); move it to Done with an evidence note when clearly met, which accepts its finished runs, or back to To do with what is missing, which rejects them. Leave only what needs the owner's judgment in Review, with a note.`
      : `- Review: check the evidence and tell the user what's ready to accept. Move to Done only when
  the requirements are clearly met; the user accepts or rejects finished runs.`
  }
- Read scoped project folders and make authorized changes directly in this chat. Follow each project's instructions, preserve unrelated changes, and run appropriate checks. ${
    doesGit(instance)
      ? "Git on its own is on: push, open and merge pull requests and manage branches yourself with the `git` tool, which acts as each project's own commit author and GitHub account (never push from your shell: it may use the wrong account). Push only verified work, merge a pull request only when it is mergeable and its checks pass, and follow a project's own branch and release rules where it states them. The tool refuses force pushes, discarding uncommitted work, deleting the main branch and skipping hooks; never work around it. Other destructive commands still need explicit authorization."
      : 'Never push, merge, delete branches or run destructive commands without explicit authorization for that action.'
  }
- Keep the board truthful: every move gets a short note saying why.
- Report concisely: what you did, what's blocked, what needs the user.

## Long sessions

This conversation may be compacted or restarted; this file is rewritten at every open and the
CLI reloads it, but anything only said in chat can be lost.

- Keep \`${HANDOVER}\` in this folder current: open threads, what you handed to which session or
  worker, decisions the user made and what you are waiting for. Read it after a restart or when
  you lose track, and replace finished entries rather than letting it grow (keep it short).
- Put large artefacts (logs, long command output, screenshots, diffs) in \`${ARTIFACTS}/\` here and
  refer to them by path instead of pasting them into the conversation. The oldest are removed
  beyond ${ARTIFACT_FILES} files or ${ARTIFACT_MB} MB.
- Look at card images with \`read_image\` (indexes in get_card's attachments), and ask
  worker_output for only as many characters as you need.
- The board and its notes are the durable record: put evidence on cards, not only in chat.
${
  recent.length
    ? `
## Your recent activity (newest first, when this chat opened)

${recent.map((e) => `- ${e.at.slice(0, 16).replace('T', ' ')} ${e.action}: ${e.message.slice(0, 200)}`).join('\n')}
`
    : ''
}`;
}
