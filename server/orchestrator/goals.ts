import type { Db } from '../db.js';
import { getSetting, setSetting } from '../store.js';

/*
 * Goals (PM-433): an objective the owner gives an orchestrator's chat ("keep track of X and get
 * it done"), recorded with the condition that means done. While a goal is active, the automatic
 * check (PM-418) keeps bringing the chat back to it: plan the next steps, get them done itself or
 * through sessions and runs, report progress, until the chat marks it achieved with evidence or
 * blocked on the owner. A goal that gets several checks without any reported progress is set to
 * blocked, so a stuck loop stops spending quota and the owner sees why.
 */

import type {
  GoalCriterion,
  GoalProgress,
  GoalStatus,
  OrchestratorGoal,
} from '../../shared/orchestrator.js';

export type { GoalCriterion, GoalProgress, GoalStatus, OrchestratorGoal };

/** Active goals one orchestrator may hold at once. */
export const MAX_ACTIVE_GOALS = 5;
/** How often an active goal is brought back to the chat when nothing else asks for a check. */
export const GOAL_NUDGE_MS = 15 * 60_000;
/** Criteria on one goal's checklist (PM-471). */
export const MAX_GOAL_CRITERIA = 12;
/** A criterion change: a new state with its evidence. */
export interface CriterionUpdate {
  id: number;
  state: GoalCriterion['state'];
  evidence?: string;
}
/** Criteria still keeping a goal from achieved (PM-471). */
export const unmetCriteria = (g: OrchestratorGoal) =>
  (g.criteria ?? []).filter((c) => c.state !== 'passing');

/** Cards one goal may link (PM-448). */
export const MAX_GOAL_CARDS = 60;
/**
 * Checks without progress before a goal counts as quiet (PM-459): it stays active (the owner's
 * decision: never blocked automatically), gets one note and a notification, and comes back less
 * often, every GOAL_QUIET_NUDGE_MS, until something moves.
 */
export const GOAL_STALL_CHECKS = 4;
export const GOAL_QUIET_NUDGE_MS = 60 * 60_000;
/** Whether a goal has gone quiet: no progress in GOAL_STALL_CHECKS checks. */
export const isQuiet = (g: OrchestratorGoal) =>
  g.status === 'active' && (g.nudgesWithoutProgress ?? 0) >= GOAL_STALL_CHECKS;
const KEEP_PROGRESS = 40;
const KEEP_GOALS = 50;

const key = (orchestratorId: string) => `orchestrator-goals:${orchestratorId}`;

export function listGoals(db: Db, orchestratorId: string): OrchestratorGoal[] {
  return getSetting<OrchestratorGoal[]>(db, key(orchestratorId)) ?? [];
}

export function activeGoals(db: Db, orchestratorId: string): OrchestratorGoal[] {
  return listGoals(db, orchestratorId).filter((g) => g.status === 'active');
}

function save(db: Db, orchestratorId: string, goals: OrchestratorGoal[]) {
  // Finished goals go first when the list is full; active ones are never dropped.
  const open = goals.filter((g) => g.status === 'active' || g.status === 'paused');
  const closed = goals.filter((g) => !open.includes(g));
  const keep = closed.slice(Math.max(0, closed.length - (KEEP_GOALS - open.length)));
  setSetting(
    db,
    key(orchestratorId),
    goals.filter((g) => open.includes(g) || keep.includes(g)),
  );
}

export function addGoal(
  db: Db,
  orchestratorId: string,
  input: {
    title: string;
    objective: string;
    doneWhen: string;
    projectIds?: number[];
    cardIds?: number[];
    /** The acceptance checklist (PM-471); each starts open. */
    criteria?: string[];
    /** Optional limits per budget window (PM-473). */
    budget?: OrchestratorGoal['budget'];
  },
  now = new Date(),
): OrchestratorGoal {
  const goals = listGoals(db, orchestratorId);
  if ((input.criteria ?? []).length > MAX_GOAL_CRITERIA)
    throw new Error(`A goal has at most ${MAX_GOAL_CRITERIA} criteria`);
  if (goals.filter((g) => g.status === 'active').length >= MAX_ACTIVE_GOALS)
    throw new Error(
      `${MAX_ACTIVE_GOALS} goals are already active; finish, pause or drop one first`,
    );
  const at = now.toISOString();
  const goal: OrchestratorGoal = {
    id: Math.max(0, ...goals.map((g) => g.id)) + 1,
    title: input.title,
    objective: input.objective,
    doneWhen: input.doneWhen,
    projectIds: [...new Set(input.projectIds ?? [])],
    cardIds: [...new Set(input.cardIds ?? [])].slice(0, MAX_GOAL_CARDS),
    criteria: (input.criteria ?? [])
      .map((t) => t.trim())
      .filter(Boolean)
      .map((text, i) => ({ id: i + 1, text, state: 'open' as const })),
    ...(budgetOf(input.budget) ? { budget: budgetOf(input.budget), budgetStartedAt: at } : {}),
    status: 'active',
    createdAt: at,
    updatedAt: at,
    progress: [],
    nudgesWithoutProgress: 0,
  };
  save(db, orchestratorId, [...goals, goal]);
  return goal;
}

