import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { OrchestratorAssignments } from './assignments.js';

it.each(['before-claim', 'after-claim', 'after-insertion'])(
  'recovers persisted chat dispatch after process exit %s',
  (boundary) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-orch-process-'));
    const source = `
      import { openDb } from './server/db.ts';
      import { ChatDispatchIntent } from './server/orchestrator/chatIntent.ts';
      const db = openDb(process.argv[1]);
      db.exec("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture','/fixture','2026-10-12'); INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at) VALUES(1,1,'Fixture task','todo',0,'2026-10-12','2026-10-12');");
      if(process.argv[2] === 'before-claim') process.exit(86);
      const intent = new ChatDispatchIntent(db, 1, 'fixture-master', 1000);
      if(process.argv[2] === 'after-insertion') {
        db.prepare("INSERT INTO agent_runs(id,project_id,card_id,name,provider_id,command_json,status,created_at,log_path,dispatch_key) VALUES(1,1,1,'Fixture worker','codex','[]','queued','2026-10-12','',?)").run(intent.key);
      }
      // Deliberately skip acknowledgement and db.close(): exercise persisted process boundaries.
      process.exit(86);
    `;
    try {
      const child = spawnSync(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '--eval', source, dir, boundary],
        {
          cwd: path.resolve('.'),
          encoding: 'utf8',
          timeout: 15000,
          windowsHide: true,
        },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(86);
      const db = openDb(dir);
      try {
        const assignments = new OrchestratorAssignments(db);
        assignments.reconcile(undefined, 130001);
        const state = db
          .prepare(
            'SELECT state,attempts,run_id,retry_after FROM orchestrator_assignments WHERE card_id=1',
          )
          .get();
        if (boundary === 'before-claim') {
          expect(state).toBeUndefined();
          expect(assignments.claim(1, 'recovery', 130001)).toBe(true);
        } else if (boundary === 'after-claim') {
          expect(state).toMatchObject({
            state: 'error',
            attempts: 1,
            run_id: null,
            retry_after: 430001,
          });
          expect(assignments.claim(1, 'recovery', 130002)).toBe(false);
        } else {
          expect(state).toMatchObject({ state: 'assigned', attempts: 1, run_id: 1 });
          expect(assignments.claim(1, 'recovery', 130002)).toBe(false);
          assignments.reconcile(undefined, 140000);
          expect(db.prepare('SELECT COUNT(*) AS count FROM agent_runs').get()).toMatchObject({
            count: 1,
          });
          expect(
            db.prepare('SELECT state,run_id FROM orchestrator_assignments WHERE card_id=1').get(),
          ).toMatchObject({ state: 'assigned', run_id: 1 });
        }
      } finally {
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20000,
);
