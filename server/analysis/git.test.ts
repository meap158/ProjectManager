import { describe, expect, it } from 'vitest';
import { parseLog, summarizeCommits } from './git.js';

const US = '\x1f';
const RS = '\x1e';
const record = (...fields: string[]) => `${fields.join(US)}${RS}\n`;

describe('git log parsing', () => {
  const log =
    record('c3', '2026-03-02T23:30:00-05:00', 'Ann', 'ann@x.io', 'Third | with pipes') +
    record('c2', '2026-03-02T09:00:00+00:00', 'Bob', 'bob@x.io', 'Second') +
    record('c1', '2026-01-15T12:00:00+00:00', 'Ann', 'ANN@x.io', 'First');

  it('parses records and aggregates per author-local day', () => {
    const commits = parseLog(log);
    expect(commits).toHaveLength(3);
    expect(commits[0]!.subject).toBe('Third | with pipes');

    const stats = summarizeCommits(commits);
    expect(stats.totalCommits).toBe(3);
    expect(stats.dailyCommits).toEqual({ '2026-03-02': 2, '2026-01-15': 1 });
    expect(stats.firstCommitAt).toBe('2026-01-15T12:00:00+00:00');
    expect(stats.lastCommitAt).toBe('2026-03-02T23:30:00-05:00');
    // Emails are matched case-insensitively.
    expect(stats.contributors).toEqual([
      { name: 'Ann', email: 'ann@x.io', commits: 2 },
      { name: 'Bob', email: 'bob@x.io', commits: 1 },
    ]);
  });

  it('handles empty history', () => {
    expect(summarizeCommits(parseLog(''))).toMatchObject({ totalCommits: 0, lastCommitAt: null });
  });
});
