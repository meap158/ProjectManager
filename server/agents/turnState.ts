// What a Claude session said it is doing, from its own hooks (scripts/claude-session-hook.mjs).
// This is exact where screen-scraping guesses: Claude redraws with cursor moves, so its log never
// holds clean, parseable lines. Events (https://code.claude.com/docs/en/hooks):
//   UserPromptSubmit                    a turn started            -> running
//   Stop                                the turn ended            -> idle
//   Notification (waiting kinds only)   Claude is waiting for you -> idle
//   SessionStart                        fresh / resumed / cleared -> idle
//   SubagentStart / SubagentStop        subagents still going keep the session running (PM-14),
//                                       even after the main turn ended (background agents)
// Stop doesn't fire on Esc, so "running" with a silent screen for SILENT_MS counts as idle.
// Kept in memory: events arrive many times a minute, and after a server restart the next event
// refreshes it (until then the screen-based detector applies).

export type TurnState = 'running' | 'idle' | 'input';

/** If Claude says "running" but its screen has been silent this long, it isn't (e.g. Esc). */
export const SILENT_MS = 60_000;

/** Notification kinds that mean "waiting for you" (others, e.g. agent_completed, don't). */
const WAITING = new Set(['idle_prompt']);
/** ...and the ones where Claude asks you to decide something (approve a tool, answer a question). */
const ASKING = new Set(['permission_prompt', 'agent_needs_input', 'elicitation_dialog']);

interface Entry {
  turn: TurnState;
  subagents: number;
  at: number;
}

const states = new Map<number, Entry>();

/** Applies one hook event to a session's state. */
export function recordEvent(
  sessionId: number,
  event: string | null | undefined,
  notificationType?: string | null,
  at = Date.now(),
): void {
  const entry = states.get(sessionId) ?? { turn: 'idle' as TurnState, subagents: 0, at };
  const next = { ...entry, at };
  if (event === 'UserPromptSubmit') next.turn = 'running';
  else if (event === 'Stop') next.turn = 'idle';
  else if (event === 'SessionStart' || !event) next.turn = 'idle';
  else if (event === 'Notification') {
    if (notificationType && ASKING.has(notificationType)) next.turn = 'input';
    else if (!notificationType || WAITING.has(notificationType)) next.turn = 'idle';
  } else if (event === 'SubagentStart') next.subagents++;
  else if (event === 'SubagentStop') next.subagents = Math.max(0, next.subagents - 1);
  else return;
  if (event === 'SessionStart') next.subagents = 0;
  states.set(sessionId, next);
}

export function forgetTurn(sessionId: number): void {
  states.delete(sessionId);
}

/**
 * The hook-reported state, sanity-checked against output: running while a turn or a subagent is
 * going, unless the screen has been silent for SILENT_MS (a busy Claude redraws its spinner
 * continuously). Null when no hook has reported yet.
 */
export function turnState(
  sessionId: number,
  lastOutputAt: string | null,
  now = Date.now(),
): TurnState | null {
  const entry = states.get(sessionId);
  if (!entry) return null;
  if (entry.turn === 'input') return 'input';
  if (entry.turn === 'running' || entry.subagents > 0) {
    const last = lastOutputAt ? Date.parse(lastOutputAt) : entry.at;
    return now - Math.max(last, entry.at) > SILENT_MS ? 'idle' : 'running';
  }
  return 'idle';
}
