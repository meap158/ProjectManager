import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import {
  addGoal,
  GOAL_NUDGE_MS,
  GOAL_STALL_CHECKS,
  GOAL_QUIET_NUDGE_MS,
  goalsDue,
  listGoals,
  MAX_ACTIVE_GOALS,
  noteBudgetReached,
  noteGoalCheck,
  overBudget,
  updateGoal,
} from './goals.js';

const databases: ReturnType<typeof openDb>[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const fresh = () => {
  const db = openDb(':memory:');
  databases.push(db);
  return db;
};
const goal = {
  title: 'Ship v1',
  objective: 'Release FrameMotion 1.0',
  doneWhen: 'v1.0 tag pushed',
};

describe('orchestrator goals (PM-433)', () => {
  it('limits active goals and records progress', () => {
    const db = fresh();
    for (let i = 0; i < MAX_ACTIVE_GOALS; i++) addGoal(db, 'm', goal);
    expect(() => addGoal(db, 'm', goal)).toThrow(/already active/);
    const g = updateGoal(db, 'm', 1, { note: 'Tag pushed', status: 'achieved', by: 'chat' });
    expect(g.status).toBe('achieved');
    expect(g.progress.at(-1)).toMatchObject({ note: 'Tag pushed', by: 'chat' });
    expect(addGoal(db, 'm', goal).id).toBe(MAX_ACTIVE_GOALS + 1);
    expect(() => updateGoal(db, 'm', 99, { note: 'x', by: 'chat' })).toThrow(/No goal 99/);
  });

  it('comes back every interval, and goes quiet (never blocked) after checks without progress (PM-459)', () => {
    const db = fresh();
    const now = Date.parse('2026-11-06T10:00:00Z');
    addGoal(db, 'm', goal);
    expect(goalsDue(listGoals(db, 'm'), now)).toHaveLength(1);
    noteGoalCheck(db, 'm', now);
    expect(goalsDue(listGoals(db, 'm'), now + GOAL_NUDGE_MS - 1)).toHaveLength(0);
    expect(goalsDue(listGoals(db, 'm'), now + GOAL_NUDGE_MS)).toHaveLength(1);
    // Progress resets the count.
    updateGoal(db, 'm', 1, { note: 'Opened PR #4', by: 'chat' });
    for (let i = 1; i < GOAL_STALL_CHECKS; i++) expect(noteGoalCheck(db, 'm', now + i)).toEqual([]);
    const [quiet] = noteGoalCheck(db, 'm', now + GOAL_STALL_CHECKS);
    expect(quiet?.status).toBe('active');
    expect(quiet?.progress.at(-1)?.note).toContain('stays active');
    // Checked hourly now, not every 15 minutes; the note is written once.
    expect(goalsDue(listGoals(db, 'm'), now + GOAL_STALL_CHECKS + GOAL_NUDGE_MS)).toEqual([]);
    expect(
      goalsDue(listGoals(db, 'm'), now + GOAL_STALL_CHECKS + GOAL_QUIET_NUDGE_MS),
    ).toHaveLength(1);
    expect(noteGoalCheck(db, 'm', now + GOAL_QUIET_NUDGE_MS * 2)).toEqual([]);
  });
});

describe('goal budgets (PM-473)', () => {
  it('counts checks per window, pauses at the limit, and opens a new window on resume', () => {
    const db = fresh();
    const start = new Date('2026-11-07T10:00:00Z');
    const now = start.getTime();
    addGoal(db, 'm', { ...goal, budget: { checks: 2 } }, start);
    expect(overBudget(listGoals(db, 'm')[0]!, now)).toBe(false);
    noteGoalCheck(db, 'm', now + 1);
    noteGoalCheck(db, 'm', now + 2);
    const spent = listGoals(db, 'm')[0]!;
    expect(spent.checksUsed).toBe(2);
    expect(overBudget(spent, now + 3)).toBe(true);
    noteBudgetReached(db, 'm', [spent.id], now + 3);
    const waiting = listGoals(db, 'm')[0]!;
    expect(waiting.status).toBe('paused');
    expect(waiting.budgetReachedAt).toBeTruthy();
    expect(waiting.progress.at(-1)!.note).toContain('Budget reached (2 checks');
    expect(overBudget(waiting, now + 4)).toBe(false); // reported once, then it waits
    updateGoal(db, 'm', spent.id, { status: 'active', by: 'owner' });
    const resumed = listGoals(db, 'm')[0]!;
    expect(resumed.checksUsed).toBe(0);
    expect(resumed.budgetReachedAt).toBeUndefined();
    expect(overBudget(resumed, now + 5)).toBe(false);
  });

  it('measures days from the window start, and ignores empty budgets', () => {
    const db = fresh();
    const start = new Date('2026-11-07T10:00:00Z');
    addGoal(db, 'm', { ...goal, budget: { days: 2 } }, start);
    addGoal(db, 'm', { ...goal, title: 'No limits', budget: {} }, start);
    const [limited, open] = listGoals(db, 'm');
    expect(open!.budget).toBeUndefined();
    expect(overBudget(limited!, start.getTime() + 47 * 3_600_000)).toBe(false);
    expect(overBudget(limited!, start.getTime() + 49 * 3_600_000)).toBe(true);
  });
});
