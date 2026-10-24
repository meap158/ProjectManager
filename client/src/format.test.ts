import { describe, expect, it } from 'vitest';
import { formatBytes, formatCompact, formatRelative, formatReset, movedBy } from './format';

describe('format helpers', () => {
  it('formats byte sizes with sensible precision', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB');
  });

  it('only compacts large numbers', () => {
    expect(formatCompact(9_999)).toBe((9_999).toLocaleString());
    expect(formatCompact(1_500_000)).toMatch(/1\.5\s?M/);
  });

  it('describes times relative to now', () => {
    expect(formatRelative(null)).toBe('—');
    expect(formatRelative(new Date().toISOString())).toBe('just now');
    expect(formatRelative(new Date(Date.now() - 3 * 86_400_000).toISOString())).toMatch(
      /3 days ago/,
    );
  });
});

describe('formatReset', () => {
  it('says "in 3h 49m" within a day and date, time and timezone beyond', () => {
    const now = Date.parse('2026-10-06T13:00:00Z');
    expect(formatReset('2026-10-06T16:49:00Z', now)).toBe('in 3h 49m');
    const reset = formatReset('2026-10-12T19:00:00Z', now);
    expect(reset).toMatch(/\d/);
    expect(reset).not.toMatch(/^in /);
    expect(reset).toMatch(/Oct/);
    // Includes timezone indicator (e.g. GMT+7, UTC, EDT)
    expect(reset).toMatch(/GMT|UTC|[A-Z]{2,4}/);
  });
});

describe('movedBy', () => {
  it('names the commit, pull request or branch that moved a card', () => {
    expect(movedBy('0f790c9a1b2c3d4e5f60718293a4b5c6d7e8f901')).toMatchObject({
      short: '0f790c9',
      label: 'commit 0f790c9a1b',
    });
    expect(movedBy('PR #12')).toMatchObject({ short: 'PR #12', kind: 'pull request', name: '#12' });
    expect(movedBy('pm-3-search')).toMatchObject({
      short: 'pm-3-search',
      label: 'branch pm-3-search',
    });
  });
});
