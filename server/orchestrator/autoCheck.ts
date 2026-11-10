import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db.js';
import type { OrchestratorConfig } from '../../shared/orchestrator.js';
import type { AgentSession } from '../../shared/types.js';
import { sessionLabel } from '../../shared/sessionLabel.js';
import {
  getCard,
  getSetting,
  listCards,
  listCardsInFlight,
  listProjectFolders,
  listSchedulableCards,
  setSetting,
} from '../store.js';
import { readLimits } from '../agents/limits.js';
import { ownedSessionIds } from './ownedWorkers.js';
import { sessionQuota } from './sessionSupervision.js';
import { plans, type CheckFocus } from './chat.js';
import {
  activeGoals,
  goalsDue,
  goalsReadyToClose,
  noteBudgetReached,
  noteClosePrompted,
  noteGoalCheck,
  overBudget,
} from './goals.js';

/** Bounds on automatic checks (PM-418). */
export const AUTO_CHECK_MAX_PER_HOUR = 4;
export const AUTO_CHECK_MIN_GAP_MS = 5 * 60_000;
export const AUTO_CHECK_FALLBACK_MS = 30 * 60_000;
/** Planning checks (PM-426) in any 24 hours, on top of the hourly bound. */
export const PLAN_MAX_PER_DAY = 6;
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** What the last look saw; a trigger is a change against it. */
interface AutoCheckState {
  /** Timestamps (ms) of automatic checks within the last hour. */
  sent: number[];
  lastCheckAt: number;
  /** Owned sessions that were working. */
  running: number[];
  /** Cards that were in Review. */
  review: number[];
  /** Providers whose quota was usable (above the reserve). */
  quotaOk: string[];
  /**
   * The board (To do, In progress and Review cards in scope) when the last automatic check was
   * sent. The fallback skips a board that has not changed since: everything left is waiting on
   * the owner, and asking again only spends quota on the same answer.
   */
  checkedBoard?: string;
  /**
   * Idle projects (nothing in To do or In progress) and their fingerprint (ROADMAP.md plus every
   * card) when the chat was last asked to plan them (PM-426). A project is planned again only
   * when that changes, so a roadmap with nothing left is not asked about again and again.
   */
  planned?: Record<string, string>;
  /** Timestamps (ms) of checks that asked for planning, within the last day. */
  planSent?: number[];
}

interface Deps {
  db: Db;
  dataDir: string | null;
  listSessions: () => AgentSession[];
  policy: (id: string) => OrchestratorConfig | undefined;
  instances: () => OrchestratorConfig[];
  /** The chat's newest session, live or stopped. */
  chatSession: (id: string) => AgentSession | null;
  /** chat.check: it keeps its own 409 guards. */
  check: (id: string, focus: CheckFocus) => Promise<unknown>;
  record: (id: string, message: string) => void;
  now?: () => number;
}

const key = (id: string) => `orchestrator-auto-check:${id}`;

/**
 * Lets an opted-in orchestrator ask its own chat for the existing check when something changed in
 * scope. It never opens or restarts a chat, never types while the chat is busy, asking, or has
 * queued input, and is bounded by a per-hour count and a minimum gap. A trigger is the difference
 * between the persisted state and now. The state only advances fully when a check is sent, so a
 * deferred trigger stays pending, and a restart neither loses nor repeats one.
 */
export class AutoCheck {
  private timer: NodeJS.Timeout | undefined;
  private busy = false;
  constructor(private deps: Deps) {}

