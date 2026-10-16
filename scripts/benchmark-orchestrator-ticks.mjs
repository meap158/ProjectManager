import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { openDb } from '../server/db.ts';
import { AgentSupervisor } from '../server/agents/supervisor.ts';
import { OrchestratorService } from '../server/orchestrator/service.ts';

const samples = Number(process.argv.find((a) => a.startsWith('--samples='))?.split('=')[1] ?? 20);
assert(Number.isSafeInteger(samples) && samples >= 2 && samples <= 100);
const results = [];
for (const cards of [1000, 10000])
  for (const masters of [1, 5, 20]) {
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-tick-bench-'));
    const db = openDb(path.join(dir, 'db'));
    const supervisor = new AgentSupervisor(db, path.join(dir, 'logs'));
    await supervisor.ready;
    await supervisor.shutdown();
    let launches = 0;
    // Explicit measurement seam: preserve production validation/insertion/mapping,
    // replace OS execution only. The service itself still executes complete ticks.
    supervisor.spawnRun = async () => {
      launches++;
    };
    try {
      db.exec(`WITH RECURSIVE p(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM p WHERE id<20)
      INSERT INTO projects(id,name,path,created_at) SELECT id,'Fixture '||id,'/fixture/'||id,'now' FROM p;
      WITH RECURSIVE c(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM c WHERE id<${cards})
      INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at)
      SELECT id,((id-1)%20)+1,'Task','todo',id,'now','now' FROM c;
      WITH RECURSIVE r(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM r WHERE id<100000)
      INSERT INTO agent_runs(id,project_id,name,command_json,status,validation,created_at,log_path)
      SELECT id,((id-1)%20)+1,'History','{"command":[]}','succeeded','accepted','now','' FROM r;`);
      const prepare = db.prepare.bind(db);
      let statements = 0;
      db.prepare = (...args) => {
        statements++;
        return prepare(...args);
      };
      const changes = () => Number(prepare('SELECT total_changes() AS n').get().n);
      const times = [];
      const writes = [];
      const preparations = [];
      for (let sample = -1; sample < samples; sample++) {
        db.exec('BEGIN');
        try {
          const dispatch = supervisor.dispatchCard.bind(supervisor);
          // Use production dispatch validation/insertion with an inert custom command;
          // provider discovery and quota reads still use production implementations.
          const workerBoundary = {
            listAllSessions: () => [],
            sessionScreen: () => null,
            dispatchCard: (projectId, cardId, input) =>
              dispatch(projectId, cardId, {
                ...input,
                providerId: 'custom',
                command: [process.execPath, '-e', 'process.exit(0)'],
              }),
          };
          const service = new OrchestratorService(db, workerBoundary, dir);
          for (let index = 0; index < masters; index++)
            service.save({
              name: 'Fixture ' + index,
              enabled: true,
              strategy: 'dispatch',
              projectIds: [index + 1],
              providers: ['custom'],
              maxWorkers: 1,
              maxWorkersPerProject: 1,
              maxWorkersPerProvider: 32,
              reservePercent: 10,
              allowUnknownQuota: true,
              quotaMaxAgeMs: 60000,
              followDashboardAttention: false,
              pruneDashboardAttention: false,
            });
          const before = changes(),
            sqlBefore = statements,
            launchedBefore = launches;
          const start = performance.now();
          await service.tick();
          await service.stop();
          const elapsed = performance.now() - start;
          const mutations = changes() - before;
          const prepared = statements - sqlBefore;
          assert.equal(launches - launchedBefore, masters);
          assert.equal(
            Number(prepare("SELECT COUNT(*) AS n FROM cards WHERE status='in_progress'").get().n),
            masters,
          );
          if (sample >= 0) {
            times.push(elapsed);
            writes.push(mutations);
            preparations.push(prepared);
          }
        } finally {
          db.exec('ROLLBACK');
        }
      }
      times.sort((a, b) => a - b);
      assert(writes.every((n) => n === writes[0]));
      assert(preparations.every((n) => n === preparations[0]));
      results.push({
        cards,
        history: 100000,
        masters,
        samples,
        p50Ms: +times[Math.floor(samples / 2)].toFixed(2),
        p95Ms: +times[Math.ceil(samples * 0.95) - 1].toFixed(2),
        maxMs: +times.at(-1).toFixed(2),
        rowMutationsPerBatch: writes[0],
        preparedStatementsPerBatch: preparations[0],
        rssMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
      });
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
console.log(
  JSON.stringify(
    {
      scope:
        'Complete production service ticks with planning, leases, assignment writes, quota reads and dispatch insertion. Custom command injected; OS launch replaced. Isolated file-backed DB rollback per sample excludes commit fsync, provider execution, network and browser. Warm provider discovery; RSS is whole process.',
      results,
    },
    null,
    2,
  ),
);
