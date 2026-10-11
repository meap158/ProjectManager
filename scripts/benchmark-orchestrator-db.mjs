import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { openDb } from '../server/db.ts';
import { planningRuns } from '../server/orchestrator/planningRuns.ts';
import { situationRunIds } from '../server/orchestrator/situationRuns.ts';
import { liveRunProjects } from '../server/orchestrator/liveProjects.ts';
const db = openDb(':memory:');
try {
  db.exec(`
    WITH RECURSIVE p(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM p WHERE id<20)
    INSERT INTO projects(id,name,path,created_at) SELECT id,'Project','/'||id,'2026-10-12' FROM p;
    WITH RECURSIVE c(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM c WHERE id<1000)
    INSERT INTO cards(id,project_id,title,status,position,created_at,updated_at)
      SELECT id,(id%20)+1,'Task','review',id,'2026-10-12','2026-10-12' FROM c;
    WITH RECURSIVE r(id) AS (SELECT 1 UNION ALL SELECT id+1 FROM r WHERE id<100000)
    INSERT INTO agent_runs(id,project_id,card_id,name,command_json,prompt,status,validation,created_at,log_path,changes_json)
      SELECT id,(id%20)+1,(id%1000)+1,'Worker','["command"]','Historical prompt',
        CASE WHEN id<=20 THEN 'running' ELSE 'succeeded' END,
        CASE WHEN id<=20 THEN NULL ELSE 'accepted' END,'2026-10-12','', '{"files":["file.ts"],"commits":1}' FROM r;
  `);
  const history = () =>
    db
      .prepare('SELECT * FROM agent_runs ORDER BY id DESC LIMIT 100000')
      .all()
      .map((row) => ({
        ...row,
        command: JSON.parse(row.command_json),
        changes: JSON.parse(row.changes_json),
      }));
  const measure = (fn) => {
    for (let i = 0; i < 2; i++) fn();
    const samples = [];
    let result;
    for (let i = 0; i < 10; i++) {
      const start = performance.now();
      result = fn();
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    return { p50Ms: +samples[5].toFixed(2), maxMs: +samples[9].toFixed(2), rows: result.length };
  };
  const before = {
    history: measure(history),
    planning: measure(() => planningRuns(db, [1])),
    situation: measure(() => situationRunIds(db, [1])),
    occupancy: measure(() => liveRunProjects(db)),
  };
  const expected = JSON.stringify([
    planningRuns(db, [1]),
    situationRunIds(db, [1]),
    liveRunProjects(db),
  ]);
  // Candidate indexes are isolated to this fixture; no migration or live database mutation.
  db.exec(`CREATE INDEX bench_live ON agent_runs(project_id,id) WHERE status IN ('running','queued');
    CREATE INDEX bench_review ON agent_runs(project_id,id) WHERE status IN ('succeeded','failed') AND validation IS NULL;
    CREATE INDEX bench_served ON agent_runs(project_id,id) WHERE card_id IS NOT NULL;`);
  assert.equal(
    JSON.stringify([planningRuns(db, [1]), situationRunIds(db, [1]), liveRunProjects(db)]),
    expected,
  );
  const indexed = {
    planning: measure(() => planningRuns(db, [1])),
    situation: measure(() => situationRunIds(db, [1])),
    occupancy: measure(() => liveRunProjects(db)),
  };
  const plans = [
    "SELECT DISTINCT project_id FROM agent_runs WHERE status IN ('running','queued')",
    "SELECT id FROM agent_runs WHERE status IN ('succeeded','failed') AND validation IS NULL AND project_id=1",
    'SELECT MAX(id) FROM agent_runs WHERE card_id IS NOT NULL AND project_id=1 GROUP BY project_id',
  ].map((sql) => ({ sql, plan: db.prepare('EXPLAIN QUERY PLAN ' + sql).all() }));
  console.log(
    JSON.stringify(
      {
        fixture: { runs: 100000, cards: 1000, projects: 20, scope: [1], warmups: 2, samples: 10 },
        before,
        indexed,
        plans,
      },
      null,
      2,
    ),
  );
} finally {
  db.close();
}
