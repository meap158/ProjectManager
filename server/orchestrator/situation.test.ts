import { describe, expect, it } from 'vitest';
import type {
  AgentRun,
  AgentSession,
  CardWithProject,
  ProjectSummary,
} from '../../shared/types.js';
import { STALLED_MS, buildSituation, cardContext } from './situation.js';

// The orchestrator's view of Home (PM-70): what needs attention and what's being worked on, with
// the identity to trace each item back.

const NOW = Date.parse('2026-10-11T12:00:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const project = (id: number, name: string, git: Partial<ProjectSummary['git']> = {}) =>
  ({
    id,
    name,
    path: `/code/${name}`,
    missing: false,
    scan: { status: 'idle', error: null },
    git: {
      isRepo: true,
      lastCommitAt: ago(3_600_000),
      dirtyFiles: 0,
      ahead: 0,
      branch: 'main',
      ...git,
    },
  }) as unknown as ProjectSummary;

const card = (id: number, projectId: number, status: string, updatedAgo: number, extra = {}) =>
  ({
    id,
    projectId,
    projectName: projectId === 1 ? 'web' : 'api',
    key: `PM-${id}`,
    title: `Card ${id}`,
    description: `Do thing ${id}`,
    status,
    updatedAt: ago(updatedAgo),
    linkedCommit: null,
    ...extra,
  }) as unknown as CardWithProject;

const session = (id: number, projectId: number, cardId: number | null, tailState: string) =>
  ({
    id,
    projectId,
    name: `S${id}`,
    providerId: 'claude',
    status: 'running',
    tailState,
    cardId,
    cardKey: cardId ? `PM-${cardId}` : null,
    lastOutputAt: ago(5_000),
  }) as unknown as AgentSession;

const run = (id: number, projectId: number, cardId: number, status: string, validation = null) =>
  ({
    id,
    projectId,
    cardId,
    name: `Run ${id}`,
    providerId: 'codex',
    status,
    validation,
    changes: { files: ['a.ts', 'b.ts'], commits: 1 },
    endedAt: status === 'running' ? null : ago(60_000),
  }) as unknown as AgentRun;

const input = () => ({
  projects: [project(1, 'web', { dirtyFiles: 3 }), project(2, 'api')],
  cards: [
    card(10, 1, 'in_progress', 600_000),
    card(11, 1, 'review', 600_000, { linkedCommit: 'PR #7' }),
    card(12, 2, 'in_progress', STALLED_MS + 60_000),
  ],
  sessions: [session(5, 1, 10, 'input'), session(6, 2, null, 'running')],
  runs: [run(20, 1, 11, 'succeeded'), run(21, 1, 10, 'running')],
  screen: (id: number) => (id === 5 ? 'Do you want to make this edit?\n❯ 1. Yes\n  2. No' : null),
  now: NOW,
});

describe('buildSituation', () => {
  it("lists Home's attention with trace-back identity", () => {
    const s = buildSituation(input());
    const kinds = s.needsAttention.map((i) => [i.kind, i.cardKey ?? i.projectName]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['project-alert', 'web'], // 3 uncommitted files
        ['needs-input', 'PM-10'],
        ['awaiting-review', 'PM-11'],
        ['stalled', 'PM-12'],
      ]),
    );
    const asking = s.needsAttention.find((i) => i.kind === 'needs-input')!;
    expect(asking).toMatchObject({ sessionId: 5, cardId: 10 });
    expect(asking.detail).toContain('Do you want to make this edit?');
    expect(s.needsAttention.find((i) => i.kind === 'awaiting-review')).toMatchObject({
      runId: 20,
      cardId: 11,
    });
  });

  it('describes what is being worked on: workers, latest run, what moved it, flags', () => {
    const s = buildSituation(input());
    const c10 = s.beingWorkedOn.find((c) => c.cardId === 10)!;
    expect(c10.workers.map((w) => [w.kind, w.id, w.state])).toEqual([
      ['session', 5, 'input'],
      ['run', 21, 'running'],
    ]);
    expect(c10.flags).toEqual(['needs-input']);
    const c11 = s.beingWorkedOn.find((c) => c.cardId === 11)!;
    expect(c11).toMatchObject({ movedBy: 'PR #7', flags: ['awaiting-review'] });
    expect(c11.latestRun).toMatchObject({ id: 20, status: 'succeeded', filesChanged: 2 });
  });

  it("keeps to one master's projects and honours dismissed alerts", () => {
    const s = buildSituation({ ...input(), projectIds: [2], dismissed: () => ['Uncommitted'] });
    expect(s.needsAttention.every((i) => i.projectId === 2)).toBe(true);
    expect(s.beingWorkedOn.map((c) => c.cardId)).toEqual([12]);
    const all = buildSituation({ ...input(), dismissed: () => ['Uncommitted'] });
    expect(all.needsAttention.some((i) => i.kind === 'project-alert')).toBe(false);
  });
});

describe('cardContext (worker prompt)', () => {
  it("gives a worker the card's slice of Home, including its project's alerts", () => {
    const text = cardContext(buildSituation(input()), 10);
    expect(text).toContain('Board status: In progress');
    expect(text).toContain('Live session 5');
    expect(text).toContain('Latest run 21');
    expect(text).toContain('needs-input');
    expect(text).toContain('Uncommitted: web'); // The project's own alert.
  });

  it('includes project alerts for a new Todo task without leaking another project', () => {
    const situation = buildSituation({ ...input(), cards: [], sessions: [], runs: [] });
    const context = cardContext(situation, 999, 1);
    expect(context).toContain('Uncommitted: web');
    expect(context).not.toContain('Live session');
    expect(cardContext(situation, 999, 2)).toBe('');
  });

  it('is empty for a card Home says nothing about', () => {
    expect(cardContext(buildSituation({ ...input(), projects: [] }), 999)).toBe('');
  });
});

it('preserves all pending signals without constructing work summaries', () => {
  const input = {
    now: NOW,
    projects: [project(1, 'web', { dirtyFiles: 2 }), project(2, 'api')],
    cards: [
      card(1, 1, 'in_progress', STALLED_MS + 1),
      card(2, 1, 'review', 1000),
      card(3, 1, 'in_progress', STALLED_MS + 1),
    ],
    sessions: [session(1, 1, 3, 'input')],
    runs: [run(1, 1, 2, 'succeeded'), run(2, 1, 3, 'running')],
    screen: () => 'Choose a plan',
  };
  const full = buildSituation(input);
  const pending = buildSituation(input, false);
  expect(pending.needsAttention).toEqual(full.needsAttention);
  expect(pending.generatedAt).toBe(full.generatedAt);
  expect(pending.beingWorkedOn).toEqual([]);
  expect(full.beingWorkedOn).toHaveLength(3);
  expect(pending.needsAttention.map((item) => item.kind)).toEqual(
    expect.arrayContaining(['project-alert', 'needs-input', 'awaiting-review', 'stalled']),
  );
  expect(
    pending.needsAttention.filter((item) => item.kind === 'stalled').map((item) => item.cardId),
  ).toEqual([1]);
});
