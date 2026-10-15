import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { RunJournal, type JournalRun } from './runJournal.js';

export interface PipeRunLaunch {
  nonce: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Host-local launch coordinator. Socket authentication and supervisor wiring are separate. */
export class RunLauncher {
  constructor(private journal: RunJournal) {}

  launch(input: PipeRunLaunch, onData: (text: string) => void): JournalRun {
    if (!input.argv.length || !input.argv[0]?.trim()) throw new Error('Missing executable');
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          argv: input.argv,
          cwd: input.cwd,
          env: Object.entries(input.env).sort(([a], [b]) => a.localeCompare(b)),
        }),
      )
      .digest('hex');
    const claim = this.journal.claim(input.nonce, fingerprint);
    if (!claim.launch) return claim.run;
    try {
      const proc = spawn(input.argv[0], input.argv.slice(1), {
        cwd: input.cwd,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
        windowsHide: true,
      });
      // Attach lifecycle listeners before publishing startup; a fast exit must still be journaled.
      proc.once('error', () => {
        this.journal.finished(input.nonce, null, 'spawn-error');
      });
      proc.once('close', (code, signal) => {
        this.journal.finished(input.nonce, code, signal);
      });
      const output = (data: string) => {
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
}
