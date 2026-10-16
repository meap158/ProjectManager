/** Completion-based polling: never accumulate requests when a server is slow. */
export function serialPoll(
  task: () => Promise<unknown>,
  delay: number,
  options: { pauseWhenHidden?: boolean } = {},
): () => void {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const visibility = options.pauseWhenHidden && typeof document !== 'undefined' ? document : null;
  const hidden = () => visibility?.visibilityState === 'hidden';
  const run = async () => {
    if (stopped || running || hidden()) return;
    running = true;
    try {
      await task();
    } catch {
      // The caller owns error display. A failure must not stop future refreshes.
    } finally {
      running = false;
      if (!stopped && !hidden()) timer = setTimeout(run, delay);
    }
  };
  const onVisibility = () => {
    clearTimeout(timer);
    if (!hidden()) void run();
  };
  visibility?.addEventListener('visibilitychange', onVisibility);
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
    visibility?.removeEventListener('visibilitychange', onVisibility);
  };
}
