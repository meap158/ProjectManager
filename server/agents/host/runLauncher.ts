import path from 'node:path';
import { OutputLog } from '../outputLog.js';
import { createHash } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { RunJournal, type JournalRun } from './runJournal.js';

export interface PipeRunLaunch {
  nonce: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs?: number;
  logPath?: string;
}

/** Host-local launch coordinator. Socket authentication and supervisor wiring are separate. */
export class RunLauncher {
  private live = new Map<string, { proc: ChildProcess; closed: Promise<void>; log: OutputLog }>();
  constructor(
    private journal: RunJournal,
    private outputDir: string,
  ) {}

  launch(input: PipeRunLaunch, onData: (text: string) => void): JournalRun {
    if (!input.argv.length || !input.argv[0]?.trim()) throw new Error('Missing executable');
    const timeoutMs = input.timeoutMs ?? 60 * 60_000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 240 * 60_000)
      throw new Error('Invalid execution timeout');
    const logPath = input.logPath ? path.resolve(input.logPath) : this.logPath(input.nonce);
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          argv: input.argv,
          cwd: input.cwd,
          timeoutMs,
          logPath,
          env: Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)),
        }),
      )
      .digest('hex');
    const claim = this.journal.claim(input.nonce, fingerprint, logPath);
    if (!claim.launch) return claim.run;
    try {
      const log = new OutputLog(logPath);
      const proc = spawn(input.argv[0], input.argv.slice(1), {
        cwd: input.cwd,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      });
      let closed!: () => void;
      const entry = {
        proc,
        log,
        closed: new Promise<void>((resolve) => {
          closed = resolve;
        }),
      };
      this.live.set(input.nonce, entry);
      const timer = setTimeout(() => {
        void this.stop(input.nonce);
      }, timeoutMs);
      timer.unref();
      // Attach lifecycle listeners before publishing startup; a fast exit must still be journaled.
      proc.once('error', () => {
        this.journal.finished(input.nonce, null, 'spawn-error');
      });
      proc.once('close', (code, signal) => {
        clearTimeout(timer);
        log.releaseCache();
        this.journal.finished(input.nonce, code, signal);
        if (this.live.get(input.nonce) === entry) this.live.delete(input.nonce);
        closed();
      });
      const output = (data: string) => {
        log.append(data);
        try {
          onData(data);
        } catch {
          /* A disconnected viewer cannot kill the worker. */
        }
      };
      proc.stdout.setEncoding('utf8');
      proc.stderr.setEncoding('utf8');
      proc.stdout.on('data', output);
      proc.stderr.on('data', output);
      if (proc.pid) this.journal.started(input.nonce, proc.pid);
    } catch (error) {
      // A synchronous exception after spawn may leave a process alive. Never authorize replay.
      this.journal.unknown(input.nonce);
      throw error;
    }
    return this.journal.get(input.nonce)!;
  }
  private logPath(nonce: string): string {
    return path.join(this.outputDir, createHash('sha256').update(nonce).digest('hex') + '.log');
  }

  read(
    nonce: string,
    after: number,
  ): { data: string; nextOffset: number; totalBytes: number } | null {
    const execution = this.journal.get(nonce);
    if (!execution) return null;
    const log =
      this.live.get(nonce)?.log ?? new OutputLog(execution.outputPath ?? this.logPath(nonce));
    return { ...log.read(after), totalBytes: log.totalBytes };
  }

  async stopAll(): Promise<boolean> {
    const results = await Promise.all([...this.live.keys()].map((nonce) => this.stop(nonce)));
    return results.every(Boolean);
  }

  /** Stop only an execution owned by this live host; a journal PID is never used. */
  async stop(nonce: string): Promise<boolean> {
    const entry = this.live.get(nonce);
    if (!entry) return this.journal.get(nonce)?.state === 'exited';
    const proc = entry.proc;
    if (proc.pid && proc.exitCode === null && proc.signalCode === null) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          execFile(
            'taskkill',
            ['/pid', String(proc.pid), '/T', '/F'],
            { windowsHide: true, timeout: 3000 },
            () => resolve(),
          );
        });
      } else {
        try {
          process.kill(-proc.pid, 'SIGKILL');
        } catch {
          /* Wait for the actual close event. */
        }
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([
      entry.closed.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 3000);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!ended) this.journal.unknown(nonce);
    return ended;
  }
}
