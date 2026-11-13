import type { AgentSession } from '../../shared/types.js';

// PM-726: the app types its automatic messages (orchestrator checks, worker messages, renames)
// into a CLI as a paste and Enter. Typed into a half-written message of yours, they would join it
// and send both. So they wait while you have been typing in that terminal without sending.

/** How long after your last unsent key the input box counts as yours. */
export const DRAFT_HOLD_MS = 120_000;

/** Whether you have unsent text in this session's input box, as far as the app can tell. */
export function ownerDrafting(
  session: Pick<AgentSession, 'lastKeyAt'> | null | undefined,
  now = Date.now(),
): boolean {
  const at = session?.lastKeyAt ? Date.parse(session.lastKeyAt) : NaN;
  return Number.isFinite(at) && now - at < DRAFT_HOLD_MS;
}
