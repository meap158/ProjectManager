import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { ChatDispatchIntent } from './chatIntent.js';
import { OrchestratorAssignments } from './assignments.js';
it('reserves manual work and fences stale intent transitions and inserted work', () => {
  const db = openDb(':memory:');
  try {
    db.exec(
      "INSERT INTO projects(id,name,path,created_at) VALUES (1,'One','/one','2026-10-12'); INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at) VALUES(1,1,'Task','todo',0,'2026-10-12','2026-10-12');",
    );
    const intent = new ChatDispatchIntent(db, 1, 'master', 1000);
    expect(() => new ChatDispatchIntent(db, 1, 'other', 1001)).toThrow(/reserved/);
    expect(intent.heartbeat(100000)).toBe(true);
    new OrchestratorAssignments(db).reconcile(undefined, 130000);
    expect(intent.current()).toBe(true);
    expect(intent.assigned(99, 130001)).toBe(false);
    db.prepare(
      "INSERT INTO agent_runs(id,project_id,card_id,name,command_json,created_at,log_path,dispatch_key) VALUES(1,1,1,'Worker','[]','2026-10-12','',?)",
    ).run(intent.key);
    expect(intent.superseded(130002)).toBe(false);
    expect(intent.failed(130002)).toBe(false);
    new OrchestratorAssignments(db).reconcile(undefined, 130003);
    expect(intent.current()).toBe(false);
    expect(intent.superseded()).toBe(false);
    expect(intent.heartbeat()).toBe(false);
    expect(intent.failed()).toBe(false);
    expect(
      db.prepare('SELECT state,run_id FROM orchestrator_assignments WHERE card_id=1').get(),
    ).toMatchObject({ state: 'assigned', run_id: 1 });
  } finally {
    db.close();
  }
});

it('refunds a superseded intent once and fences a replacement owner', () => {
  const db = openDb(':memory:');
  try {
    db.exec(
      "INSERT INTO projects(id,name,path,created_at) VALUES (1,'One','/one','2026-10-12'); INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at) VALUES(1,1,'Task','todo',0,'2026-10-12','2026-10-12');",
    );
    const old = new ChatDispatchIntent(db, 1, 'old', 1000);
    expect(old.superseded(1001)).toBe(true);
    expect(old.superseded(1002)).toBe(false);
    const next = new ChatDispatchIntent(db, 1, 'next', 1003);
    expect(old.superseded(1004)).toBe(false);
    expect(next.current()).toBe(true);
    expect(
      db.prepare('SELECT attempts FROM orchestrator_assignments WHERE card_id=1').get(),
    ).toMatchObject({ attempts: 1 });
  } finally {
    db.close();
  }
});
