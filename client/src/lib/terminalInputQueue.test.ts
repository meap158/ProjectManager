import { expect, it, vi } from 'vitest';
import { TerminalInputQueue } from './terminalInputQueue';
it('coalesces typing during slow requests without reordering or duplicate writes', async () => {
  vi.useFakeTimers();
  try {
    let release!: () => void;
    const write = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      )
      .mockResolvedValue(undefined);
    const queue = new TerminalInputQueue(write, vi.fn());
    queue.push('a');
    await vi.advanceTimersByTimeAsync(12);
    for (const key of ['b', 'c', '\r']) {
      queue.push(key);
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(write).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(write.mock.calls.map(([data]) => data)).toEqual(['a', 'bc\r']);
  } finally {
    vi.useRealTimers();
  }
});