  start(intervalMs = 30_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const instance of this.deps.instances()) {
        try {
          await this.consider(instance.id);
        } catch (e) {
          console.error('[orchestrator] auto check:', (e as Error).message);
        }
      }
    } finally {
      this.busy = false;
    }
  }

  private async consider(id: string): Promise<void> {
    const { db } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const policy = this.deps.policy(id);
    // Off, paused or watch-only: forget the baseline, so turning it on starts from a fresh look.
    if (!policy?.autoCheck || !policy.enabled || policy.strategy === 'observe') {
      if (getSetting(db, key(id)) !== null) setSetting(db, key(id), null);
      return;
    }
    const current = this.observe(policy, now);
    const previous = getSetting<AutoCheckState>(db, key(id));
    if (!previous) {
      this.save(id, { ...current.state, sent: [], lastCheckAt: now, checkedBoard: '' });
      return;
    }
    const checkedBoard = previous.checkedBoard ?? '';
    const triggers: string[] = [];
    for (const sessionId of previous.running)
      if (!current.state.running.includes(sessionId)) {
        const name = this.deps.listSessions().find((s) => s.id === sessionId)?.name;
        triggers.push(`${sessionLabel({ id: sessionId, name })} stopped working`);
      }
    for (const cardId of current.state.review)
      if (!previous.review.includes(cardId)) triggers.push(`card ${cardId} moved to Review`);
    const boardMoved = current.board !== checkedBoard;
    // Recovered quota only helps with work to hand out (To do) or a board that moved since the
    // last check. Otherwise every 5-hour reset would ask again for the same answer.
    if (current.assignable || boardMoved)
      for (const p of current.state.quotaOk)
        if (!previous.quotaOk.includes(p)) triggers.push(`${p} quota recovered`);
    const planned = previous.planned ?? {};
    const planSent = (previous.planSent ?? []).filter((t) => now - t < DAY_MS);
    const planDue = Object.entries(current.idle).filter(([pid, print]) => planned[pid] !== print);
    const planning = planDue.length > 0 && planSent.length < PLAN_MAX_PER_DAY;
    // Only planning to ask for: a narrow check, so the chat does not re-review the whole board.
    // Active goals (PM-433) come back on their own schedule; any other check works on them too.
    const goals = activeGoals(db, id);
    // A goal whose budget is used up comes back once for its closing report, then waits (PM-473).
    const spent = goals.filter((g) => overBudget(g, now));
    // A goal whose linked cards are all Done comes back at once to be verified and closed (PM-454).
    const ready = goalsReadyToClose(goals, (id) => getCard(db, id)?.status).filter(
      (g) => !spent.includes(g),
    );
    const goalDue = goalsDue(goals, now).filter((g) => !ready.includes(g) && !spent.includes(g));
    const goalWork = goalDue.length + ready.length + spent.length;
    const focus: CheckFocus =
      triggers.length || (planning && goalWork)
        ? 'all'
        : planning
          ? 'plan'
          : goalWork
            ? 'goal'
            : 'all';
    if (spent.length)
      triggers.push(
        ...spent.map((g) => `goal "${g.title.slice(0, 60)}" reached its budget: closing report`),
      );
    if (ready.length)
      triggers.push(
        ...ready.map((g) => `goal "${g.title.slice(0, 60)}" has every linked card Done`),
      );
    if (goalDue.length)
      triggers.push(...goalDue.map((g) => `goal "${g.title.slice(0, 60)}" continues`));
    if (planning)
      triggers.push(
        ...planDue.map(([pid]) => `${current.names[pid] ?? `project ${pid}`} has nothing to do`),
      );
    if (
      !triggers.length &&
      current.pending &&
      boardMoved &&
      now - previous.lastCheckAt >= AUTO_CHECK_FALLBACK_MS
    )
      triggers.push('slow fallback, the board changed and work is pending');

    const sent = previous.sent.filter((t) => now - t < HOUR_MS);
    if (!triggers.length) {
      // Nothing to report: follow the present, so a later change is measured against it.
      this.save(id, {
        ...current.state,
        sent,
        lastCheckAt: previous.lastCheckAt,
        checkedBoard,
        planned,
        planSent,
      });
      return;
    }
    // Deferred triggers stay visible in the baseline until a check goes out.
    const deferred: AutoCheckState = {
      sent,
      lastCheckAt: previous.lastCheckAt,
      running: [...new Set([...previous.running, ...current.state.running])],
      review: previous.review.filter((c) => current.state.review.includes(c)),
      quotaOk: previous.quotaOk.filter((p) => current.state.quotaOk.includes(p)),
      checkedBoard,
      planned,
      planSent,
    };
    const chat = this.deps.chatSession(id);
    if (
      sent.length >= AUTO_CHECK_MAX_PER_HOUR ||
      now - previous.lastCheckAt < AUTO_CHECK_MIN_GAP_MS ||
      // A stopped (or never opened) chat stays the owner's choice.
      !chat ||
      chat.status !== 'running' ||
      chat.tailState === 'running' ||
      chat.tailState === 'input' ||
      chat.queuedInputBytes > 0
    ) {
      this.save(id, deferred);
      return;
    }
    try {
      await this.deps.check(id, focus);
    } catch {
      this.save(id, deferred); // chat.check's own guards said no; the trigger stays pending.
      return;
    }
    if (focus === 'all' || focus === 'goal')
      noteClosePrompted(
        db,
        id,
        ready.map((g) => g.id),
      );
    // Every check that carried the goal step counts against each active goal's stall limit,
    // unless its work visibly moved: a linked card changed or someone is working on one (PM-456).
    const working = new Set(
      this.deps
        .listSessions()
        .filter((s) => !s.orchestratorId && s.status === 'running' && s.tailState === 'running')
        .map((s) => s.cardId)
        .filter((c): c is number => typeof c === 'number'),
    );
    const moved = new Set(
      goals
        .filter((g) =>
          (g.cardIds ?? []).some((cardId) => {
            if (working.has(cardId)) return true;
            const updated = getCard(db, cardId)?.updatedAt;
            return Boolean(updated) && Date.parse(updated!) > (g.lastNudgeAt ?? 0);
          }),
        )
        .map((g) => g.id),
    );
    if (goals.length && (focus === 'all' || focus === 'goal'))
      for (const g of noteGoalCheck(db, id, now, moved))
        this.deps.record(
          id,
          `Goal ${g.id} "${g.title}" has had no progress in several checks; it stays active and is checked hourly`,
        );
    // The check just sent asked for the closing report; those goals now wait for the owner.
    if (spent.length && (focus === 'all' || focus === 'goal')) {
      noteBudgetReached(
        db,
        id,
        spent.map((g) => g.id),
        now,
      );
      for (const g of spent)
        this.deps.record(
          id,
          `Goal ${g.id} "${g.title}" reached its budget: closing report asked for, now waiting for the owner`,
        );
    }
    this.deps.record(
      id,
      `Automatic check (${triggers.slice(0, 3).join('; ')}${triggers.length > 3 ? `; +${triggers.length - 3} more` : ''})`,
    );
    this.save(id, {
      ...current.state,
      sent: [...sent, now],
      lastCheckAt: now,
      checkedBoard: current.board,
      // A check with the plan step covers every idle project, so each is now planned as it is.
      planned: plans(policy) ? { ...planned, ...current.idle } : planned,
      planSent: planning ? [...planSent, now] : planSent,
    });
  }

  private save(id: string, state: AutoCheckState) {
    setSetting(this.deps.db, key(id), state);
  }

  private observe(policy: OrchestratorConfig, now: number) {
    const { db } = this.deps;
    const sessions = this.deps.listSessions().filter((s) => !s.orchestratorId);
    const owned = ownedSessionIds(db, policy.id, sessions);
    const running = sessions
      .filter((s) => owned.has(s.id) && s.status === 'running' && s.tailState === 'running')
      .map((s) => s.id);
    const cards = listCardsInFlight(db, policy.projectIds);
    const review = cards.filter((c) => c.status === 'review').map((c) => c.id);
    const limits = readLimits(this.deps.dataDir);
    const quotaOk = policy.providers.filter((p) => sessionQuota(policy, p, limits, now) === null);
    const todo = listSchedulableCards(db, policy.projectIds).filter((c) => c.status === 'todo');
    const board = createHash('sha256')
      .update(
        [...cards, ...todo]
          .map((c) => `${c.id}:${c.status}:${c.updatedAt}`)
          .sort()
          .join('|'),
      )
      .digest('hex');
    // Projects with nothing to do, fingerprinted for planning (PM-426).
    const idle: Record<string, string> = {};
    const names: Record<string, string> = {};
    if (plans(policy))
      for (const project of listProjectFolders(db)) {
        if (policy.projectIds.length && !policy.projectIds.includes(project.id)) continue;
        const projectCards = listCards(db, project.id);
        if (projectCards.some((c) => c.status === 'todo' || c.status === 'in_progress')) continue;
        let roadmap = '';
        try {
          roadmap = readFileSync(path.join(project.path, 'ROADMAP.md'), 'utf8');
        } catch {
          // No roadmap: the chat drafts Backlog cards at most, and says so.
        }
        idle[project.id] = createHash('sha256')
          .update(roadmap)
          .update(
            projectCards
              .map((c) => `${c.id}:${c.status}:${c.updatedAt}`)
              .sort()
              .join('|'),
          )
          .digest('hex');
        names[project.id] = path.basename(project.path);
      }
    return {
      state: { running, review, quotaOk },
      idle,
      names,
      pending: cards.length > 0 || todo.length > 0,
      assignable: todo.length > 0,
      board,
    };
  }
}
