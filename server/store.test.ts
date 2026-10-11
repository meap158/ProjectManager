import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDb } from './db.js';
import { getProject, insertProject, listProjects, insertCard, updateCard } from './store.js';

const idle = () => ({ status: 'idle' as const });

describe('project summaries', () => {
  it('count only the running agent sessions per project', () => {
    const db = openDb(':memory:');
    const a = insertProject(db, 'a', process.cwd());
    const b = insertProject(db, 'b', path.dirname(process.cwd()));
    const addSession = (projectId: number, status: string) =>
      db
        .prepare(
          `INSERT INTO agent_sessions (project_id, name, command_json, cwd, status, created_at, started_at, log_path)
           VALUES (?, 's', '[]', '.', ?, 'now', 'now', 'log')`,
        )
        .run(projectId, status);
    addSession(a, 'running');
    addSession(a, 'running');
    addSession(a, 'killed');
    addSession(b, 'exited');

    const byName = Object.fromEntries(listProjects(db, idle).map((p) => [p.name, p]));
    expect(byName.a!.runningSessions).toBe(2);
    expect(byName.b!.runningSessions).toBe(0);
    expect(getProject(db, a, idle())!.runningSessions).toBe(2);
  });
});

it('persists and clears an explicit issue link without losing it on board moves', () => {
  const db = openDb(':memory:');
  try {
    const project = insertProject(db, 'Linked', process.cwd());
    const card = insertCard(db, project, {
      title: 'Task',
      description: '',
      status: 'todo',
      issueUrl: 'https://github.com/me/app/issues/12',
    });
    expect(card.issueUrl).toBe('https://github.com/me/app/issues/12');
    expect(updateCard(db, card.id, { status: 'review' })?.issueUrl).toBe(card.issueUrl);
    expect(updateCard(db, card.id, { issueUrl: null })?.issueUrl).toBeNull();
  } finally {
    db.close();
  }
});
