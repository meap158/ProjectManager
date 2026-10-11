// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRun, AgentSession } from '../../../shared/types';
import type { WorkItem } from './AgentWorkList';
import { DEFAULT_WORK_SORT, WorkSorter, sortWork, type WorkSort } from './WorkSorter';

afterEach(cleanup);

const session = (id: number, name: string, extra: Partial<AgentSession> = {}): WorkItem => ({
  kind: 'session',
  item: {
    id,
    name,
    projectId: id,
    status: 'running',
    tailState: 'idle',
    createdAt: '2026-10-01T00:00:00Z',
    startedAt: '2026-10-01T00:00:00Z',
    lastInputAt: null,
    lastOutputAt: null,
    ...extra,
  } as AgentSession,
});
const run = (id: number, name: string, extra: Partial<AgentRun> = {}): WorkItem => ({
  kind: 'run',
  item: {
    id,
    name,
    projectId: id,
    status: 'succeeded',
    validation: null,
    createdAt: '2026-10-02T00:00:00Z',
    startedAt: null,
    endedAt: null,
    ...extra,
  } as AgentRun,
});
const names = (items: WorkItem[]) => items.map((w) => w.item.name);

describe('sortWork (PM-94)', () => {
  const items = [
    session(1, 'old', { lastInputAt: '2026-10-03T00:00:00Z' }),
    session(2, 'latest', { lastInputAt: '2026-10-05T00:00:00Z' }),
    session(3, 'never messaged'), // Falls back to when it was created.
    run(4, 'dispatched'), // A run's message is its dispatch.
    session(5, 'asking', { tailState: 'input', lastInputAt: '2026-09-01T00:00:00Z' }),
  ];

  it('defaults to the most recent message from you, newest first', () => {
    expect(names(sortWork(items, DEFAULT_WORK_SORT))).toEqual([
      'latest',
      'old',
      'dispatched',
      'never messaged',
      'asking',
    ]);
    expect(names(sortWork(items, { mode: 'message', direction: 'asc' }))[0]).toBe('asking');
  });

  it('puts what needs you first, then live work', () => {
    const sorted = names(sortWork(items, { mode: 'attention', direction: 'desc' }));
    expect(sorted.slice(0, 2).sort()).toEqual(['asking', 'dispatched']);
  });

  it('sorts by name and by project name', () => {
    expect(names(sortWork(items, { mode: 'name', direction: 'asc' }))[0]).toBe('asking');
    const projects = new Map([
      [1, 'Zeta'],
      [2, 'Alpha'],
      [3, 'Mid'],
      [4, 'Beta'],
      [5, 'Omega'],
    ]);
    expect(names(sortWork(items, { mode: 'project', direction: 'asc' }, projects))[0]).toBe(
      'latest',
    );
    expect(names(sortWork(items, { mode: 'project', direction: 'desc' }, projects))[0]).toBe('old');
  });
});

describe('WorkSorter (PM-94)', () => {
  it('reverses the active order on a second pick and starts others at their natural order', () => {
    let sort: WorkSort = DEFAULT_WORK_SORT;
    const view = render(<WorkSorter sort={sort} onChange={(next) => (sort = next)} />);
    const open = () => fireEvent.click(screen.getByRole('button', { name: /^Sort:/ }));
    open();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Recent message/ }));
    expect(sort).toEqual({ mode: 'message', direction: 'asc' });
    view.rerender(<WorkSorter sort={sort} onChange={(next) => (sort = next)} />);
    expect(screen.getByRole('button', { name: 'Sort: Oldest message' })).toBeDefined();
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Name A–Z/ }));
    expect(sort).toEqual({ mode: 'name', direction: 'asc' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
