import { afterEach, expect, it, vi } from 'vitest';
import { openDb } from './db.js';
import { Scanner } from './scanner.js';
import * as store from './store.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it.each(['watchCommits', 'watchPullRequests'] as const)(
  '%s contains a failed poll and keeps polling',
  async (method) => {
    vi.useFakeTimers();
    const db = openDb(':memory:');
    const error = new Error('fixture database busy');
    const folders = vi
      .spyOn(store, 'listProjectFolders')
      .mockImplementationOnce(() => {
        throw error;
      })
      .mockReturnValue([]);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const stop = new Scanner(db)[method](100);
    try {
      expect(log).toHaveBeenCalledWith(expect.stringContaining('watcher failed'), error);
      await vi.advanceTimersByTimeAsync(100);
      expect(folders).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(200);
      expect(folders).toHaveBeenCalledTimes(2);
    } finally {
      stop();
      db.close();
    }
  },
);

it('contains synchronous refresh timer errors and retries on the next interval', async () => {
  vi.useFakeTimers();
  const db = openDb(':memory:');
  const error = new Error('fixture refresh failure');
  const stalest = vi
    .spyOn(store, 'stalestProject')
    .mockImplementationOnce(() => {
      throw error;
    })
    .mockReturnValue(undefined);
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const stop = new Scanner(db).refreshPeriodically(1000, 100);
  try {
    await vi.advanceTimersByTimeAsync(100);
    expect(log).toHaveBeenCalledWith('[scan] periodic refresh failed:', error);
    await vi.advanceTimersByTimeAsync(100);
    expect(stalest).toHaveBeenCalledTimes(2);
  } finally {
    stop();
    db.close();
  }
});
