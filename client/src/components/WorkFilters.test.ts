import { describe, expect, it, vi } from 'vitest';
import type { AgentRun, AgentSession } from '../../../shared/types';
import { workStatus, type WorkItem } from './AgentWorkList';
import { NO_FILTERS, applyWorkFilters, filtersActive, readWorkFilters } from './WorkFilters';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const session = (id: number, patch: Partial<AgentSession>): WorkItem => ({
  kind: 'session',
  item: {
    id,
    name: `s${id}`,
    projectId: 1,
    providerId: 'claude',
    status: 'running',
    tailState: null,
    lastOutputAt: new Date(NOW).toISOString(),
    cardKey: null,
    ...patch,
  } as AgentSession,
});
const run = (id: number, patch: Partial<AgentRun>): WorkItem => ({
  kind: 'run',
  item: {
    id,
    name: `r${id}`,
    projectId: 2,
    providerId: 'codex',
    status: 'succeeded',
    validation: null,
    cardKey: `PM-${id}`,
    ...patch,
  } as AgentRun,
});

const items = [
  session(1, {}), // running (fresh output)
  session(2, { tailState: 'idle' }), // idle
  session(3, { status: 'killed' }), // ended
  run(4, {}), // needs review
  run(5, { validation: 'accepted' }), // ended
  run(6, { status: 'running' }), // running
];

describe('work filters', () => {
  it('migrates saved input and review filters to attention while preserving other choices', () => {
    try {
      for (const status of ['input', 'review']) {
        vi.stubGlobal('localStorage', {
          getItem: () => JSON.stringify({ status, agent: 'codex', query: 'PM-4' }),
        });
        expect(readWorkFilters()).toEqual({
          ...NO_FILTERS,
          status: 'attention',
          agent: 'codex',
          query: 'PM-4',
        });
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('buckets every item by status, matching the row states', () => {
    expect(items.map((w) => workStatus(w, NOW))).toEqual([
      'running',
      'idle',
      'ended',
      'review',
      'ended',
      'running',
    ]);
  });

  it('combines status, agent, project, kind and search', () => {
    const ids = (f: Partial<typeof NO_FILTERS>) =>
      applyWorkFilters(items, { ...NO_FILTERS, ...f }, NOW).map((w) => w.item.id);
    expect(ids({ status: 'running' })).toEqual([1, 6]);
    expect(ids({ agent: 'codex' })).toEqual([4, 5, 6]);
    expect(ids({ project: 1, kind: 'session' })).toEqual([1, 2, 3]);
    expect(ids({ query: 'pm-4' })).toEqual([4]);
    expect(ids({ status: 'attention', agent: 'claude' })).toEqual([]);
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, query: ' x ' })).toBe(true);
  });
});

it('combines input and review under attention while keeping live waiting sessions under Running', () => {
  const waiting = session(7, { tailState: 'input' });
  const pool = [...items, waiting, session(8, { status: 'killed', tailState: 'input' })];
  const filtered = (status: 'running' | 'attention') =>
    applyWorkFilters(pool, { ...NO_FILTERS, status }, NOW).map((w) => w.item.id);
  expect(filtered('running')).toEqual([1, 6, 7]);
  expect(filtered('attention')).toEqual([4, 7]);
  expect(
    applyWorkFilters(pool, { ...NO_FILTERS, status: 'attention', kind: 'session' }, NOW).map(
      (w) => w.item.id,
    ),
  ).toEqual([7]);
  expect(
    applyWorkFilters(pool, { ...NO_FILTERS, status: 'attention', kind: 'run' }, NOW).map(
      (w) => w.item.id,
    ),
  ).toEqual([4]);
});