/** Records progress and/or a new status. Progress from the chat or the owner resets the stall count. */
export function updateGoal(
  db: Db,
  orchestratorId: string,
  goalId: number,
  change: {
    note?: string;
    status?: GoalStatus;
    by: GoalProgress['by'];
    /** Cards to link and unlink (PM-448). */
    link?: number[];
    unlink?: number[];
    projectIds?: number[];
    /** Checklist changes (PM-471): new criteria, and criteria checked with evidence. */
    addCriteria?: string[];
    criteria?: CriterionUpdate[];
    /** New limits (PM-473); null removes them. */
    budget?: OrchestratorGoal['budget'] | null;
  },
  now = new Date(),
): OrchestratorGoal {
  const goals = listGoals(db, orchestratorId);
  const goal = goals.find((g) => g.id === goalId);
  if (!goal) throw new Error(`No goal ${goalId}`);
  if (
    change.status === 'active' &&
    goal.status !== 'active' &&
    goals.filter((g) => g.status === 'active').length >= MAX_ACTIVE_GOALS
  )
    throw new Error(`${MAX_ACTIVE_GOALS} goals are already active`);
  const at = now.toISOString();
  const unlink = new Set(change.unlink ?? []);
  const cardIds = [...new Set([...(goal.cardIds ?? []), ...(change.link ?? [])])].filter(
    (id) => !unlink.has(id),
  );
  if (cardIds.length > MAX_GOAL_CARDS)
    throw new Error(`A goal links at most ${MAX_GOAL_CARDS} cards`);
  let criteria = goal.criteria ?? [];
  for (const update of change.criteria ?? []) {
    if (!criteria.some((c) => c.id === update.id))
      throw new Error(`No criterion ${update.id} on goal ${goalId}`);
    if (update.state === 'passing' && !update.evidence?.trim())
      throw new Error(`Criterion ${update.id} needs evidence to pass`);
  }
  criteria = criteria.map((c) => {
    const update = (change.criteria ?? []).find((u) => u.id === c.id);
    if (!update) return c;
    const checkedBy = change.by === 'system' ? 'verifier' : change.by;
    return {
      ...c,
      state: update.state,
      ...(update.evidence?.trim() ? { evidence: update.evidence.trim() } : {}),
      checkedBy,
      checkedAt: at,
    };
  });
  for (const text of (change.addCriteria ?? []).map((t) => t.trim()).filter(Boolean))
    criteria = [
      ...criteria,
      { id: Math.max(0, ...criteria.map((c) => c.id)) + 1, text, state: 'open' as const },
    ];
  if (criteria.length > MAX_GOAL_CRITERIA)
    throw new Error(`A goal has at most ${MAX_GOAL_CRITERIA} criteria`);
  const next: OrchestratorGoal = {
    ...goal,
    ...(change.status ? { status: change.status } : {}),
    ...(change.link || change.unlink ? { cardIds } : {}),
    ...(change.projectIds ? { projectIds: [...new Set(change.projectIds)] } : {}),
    ...(change.criteria || change.addCriteria ? { criteria } : {}),
    ...(change.budget !== undefined
      ? budgetOf(change.budget ?? undefined)
        ? { budget: budgetOf(change.budget ?? undefined) }
        : { budget: undefined }
      : {}),
    // The owner resuming a goal, or changing its budget, opens a new budget window (PM-473).
    ...((change.status === 'active' && change.by === 'owner' && goal.budgetReachedAt) ||
    change.budget !== undefined
      ? { budgetReachedAt: undefined, checksUsed: 0, budgetStartedAt: at }
      : {}),
    updatedAt: at,
    progress: change.note
      ? [...goal.progress, { at, note: change.note, by: change.by }].slice(-KEEP_PROGRESS)
      : goal.progress,
    ...(change.by !== 'system' ? { nudgesWithoutProgress: 0 } : {}),
  };
  save(
    db,
    orchestratorId,
    goals.map((g) => (g.id === goalId ? next : g)),
  );
  return next;
}

/** A goal's linked card set as one comparable key (PM-454). */
export const cardSetKey = (g: OrchestratorGoal) =>
  [...(g.cardIds ?? [])].sort((a, b) => a - b).join(',');

/**
 * Active goals whose linked cards are all Done and whose chat has not been asked to close them
 * for this card set yet (PM-454): the next automatic check asks it to verify doneWhen.
 */
export function goalsReadyToClose(
  goals: readonly OrchestratorGoal[],
  status: (cardId: number) => string | undefined,
): OrchestratorGoal[] {
  return goals.filter(
    (g) =>
      g.status === 'active' &&
      (g.cardIds ?? []).length > 0 &&
      (g.cardIds ?? []).every((id) => status(id) === 'done') &&
      g.closePromptedFor !== cardSetKey(g),
  );
}

/** Records that the chat was asked to close these goals for their current card sets. */
export function noteClosePrompted(db: Db, orchestratorId: string, goalIds: readonly number[]) {
  if (!goalIds.length) return;
  save(
    db,
    orchestratorId,
    listGoals(db, orchestratorId).map((g) =>
      goalIds.includes(g.id) ? { ...g, closePromptedFor: cardSetKey(g) } : g,
    ),
  );
}

