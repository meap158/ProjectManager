import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { MIGRATIONS, openDb } from '../db.js';
import { reserveRunExecution } from './runExecution.js';

it('upgrades legacy runs without inventing execution ownership and persists replay identity', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-execution-'));
  try {
    const version = MIGRATIONS.findIndex((sql) =>
      sql.includes('CREATE TABLE agent_run_executions'),
    );
    expect(version).toBeGreaterThan(0);
    const old = new DatabaseSync(path.join(dir, 'projectmanager.db'));
    for (const sql of MIGRATIONS.slice(0, version)) old.exec(sql);
    old.exec(`PRAGMA user_version=${version};
      INSERT INTO projects(id,name,path,created_at) VALUES(1,'One','/one','now');
      INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path,dispatch_key,orchestrator_id)
      VALUES(1,1,'Run','{"command":["fixture"],"timeoutMs":60000}','queued','now','/first.log','dispatch','owner');`);
    old.close();
    let db = openDb(dir);
    let identity;
    try {
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_run_executions').get()).toMatchObject({
        n: 0,
      });
      identity = reserveRunExecution(
        db,
        1,
        { instance: 'host-one', generation: 4, attempt: 1 },
        1000,
      );
      expect(identity).toMatchObject({
        runId: 1,
        runLogPath: '/first.log',
        dispatchKey: 'dispatch',
        orchestratorId: 'owner',
        createdAt: 1000,
      });
      expect(identity.nonce).not.toBe('dispatch');
      expect(
        reserveRunExecution(db, 1, { instance: 'host-one', generation: 4, attempt: 1 }, 2000),
      ).toEqual(identity);
      expect(() =>
        reserveRunExecution(db, 1, { instance: 'other-host', generation: 4, attempt: 1 }),
      ).toThrow(/different launch/);
      db.prepare("UPDATE projects SET path='/changed' WHERE id=1").run();
      expect(() =>
        reserveRunExecution(db, 1, { instance: 'host-one', generation: 4, attempt: 1 }),
      ).toThrow(/different launch/);
      db.prepare("UPDATE projects SET path='/one' WHERE id=1").run();
    } finally {
      db.close();
    }
    db = openDb(dir);
    try {
      expect(
        reserveRunExecution(db, 1, { instance: 'host-one', generation: 4, attempt: 1 }),
      ).toEqual(identity);
      const secondAttempt = reserveRunExecution(db, 1, {
        instance: 'host-one',
        generation: 4,
        attempt: 2,
      });
      expect(secondAttempt.nonce).not.toBe(identity!.nonce);
      expect(secondAttempt.attempt).toBe(2);
      db.prepare('DELETE FROM agent_run_executions WHERE nonce=?').run(secondAttempt.nonce);
      db.prepare('DELETE FROM agent_runs WHERE id=1').run();
      expect(db.prepare('SELECT nonce,run_id FROM agent_run_executions').get()).toMatchObject({
        nonce: identity!.nonce,
        run_id: null,
      });
      db.exec(`INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path)
        VALUES(1,1,'New run','{"command":["fixture"]}','queued','now','/second.log');`);
      const next = reserveRunExecution(db, 1, { instance: 'host-one', generation: 4, attempt: 1 });
      expect(next.nonce).not.toBe(identity!.nonce);
      expect(db.prepare('SELECT COUNT(*) AS n FROM agent_run_executions').get()).toMatchObject({
        n: 2,
      });
    } finally {
      db.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
