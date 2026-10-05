import { describe, expect, it } from 'vitest';
import { formatBytes, formatCompact, formatRelative } from './format';

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
