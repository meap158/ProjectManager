import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Hono } from 'hono';
import { openDb } from '../server/db.ts';
import { AgentSupervisor } from '../server/agents/supervisor.ts';
import { OrchestratorService } from '../server/orchestrator/service.ts';
import { registerOrchestratorRoutes } from '../server/orchestrator/routes.ts';
import { buildSituation } from '../server/orchestrator/situation.ts';
import { situationRunIds } from '../server/orchestrator/situationRuns.ts';
import { listCardsInFlight } from '../server/store.ts';

const numbers = (name, fallback) =>
  (process.argv.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1] ?? fallback)
    .split(',')
    .map(Number);
const cardCounts = numbers('cards', '1000,10000');
const masterCounts = numbers('masters', '1,5,20');
const samples = numbers('samples', '5')[0];
assert(cardCounts.every((n) => Number.isInteger(n) && n > 0));
assert(masterCounts.every((n) => Number.isInteger(n) && n > 0 && n <= 20));
assert(Number.isInteger(samples) && samples >= 2);
const results = [];
for (const cards of cardCounts) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-orch-api-bench-'));
  const db = openDb(':memory:');
  try {
    // Construct against an empty isolated database, then stop every supervisor timer before seeding.
    const supervisor = new AgentSupervisor(db, path.join(dir, 'logs'));
    await supervisor.ready;
    await supervisor.shutdown();
    db.exec(`
      WITH RECURSIVE p(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM p WHERE id<20)
      INSERT INTO projects(id,name,path,created_at) SELECT id,'Project '||id,'/fixture/'||id,'2026-10-12' FROM p;
      WITH RECURSIVE c(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM c WHERE id<${cards})
      INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at)
        SELECT id,((id-1)%20)+1,'Review task','review',id,'2026-10-12','2026-10-12' FROM c;
      WITH RECURSIVE r(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM r WHERE id<100000)
      INSERT INTO agent_runs(id,project_id,card_id,name,provider_id,command_json,status,validation,created_at,log_path,changes_json)
        SELECT id,((id-1)%${cards}%20)+1,((id-1)%${cards})+1,'Worker','codex','{"command":[]}',
          CASE WHEN id<=20 THEN 'running' ELSE 'succeeded' END,
          CASE WHEN id>100000-${cards} THEN NULL ELSE 'accepted' END,
          '2026-10-12','','{"files":["file.ts"],"commits":1}' FROM r;
    `);
    const service = new OrchestratorService(db, supervisor, dir);
    const app = new Hono();
    registerOrchestratorRoutes(app, service);
    for (const scope of ['project', 'global']) {
      for (const masters of masterCounts) {
        const ids = Array.from(
          { length: masters },
          (_, index) =>
            service.save({
              name: `Benchmark ${scope} ${index}`,
              enabled: false,
              strategy: 'observe',
              projectIds: scope === 'project' ? [index + 1] : [],
              providers: ['codex'],
              maxWorkers: 2,
              maxWorkersPerProject: 2,
              maxWorkersPerProvider: 2,
              reservePercent: 10,
              allowUnknownQuota: true,
              quotaMaxAgeMs: 60000,
            }).id,
        );
        const state = service.state().instances.find((item) => item.id === ids[0]);
        const expected = buildSituation({
          projects: [],
          cards: listCardsInFlight(db),
          sessions: supervisor.listAllSessions(),
          runs: situationRunIds(db, state.projectIds).map((id) => supervisor.getRun(id)),
          projectIds: state.projectIds,
        });
        const actual = service.situation(ids[0]);
        delete expected.generatedAt;
        delete actual.generatedAt;
        assert.deepEqual(actual, expected, 'Projected inspection changed visible data');
        const pending = service.pending(ids[0]);
        assert.equal(pending.total, expected.needsAttention.length);
        assert.deepEqual(
          pending.items,
          expected.needsAttention.slice(0, 20),
          'Pending inspection changed visible data',
        );
        for (const operation of ['preview', 'situation', 'pending']) {
          const run = async () => {
            let bytes = 0;
            for (const id of ids) {
              const response = await app.request(`/orchestrators/${id}/${operation}`);
              assert.equal(response.status, 200);
              const body = await response.text();
              const data = JSON.parse(body);
              assert(
                operation === 'preview'
                  ? data.decisions.length <= 100
                  : operation === 'pending'
                    ? data.items.length <= 20
                    : Array.isArray(data.needsAttention),
              );
              bytes += Buffer.byteLength(body);
            }
            return bytes;
          };
          await run(); // Warm provider discovery, quota cache, SQLite and serialization.
          const before = db.prepare('SELECT total_changes() AS count').get().count;
          const times = [];
          let bytes;
          for (let sample = 0; sample < samples; sample++) {
            const start = performance.now();
            bytes = await run();
            times.push(performance.now() - start);
          }
          assert.equal(
            db.prepare('SELECT total_changes() AS count').get().count,
            before,
            'Read-only request wrote to fixture',
          );
          times.sort((a, b) => a - b);
          results.push({
            cards,
            history: 100000,
            masters,
            scope,
            operation,
            samples,
            p50Ms: +times[Math.floor(times.length / 2)].toFixed(2),
            maxMs: +times.at(-1).toFixed(2),
            bytesPerMaster: Math.round(bytes / masters),
            rssMB: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
          });
        }
        for (const id of ids) service.delete(id);
      }
    }
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      scope:
        'In-process Hono read routes, SQL, production run projection and JSON; warm local provider/quota caches. No worker launches, live database writes, network or browser.',
      results,
    },
    null,
    2,
  ),
);
