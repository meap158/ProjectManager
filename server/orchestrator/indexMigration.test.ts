import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { MIGRATIONS, openDb } from '../db.js';
it('upgrades existing run history and uses live/review partial indexes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-index-upgrade-'));
  try {
    const version = MIGRATIONS.findIndex((sql) =>
      sql.includes('CREATE INDEX agent_runs_live_projects'),
    );
    expect(version).toBeGreaterThan(0);
    const old = new DatabaseSync(path.join(dir, 'projectmanager.db'));
    for (const sql of MIGRATIONS.slice(0, version)) old.exec(sql);
    old.exec(`PRAGMA user_version = ${version}`);
    old.exec(
      "INSERT INTO projects(id,name,path,created_at) VALUES (1,'One','/one','2026-10-12'); INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path) VALUES (1,1,'Worker','[]','running','2026-10-12','');",
    );
    old.exec(
      "INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at) VALUES (1,1,'Task','todo',0,'2026-10-12','2026-10-12'); INSERT INTO orchestrator_assignments(card_id,orchestrator_id,state,run_id,updated_at) VALUES (1,'owner','assigned',1,1000);",
    );
    old.close();
    const db = openDb(dir);
    try {
      expect(db.prepare('SELECT name,status FROM agent_runs WHERE id=1').get()).toMatchObject({
        name: 'Worker',
        status: 'running',
      });
      expect(db.prepare('SELECT orchestrator_id FROM agent_runs WHERE id=1').get()).toMatchObject({
        orchestrator_id: 'owner',
      });
      const plans = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT DISTINCT project_id FROM agent_runs WHERE status IN ('running', 'queued')",
        )
        .all();
      expect(JSON.stringify(plans)).toContain('agent_runs_live_projects');
      const review = db
        .prepare(
          "EXPLAIN QUERY PLAN SELECT id FROM agent_runs WHERE status IN ('succeeded', 'failed') AND validation IS NULL AND project_id=1",
        )
        .all();
      expect(JSON.stringify(review)).toContain('agent_runs_pending_review');
    } finally {
      db.close();
    }
    openDb(dir).close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
