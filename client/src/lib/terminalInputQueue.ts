import { splitSessionInput } from './sessionInput';

/** Keep one request in flight and coalesce unsent typing instead of accumulating round trips. */
export class TerminalInputQueue {
  private pending = '';
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(
    private write: (data: string) => Promise<unknown>,
    private onError: (error: Error) => void,
  ) {}
  push(data: string) {
    this.pending += data;
    if (!this.active && !this.timer)
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.flush();
      }, 12);
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
