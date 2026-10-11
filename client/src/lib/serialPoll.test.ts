import { afterEach, expect, it, vi } from 'vitest';
import { serialPoll } from './serialPoll';
afterEach(() => vi.useRealTimers());
it('waits for slow requests and stops after cleanup even while in flight', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  const task = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const stop = serialPoll(task, 1000);
  await vi.advanceTimersByTimeAsync(10000);
  expect(task).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(1000);
  expect(task).toHaveBeenCalledTimes(2);
  stop();
  finish();
  await vi.advanceTimersByTimeAsync(10000);
  expect(task).toHaveBeenCalledTimes(2);
});
it('continues after a failed refresh', async () => {
  vi.useFakeTimers();
  const task = vi.fn().mockRejectedValue(new Error('offline'));
  const stop = serialPoll(task, 1000);
  await vi.advanceTimersByTimeAsync(1000);
  expect(task).toHaveBeenCalledTimes(2);
  stop();
});
