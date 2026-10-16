// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { serialPoll } from './serialPoll';
let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function visibility() {
  let hidden = false;
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() =>
    hidden ? 'hidden' : 'visible',
  );
  return (value: boolean) => {
    hidden = value;
    document.dispatchEvent(new Event('visibilitychange'));
  };
}
it('does no hidden refreshes and refreshes immediately on return, without a catch-up burst', async () => {
  vi.useFakeTimers();
  const hide = visibility();
  hide(true);
  const task = vi.fn().mockResolvedValue(undefined);
  stop = serialPoll(task, 1000, { pauseWhenHidden: true });
  await vi.advanceTimersByTimeAsync(20000);
  expect(task).not.toHaveBeenCalled();
  hide(false);
  expect(task).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(task).toHaveBeenCalledTimes(2);
  hide(true);
  await vi.advanceTimersByTimeAsync(20000);
  expect(task).toHaveBeenCalledTimes(2);
  hide(false);
  expect(task).toHaveBeenCalledTimes(3);
});
it('keeps one in-flight request across repeated visibility changes and cleans up listeners', async () => {
  vi.useFakeTimers();
  const hide = visibility();
  let finish!: () => void;
  const task = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  stop = serialPoll(task, 1000, { pauseWhenHidden: true });
  hide(true);
  hide(false);
  hide(true);
  hide(false);
  expect(task).toHaveBeenCalledTimes(1);
  finish();
  await vi.advanceTimersByTimeAsync(1000);
  expect(task).toHaveBeenCalledTimes(2);
  stop();
  hide(true);
  hide(false);
  finish();
  await vi.advanceTimersByTimeAsync(20000);
  expect(task).toHaveBeenCalledTimes(2);
});
it('lets an in-flight hidden request settle without scheduling another', async () => {
  vi.useFakeTimers();
  const hide = visibility();
  let finish!: () => void;
  const task = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  stop = serialPoll(task, 1000, { pauseWhenHidden: true });
  hide(true);
  finish();
  await vi.advanceTimersByTimeAsync(20000);
  expect(task).toHaveBeenCalledTimes(1);
  hide(false);
  expect(task).toHaveBeenCalledTimes(2);
  finish();
});
