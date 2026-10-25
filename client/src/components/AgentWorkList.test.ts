import { describe, expect, it } from 'vitest';
import type { AgentRun, AgentSession } from '../../../shared/types';
import {
  mergeWork,
  runFacts,
  sessionFacts,
  stateLabel,
  workKey,
  workStatus,
} from './AgentWorkList';

const NOW = Date.parse('2026-10-06T12:00:00Z');
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const session = (id: number, patch: Partial<AgentSession>): AgentSession =>
  ({
    id,
    name: `s${id}`,
    status: 'running',
    createdAt: ago(300),
    startedAt: ago(80),
    endedAt: null,
    restarts: 0,
    lastRestartAt: null,
    queuedInputBytes: 0,
    ...patch,
  }) as AgentSession;

const run = (id: number, patch: Partial<AgentRun>): AgentRun =>
  ({
    id,
    name: `r${id}`,
    status: 'succeeded',
    createdAt: ago(10),
    startedAt: ago(10),
    endedAt: ago(8),
    changes: null,
    attempts: 1,
    maxAttempts: 2,
    ...patch,
  }) as AgentRun;

describe('mergeWork', () => {
  it('puts running work first, then the most recently active', () => {
    const items = mergeWork(
      [session(1, { status: 'exited', endedAt: ago(1) }), session(2, {})],
      [run(3, {}), run(4, { status: 'running', endedAt: null })],
    );
    expect(items.map(workKey)).toEqual(['run:4', 'session:2', 'session:1', 'run:3']);
  });
});

describe('facts', () => {
  it('describe a running session: uptime, first start, restarts, tokens', () => {
    const usage = { input: 345, cacheWrite: 10_000, output: 2_000, cacheRead: 900_000, replies: 7 };
    const facts = sessionFacts(session(1, { restarts: 2 }), NOW, usage).map((f) => f.text);
    expect(facts[0]).toBe('up 1h 20m');
    expect(facts[1]).toMatch(/^started /);
    expect(facts).toContain('2 restarts');
    // New tokens only (input + cache writes + output); cache reads stay in the tooltip.
    expect(facts.at(-1)).toMatch(/^12[.,]3K tokens$/i);
  });

  it('describe a finished run: duration and changed files', () => {
    const facts = runFacts(run(1, { changes: { files: ['a', 'b'], commits: 0 } }), NOW).map(
      (f) => f.text,
    );
    expect(facts[0]).toBe('took 2m 0s');
    expect(facts).toContain('2 files changed');
  });

  it('formats provider name dynamically in the session token facts tooltip', () => {
    const usage = { input: 100, cacheWrite: 20, output: 50, cacheRead: 5, replies: 3 };
    const facts = sessionFacts(session(1, { providerId: 'codex' }), NOW, usage);
    const tokenFact = facts.find((f) => f.text.includes('tokens'));
    expect(tokenFact?.title).toContain("from Codex's session transcript");

    const grokFacts = sessionFacts(session(2, { providerId: 'grok' }), NOW, usage);
    const grokTokenFact = grokFacts.find((f) => f.text.includes('tokens'));
    expect(grokTokenFact?.title).toContain("from Grok's session transcript");
  });
});

describe('stateLabel', () => {
  it.each(['stopping', 'starting', 'restoring'] as const)(
    'keeps a %s session in Running during the stop/start gap',
    (phase) => {
      const item = {
        kind: 'session' as const,
        item: session(1, { status: 'killed', restartProgress: phase }),
      };
      expect(workStatus(item, NOW)).toBe('running');
      expect(stateLabel(item, NOW).tone).toBe('attention');
    },
  );
  it('keeps a failed restart in Ended when no process is running', () => {
    expect(
      workStatus(
        { kind: 'session', item: session(1, { status: 'killed', restartProgress: 'failed' }) },
        NOW,
      ),
    ).toBe('ended');
  });
  it('does not display Restart failed when a session is actively running', () => {
    const s = session(1, {
      status: 'running',
      restartProgress: 'failed',
      tailState: 'running',
    });
    const label = stateLabel({ kind: 'session', item: s }, NOW);
    expect(label.text).not.toBe('Restart failed');
    expect(label.tone).not.toBe('bad');
    expect(label.text).toBe('running');
  });

  it('displays Restart failed with tone bad when a session is not running', () => {
    const s = session(1, {
      status: 'killed',
      restartProgress: 'failed',
    });
    const label = stateLabel({ kind: 'session', item: s }, NOW);
    expect(label.text).toBe('Restart failed');
    expect(label.tone).toBe('bad');
  });
});
