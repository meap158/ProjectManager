import type { AgentSession } from '../../shared/types.js';

// PM-726: the app types its automatic messages (orchestrator checks, worker messages, renames)
// into a CLI as a paste and Enter. Typed into a half-written message of yours, they would join it
// and send both. So they wait while you have been typing in that terminal without sending.

/** How long after your last unsent key the input box counts as yours. */
export const DRAFT_HOLD_MS = 120_000;

/** Navigation and mode shortcuts do not themselves add text to an input box. */
export function draftKeyEffect(data: string): 'clear' | 'keep' | 'hold' {
  if (/[\r\n]$/.test(data) || data === '\x03' || data === '\x15') return 'clear';
  if (
    data === '\x1b' ||
    (data.startsWith('\x1b') && /^(?:\[[0-9;]*[CDFH]|O[CDFH]|\[Z)$/.test(data.slice(1)))
  )
    return 'keep';
  return 'hold';
}

/** Only a complete, visibly empty Claude input box is proof that a stale draft is gone. */
export function emptyClaudeInput(screen: string): boolean {
  const lines = screen.split('\n');
  const prompts = lines.flatMap((line, index) => (/^\s*[>❯]/u.test(line) ? [index] : []));
  const index = prompts.at(-1);
  if (index === undefined || !/^\s*[>❯]\s*$/u.test(lines[index]!)) return false;
  const rule = (line: string) => /^\s*[─━-]{8,}/u.test(line);
  if (index === 0 || !rule(lines[index - 1]!)) return false;
  for (let end = index + 1; end < lines.length; end++) {
    const line = lines[end]!;
    if (rule(line)) {
      const footer = lines.slice(end + 1).filter((value) => value.trim());
      return (
        footer.length <= 2 &&
        footer.every((value) =>
          /auto mode|accept edits|bypass permissions|shift\s*\+\s*tab|for shortcuts|context left/i.test(
            value,
          ),
        )
      );
    }
    if (line.trim()) return false;
  }
  return false;
}

/** Whether you have unsent text in this session's input box, as far as the app can tell. */
export function ownerDrafting(
  session: Pick<AgentSession, 'lastKeyAt'> | null | undefined,
  now = Date.now(),
): boolean {
  const at = session?.lastKeyAt ? Date.parse(session.lastKeyAt) : NaN;
  return Number.isFinite(at) && now - at < DRAFT_HOLD_MS;
}
