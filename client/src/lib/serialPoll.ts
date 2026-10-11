/** Completion-based polling: never accumulate requests when a server is slow. */
export function serialPoll(task: () => Promise<unknown>, delay: number): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const run = async () => {
    try {
      await task();
    } catch {
      // The caller owns error display. A failure must not stop future refreshes.
    } finally {
      if (!stopped) timer = setTimeout(run, delay);
    }
  };
  void run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
