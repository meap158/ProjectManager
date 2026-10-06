import { describe, expect, it } from 'vitest';
import { formatBytes, formatCompact, formatRelative, formatReset } from './format';

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
  it('says "in 3h 49m" within a day and the weekday and time beyond', () => {
    const now = Date.parse('2026-10-06T13:00:00Z');
    expect(formatReset('2026-10-06T16:49:00Z', now)).toBe('in 3h 49m');
    expect(formatReset('2026-10-12T19:00:00Z', now)).toMatch(/\d/);
    expect(formatReset('2026-10-12T19:00:00Z', now)).not.toMatch(/^in /);
  });
});
