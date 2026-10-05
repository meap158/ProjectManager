import type { AgentSession } from '../../shared/types';

/**
 * What a session is doing right now:
 * - working: running and produced output in the last few seconds (busy CLIs stream spinners,
 *   progress and text continuously);
 * - idle: running but quiet, i.e. waiting for you;
 * - stopped: no process.
 */
export type SessionActivity = 'working' | 'idle' | 'stopped';

/** Output within this window counts as working. */
export const WORKING_WINDOW_MS = 8_000;

export function sessionActivity(s: AgentSession, now = Date.now()): SessionActivity {
  if (s.status !== 'running') return 'stopped';
  const last = s.lastOutputAt ? Date.parse(s.lastOutputAt) : 0;
  return now - last <= WORKING_WINDOW_MS ? 'working' : 'idle';
}

export const ACTIVITY_LABEL: Record<SessionActivity, string> = {
  working: 'working',
  idle: 'idle · waiting for you',
  stopped: 'stopped',
};
