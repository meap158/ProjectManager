import type { AgentSession } from '../../shared/types';

/**
 * What a session is doing right now (owner rule PM-14):
 * - running: the CLI is busy, or a shell or subtask it started is still going. Judged from the
 *   CLI's last screen frame on the server (tailState); TUI redraws alone never count. For CLIs
 *   whose screen we can't read (shells, custom commands), output in the last few seconds;
 * - idle: running but quiet, i.e. waiting for you;
 * - stopped: no process.
 */
export type SessionActivity = 'running' | 'idle' | 'stopped';

/** For unknown CLIs: output within this window counts as running. */
export const RUNNING_WINDOW_MS = 8_000;

export function sessionActivity(s: AgentSession, now = Date.now()): SessionActivity {
  if (s.status !== 'running') return 'stopped';
  if (s.tailState) return s.tailState;
  const last = s.lastOutputAt ? Date.parse(s.lastOutputAt) : 0;
  return now - last <= RUNNING_WINDOW_MS ? 'running' : 'idle';
}

export const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  running: 'running',
  idle: 'idle · waiting for you',
  stopped: 'stopped',
};
