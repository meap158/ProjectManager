import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import {
  addGoal,
  GOAL_NUDGE_MS,
  GOAL_STALL_CHECKS,
  goalsDue,
  listGoals,
  MAX_ACTIVE_GOALS,
  noteGoalCheck,
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

  it('comes back every interval, and blocks a goal after checks without progress', () => {
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
    const [blocked] = noteGoalCheck(db, 'm', now + GOAL_STALL_CHECKS);
    expect(blocked?.status).toBe('blocked');
    expect(blocked?.progress.at(-1)?.by).toBe('system');
    expect(goalsDue(listGoals(db, 'm'), now + 10 * GOAL_NUDGE_MS)).toEqual([]);
  });
});
