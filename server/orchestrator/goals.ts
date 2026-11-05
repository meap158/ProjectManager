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

import type { GoalProgress, GoalStatus, OrchestratorGoal } from '../../shared/orchestrator.js';

export type { GoalProgress, GoalStatus, OrchestratorGoal };

/** Active goals one orchestrator may hold at once. */
export const MAX_ACTIVE_GOALS = 5;
/** How often an active goal is brought back to the chat when nothing else asks for a check. */
export const GOAL_NUDGE_MS = 15 * 60_000;
/** Checks without reported progress before a goal is set to blocked. */
export const GOAL_STALL_CHECKS = 4;
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
  input: { title: string; objective: string; doneWhen: string },
  now = new Date(),
): OrchestratorGoal {
  const goals = listGoals(db, orchestratorId);
  if (goals.filter((g) => g.status === 'active').length >= MAX_ACTIVE_GOALS)
    throw new Error(
      `${MAX_ACTIVE_GOALS} goals are already active; finish, pause or drop one first`,
    );
  const at = now.toISOString();
  const goal: OrchestratorGoal = {
    id: Math.max(0, ...goals.map((g) => g.id)) + 1,
    ...input,
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
  change: { note?: string; status?: GoalStatus; by: GoalProgress['by'] },
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
  const next: OrchestratorGoal = {
    ...goal,
    ...(change.status ? { status: change.status } : {}),
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

/** Active goals the automatic check should bring back now. */
export function goalsDue(goals: readonly OrchestratorGoal[], now: number): OrchestratorGoal[] {
  return goals.filter((g) => g.status === 'active' && now - (g.lastNudgeAt ?? 0) >= GOAL_NUDGE_MS);
}

/**
 * After a check that included the goal step: each active goal counts one more check without
 * progress (reset by update_goal), and one that reached the stall limit is set to blocked.
 * Returns the goals it blocked.
 */
export function noteGoalCheck(db: Db, orchestratorId: string, now: number): OrchestratorGoal[] {
  const stalled: OrchestratorGoal[] = [];
  const at = new Date(now).toISOString();
  const goals = listGoals(db, orchestratorId).map((g) => {
    if (g.status !== 'active') return g;
    const count = (g.nudgesWithoutProgress ?? 0) + 1;
    if (count < GOAL_STALL_CHECKS) return { ...g, lastNudgeAt: now, nudgesWithoutProgress: count };
    const blocked: OrchestratorGoal = {
      ...g,
      status: 'blocked',
      updatedAt: at,
      lastNudgeAt: now,
      nudgesWithoutProgress: count,
      progress: [
        ...g.progress,
        {
          at,
          note: `No progress reported after ${count} automatic checks; set to blocked. Resume it once the way forward is clear.`,
          by: 'system' as const,
        },
      ].slice(-KEEP_PROGRESS),
    };
    stalled.push(blocked);
    return blocked;
  });
  save(db, orchestratorId, goals);
  return stalled;
}
