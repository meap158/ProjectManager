import { expect, it } from 'vitest';
import { RecentCache } from './recentCache';
it('bounds retained projects while promoting revisits and refreshed values', () => {
  const cache = new RecentCache<number, object>(2);
  const first = { name: 'first' };
  cache.set(1, first);
  cache.set(2, {});
  expect(cache.get(1)).toBe(first);
  cache.set(3, {});
  expect(cache.get(2)).toBeUndefined();
  const updated = { name: 'updated' };
  cache.set(1, updated);
  cache.set(4, {});
  expect(cache.get(3)).toBeUndefined();
  expect(cache.get(1)).toBe(updated);
  // Eviction removes only the cache reference, not data held by a rendered view.
  expect(first.name).toBe('first');
});
it('rejects capacities that cannot bound retention', () => {
  for (const capacity of [0, -1, Infinity, 1.5]) expect(() => new RecentCache(capacity)).toThrow();
});
