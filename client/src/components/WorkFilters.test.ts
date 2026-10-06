import { describe, expect, it } from 'vitest';
import type { AgentRun, AgentSession } from '../../../shared/types';
import { workStatus, type WorkItem } from './AgentWorkList';
import { NO_FILTERS, applyWorkFilters, filtersActive } from './WorkFilters';

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
    expect(ids({ status: 'review', agent: 'claude' })).toEqual([]);
    expect(filtersActive(NO_FILTERS)).toBe(false);
    expect(filtersActive({ ...NO_FILTERS, query: ' x ' })).toBe(true);
  });
});
