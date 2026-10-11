// node --expose-gc --import tsx scripts/benchmark-orchestrator.mjs
// Pure planner benchmark. No database, provider subprocesses or workers are touched.
import { performance } from 'node:perf_hooks';
import { planOrchestration } from '../server/orchestrator/planner.ts';

const now = Date.now();
const policy = {
  projectIds: [],
  providers: ['codex'],
  maxWorkers: 4,
  maxWorkersPerProject: 1,
  maxWorkersPerProvider: 4,
  reservePercent: 10,
  allowUnknownQuota: false,
  quotaMaxAgeMs: 60000,
};
const rows = [];
for (const count of [1000, 10000]) {
  const cards = Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    projectId: (index % 20) + 1,
    position: Math.floor(index / 20),
    status: 'todo',
    createdAt: new Date(now).toISOString(),
  }));
  // Historical cards are separate from ready tasks, so the benchmark includes dispatch planning.
  const runs = Array.from({ length: 100000 }, (_, index) => ({
    id: index + 1,
    cardId: count + (index % 1000) + 1,
    projectId: (index % 20) + 1,
    providerId: 'codex',
    status: 'succeeded',
    validation: 'accepted',
  }));
  const snapshot = {
    cards,
    runs,
    sessions: [],
    availableProviders: ['codex'],
    limits: [
      { providerId: 'codex', asOf: new Date(now).toISOString(), windows: [{ usedPercent: 20 }] },
    ],
  };
  for (const masters of [1, 5, 20]) {
    for (let warmup = 0; warmup < 3; warmup++) planOrchestration(policy, snapshot, now);
    global.gc?.();
    const samples = [];
    let responseBytes = 0;
    for (let repeat = 0; repeat < 12; repeat++) {
      const start = performance.now();
      for (let master = 0; master < masters; master++) {
        const decisions = planOrchestration(policy, snapshot, now);
        if (decisions.filter((decision) => decision.action === 'dispatch').length !== 4)
          throw new Error('Capacity regression');
        if (repeat === 0 && master === 0)
          responseBytes = Buffer.byteLength(JSON.stringify(decisions));
      }
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    rows.push({
      cards: count,
      history: runs.length,
      masters,
      p50ms: Number(samples[6].toFixed(2)),
      p95ms: Number(samples[11].toFixed(2)),
      responseBytesPerMaster: responseBytes,
      rssMB: Number((process.memoryUsage().rss / 1048576).toFixed(1)),
    });
  }
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      measuredAt: new Date().toISOString(),
      scope:
        'Sequential pure planner batches; excludes SQL, quota IO, provider checks and transport',
      rows,
    },
    null,
    2,
  ),
);
