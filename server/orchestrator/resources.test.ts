import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { MIN_FREE_DISK_BYTES, MIN_FREE_MEMORY_BYTES, resourceBlock } from './resources.js';
import { planOrchestration } from './planner.js';

const GB = 1024 ** 3;
const probe = (disk: Record<string, number | null>, memory = 8 * GB) => {
  const asked: string[] = [];
  return {
    asked,
    freeDisk: (dir: string) => {
      asked.push(dir);
      return disk[dir] ?? 50 * GB;
    },
    freeMemory: () => memory,
  };
};
const root = (dir: string) => path.parse(path.resolve(dir)).root;

it('checks each drive once, including the temp folder, and passes with room', () => {
  const p = probe({});
  const a = path.resolve('/work/a');
  expect(resourceBlock([a, path.resolve('/work/b')], p)).toBeUndefined();
  expect(p.asked.sort()).toEqual([...new Set([root(a), root(os.tmpdir())])].sort());
});

it('names a drive below the disk floor', () => {
  const dir = path.resolve('/work/a');
  const block = resourceBlock([dir], probe({ [root(dir)]: MIN_FREE_DISK_BYTES - 1 }));
  expect(block).toMatch(
    /^Low disk space: .+ has 2\.0 GB free \(needs 2\.0 GB\); new workers wait$/,
  );
});

it('reports low memory, and ignores a drive it cannot read', () => {
  const dir = path.resolve('/work/a');
  expect(resourceBlock([dir], probe({ [root(dir)]: null }, MIN_FREE_MEMORY_BYTES - 1))).toMatch(
    /^Low memory: /,
  );
  expect(resourceBlock([dir], probe({ [root(dir)]: null }))).toBeUndefined();
});

it('makes the planner hold new workers, but not cards that only need review', () => {
  const card = (id: number, status: string) =>
    ({ id, projectId: 1, position: id, status, createdAt: new Date().toISOString() }) as never;
  const decisions = planOrchestration(
    {
      providers: ['codex'],
      projectIds: [1],
      maxWorkers: 4,
      maxWorkersPerProject: 2,
      maxWorkersPerProvider: 4,
      reservePercent: 10,
      allowUnknownQuota: true,
      quotaMaxAgeMs: 60_000,
    } as never,
    {
      cards: [card(1, 'todo'), card(2, 'review')],
      runs: [],
      sessions: [],
      availableProviders: ['codex'],
      limits: [],
      resourceBlock: 'Low disk space: D: has 0.5 GB free (needs 2.0 GB); new workers wait',
    },
  );
  expect(decisions.find((d) => d.cardId === 1)).toMatchObject({
    action: 'wait',
    waitReason: 'low_resources',
    reason: expect.stringContaining('Low disk space'),
  });
  expect(decisions.find((d) => d.cardId === 2)?.action).toBe('review');
});
