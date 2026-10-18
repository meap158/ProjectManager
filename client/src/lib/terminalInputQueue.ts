import { splitSessionInput } from './sessionInput';

/** Keep one request in flight and coalesce unsent typing instead of accumulating round trips. */
export class TerminalInputQueue {
  private pending = '';
  private active = false;
  private scheduled = false;
  constructor(
    private write: (data: string) => Promise<unknown>,
    private onError: (error: Error) => void,
  ) {}
  push(data: string) {
    this.pending += data;
    // Sent in the same task, not after a delay: a keystroke should leave as it is typed. Only what
    // is typed while a request is in flight waits (and goes out together when it returns).
    if (!this.active && !this.scheduled) {
      this.scheduled = true;
      queueMicrotask(() => {
        this.scheduled = false;
        void this.flush();
      });
    }
  }
  private async flush() {
    this.active = true;
    try {
      while (this.pending) {
        const parts = splitSessionInput(this.pending);
        const part = parts[0]!;
        this.pending = this.pending.slice(part.length);
        try {
          await this.write(part);
        } catch (error) {
          this.onError(error instanceof Error ? error : new Error(String(error)));
        }
      }
    } finally {
      this.active = false;
    }
  }
}