/** Replaces one goal's fields without touching its progress or stall count (PM-472). */
export function patchGoal(
  db: Db,
  orchestratorId: string,
  goalId: number,
  patch: Partial<OrchestratorGoal>,
): OrchestratorGoal | null {
  let found: OrchestratorGoal | null = null;
  const goals = listGoals(db, orchestratorId).map((g) => {
    if (g.id !== goalId) return g;
    found = { ...g, ...patch };
    return found;
  });
  if (found) save(db, orchestratorId, goals);
  return found;
}

/** A budget with at least one positive limit, or undefined (PM-473). */
export function budgetOf(budget?: OrchestratorGoal['budget']): OrchestratorGoal['budget'] {
  const checks = budget?.checks && budget.checks > 0 ? Math.floor(budget.checks) : undefined;
  const days = budget?.days && budget.days > 0 ? budget.days : undefined;
  return checks || days ? { ...(checks ? { checks } : {}), ...(days ? { days } : {}) } : undefined;
}

/** How much of its budget window a goal has used, for the chat and the page (PM-473). */
export function budgetUse(g: OrchestratorGoal, now: number) {
  const started = Date.parse(g.budgetStartedAt ?? g.createdAt);
  return {
    checks: g.checksUsed ?? 0,
    days: Math.max(0, (now - started) / 86_400_000),
  };
}

/** An active goal whose budget window is used up and not yet reported (PM-473). */
export function overBudget(g: OrchestratorGoal, now: number): boolean {
  if (g.status !== 'active' || g.budgetReachedAt || !g.budget) return false;
  const use = budgetUse(g, now);
  return (
    (g.budget.checks !== undefined && use.checks >= g.budget.checks) ||
    (g.budget.days !== undefined && use.days >= g.budget.days)
  );
}

/**
 * After the check that asked for the closing report: these goals pause and wait for the owner,
 * with a note saying why (PM-473). Resuming opens a new budget window.
 */
export function noteBudgetReached(
  db: Db,
  orchestratorId: string,
  goalIds: readonly number[],
  now: number,
) {
  if (!goalIds.length) return;
  const at = new Date(now).toISOString();
  save(
    db,
    orchestratorId,
    listGoals(db, orchestratorId).map((g) => {
      if (!goalIds.includes(g.id)) return g;
      const use = budgetUse(g, now);
      return {
        ...g,
        status: 'paused' as const,
        budgetReachedAt: at,
        updatedAt: at,
        progress: [
          ...g.progress,
          {
            at,
            note: `Budget reached (${use.checks} checks, ${use.days.toFixed(1)} days): the chat was asked for a closing report, and the goal now waits for you. Resume it to give it another budget window.`,
            by: 'system' as const,
          },
        ].slice(-KEEP_PROGRESS),
      };
    }),
  );
}

/** Active goals the automatic check should bring back now. */
export function goalsDue(goals: readonly OrchestratorGoal[], now: number): OrchestratorGoal[] {
  return goals.filter(
    (g) =>
      g.status === 'active' &&
      now - (g.lastNudgeAt ?? 0) >= (isQuiet(g) ? GOAL_QUIET_NUDGE_MS : GOAL_NUDGE_MS),
  );
}

/**
 * After a check that included the goal step: each active goal counts one more check without
 * progress (reset by update_goal or moving work). One that reaches the limit stays active and
 * gets one note (PM-459); returns the goals that just went quiet.
 */
export function noteGoalCheck(
  db: Db,
  orchestratorId: string,
  now: number,
  /**
   * Goals whose work moved since their last check (PM-456): a linked card changed, or a session
   * or run is working on one. They are not stalled, whether or not the chat wrote a note.
   */
  moved: ReadonlySet<number> = new Set(),
): OrchestratorGoal[] {
  const stalled: OrchestratorGoal[] = [];
  const at = new Date(now).toISOString();
  const goals = listGoals(db, orchestratorId).map((g) => {
    if (g.status !== 'active') return g;
    // Every goal-step check counts against the budget window, moving or not (PM-473).
    const checksUsed = (g.checksUsed ?? 0) + 1;
    if (moved.has(g.id)) return { ...g, lastNudgeAt: now, nudgesWithoutProgress: 0, checksUsed };
    const count = (g.nudgesWithoutProgress ?? 0) + 1;
    if (count !== GOAL_STALL_CHECKS)
      return { ...g, lastNudgeAt: now, nudgesWithoutProgress: count, checksUsed };
    const quiet: OrchestratorGoal = {
      ...g,
      checksUsed,
      updatedAt: at,
      lastNudgeAt: now,
      nudgesWithoutProgress: count,
      progress: [
        ...g.progress,
        {
          at,
          note: `No progress in ${count} automatic checks. It stays active; checks now come back to it hourly until something moves. Follow up, or tell the chat what it needs.`,
          by: 'system' as const,
        },
      ].slice(-KEEP_PROGRESS),
    };
    stalled.push(quiet);
    return quiet;
  });
  save(db, orchestratorId, goals);
  return stalled;
}
