import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { openDb } from '../db.js';
import { OrchestratorAssignments } from './assignments.js';
import { ChatDispatchIntent } from './chatIntent.js';
import { AgentSupervisor } from '../agents/supervisor.js';

it.each(['before-claim', 'after-claim', 'after-insertion', 'after-acknowledgement'])(
  'recovers persisted chat dispatch after process exit %s',
  (boundary) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-orch-process-'));
    const source = `
      import { openDb } from ${JSON.stringify(new URL('../db.ts', import.meta.url).href)};
      import { ChatDispatchIntent } from ${JSON.stringify(new URL('./chatIntent.ts', import.meta.url).href)};
      const db = openDb(process.argv[1]);
      db.exec("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture','/fixture','2026-10-12'); INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at) VALUES(1,1,'Fixture task','todo',0,'2026-10-12','2026-10-12');");
      if(process.argv[2] === 'before-claim') process.exit(86);
      const intent = new ChatDispatchIntent(db, 1, 'fixture-master', 1000, {id:'fixture-request', fingerprint:'fixture-args', revision:'fixture-revision'});
      if(process.argv[2] === 'after-insertion' || process.argv[2] === 'after-acknowledgement') {
        db.prepare("INSERT INTO agent_runs(id,project_id,card_id,name,provider_id,command_json,status,created_at,log_path,dispatch_key) VALUES(1,1,1,'Fixture worker','codex','[]','queued','2026-10-12','',?)").run(intent.key);
      }
      if(process.argv[2] === 'after-acknowledgement') intent.assigned(1, 1001);
      // Deliberately skip normal shutdown and, where applicable, acknowledgement and db.close(): exercise persisted process boundaries.
      process.exit(86);
    `;
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '--eval',
          source,
          dir,
          boundary,
        ],
        {
          cwd: dir,
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
        const replay = ChatDispatchIntent.replay(
          db,
          'fixture-master',
          'fixture-request',
          'fixture-args',
        );
        if (boundary === 'before-claim') {
          expect(replay).toBeNull();
          expect(state).toBeUndefined();
          expect(assignments.claim(1, 'recovery', 130001)).toBe(true);
        } else if (boundary === 'after-claim') {
          expect(replay).toMatchObject({ status: 'interrupted', runId: null });
          expect(state).toMatchObject({
            state: 'error',
            attempts: 1,
            run_id: null,
            retry_after: 430001,
          });
          expect(assignments.claim(1, 'recovery', 130002)).toBe(false);
        } else {
          expect(replay).toMatchObject({
            status: 'queued',
            runId: 1,
            cardRevision: 'fixture-revision',
          });
          expect(() =>
            ChatDispatchIntent.replay(db, 'fixture-master', 'fixture-request', 'different'),
          ).toThrow(/different dispatch arguments/);
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

it.each(['before-worker-launch', 'after-worker-completion'])(
  'recovers a real supervisor dispatch after process exit %s without duplicate work',
  async (boundary) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-orch-supervisor-process-'));
    const marker = path.join(dir, 'worker-launches.txt');
    const command = [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'launched\\n')`,
    ];
    const source = `
      import { openDb } from ${JSON.stringify(new URL('../db.ts', import.meta.url).href)};
      import { AgentSupervisor } from ${JSON.stringify(new URL('../agents/supervisor.ts', import.meta.url).href)};
      import { ChatDispatchIntent } from ${JSON.stringify(new URL('./chatIntent.ts', import.meta.url).href)};
      const dir = process.argv[1];
      const db = openDb(dir);
      const supervisor = new AgentSupervisor(db, dir + '/logs');
      await supervisor.ready;
      db.prepare("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture',?,'now')").run(dir);
      db.exec("INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at) VALUES(1,1,'Fixture task','todo',0,'now','now')");
      const intent = new ChatDispatchIntent(db,1,'fixture-master',Date.now(),{ id:'real-request', fingerprint:'real-args', revision:'real-revision' });
      // Exit at the supervisor's actual launch call, after its production insertion/card update.
      if (process.argv[2] === 'before-worker-launch') supervisor.spawnRun = () => process.exit(86);
      const run = await supervisor.dispatchCard(1,1,{ command:${JSON.stringify(command)}, maxAttempts:1, dispatchKey:intent.key, orchestratorId:'fixture-master' });
      const deadline = Date.now()+10000;
      while(supervisor.getRun(run.id)?.status !== 'succeeded') {
        if(Date.now()>deadline) throw new Error('Fake worker did not complete');
        await new Promise(resolve => setTimeout(resolve,20));
      }
      // Leave the assignment unacknowledged despite actual worker completion.
      process.exit(86);
    `;
    let supervisor: AgentSupervisor | undefined;
    const dbPath = dir;
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--import',
          import.meta.resolve('tsx'),
          '--input-type=module',
          '--eval',
          source,
          dir,
          boundary,
        ],
        { cwd: dir, encoding: 'utf8', timeout: 20000, windowsHide: true },
      );
      expect(child.error, child.stderr).toBeUndefined();
      expect(child.status, child.stderr).toBe(86);
      const db = openDb(dbPath);
      try {
        expect(db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get()).toMatchObject({ n: 1 });
        supervisor = new AgentSupervisor(db, path.join(dir, 'recovery-logs'));
        await supervisor.ready;
        await expect
          .poll(() => supervisor!.getRun(1)?.status, { timeout: 10000 })
          .toBe('succeeded');
        const assignments = new OrchestratorAssignments(db);
        assignments.reconcile();
        expect(
          ChatDispatchIntent.replay(db, 'fixture-master', 'real-request', 'real-args'),
        ).toMatchObject({ runId: 1, status: 'succeeded' });
        expect(
          db
            .prepare('SELECT state,attempts,run_id FROM orchestrator_assignments WHERE card_id=1')
            .get(),
        ).toMatchObject({ state: 'assigned', attempts: 1, run_id: 1 });
        expect(db.prepare('SELECT COUNT(*) AS n FROM agent_runs').get()).toMatchObject({ n: 1 });
        expect(readFileSync(marker, 'utf8')).toBe('launched\n');
        expect(assignments.claim(1, 'duplicate')).toBe(false);
      } finally {
        await supervisor?.shutdown();
        db.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
  30000,
);
