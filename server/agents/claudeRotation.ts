import type { UsageWindow } from '../../shared/limits.js';
import type { CodexAccountsState } from '../../shared/types.js';
import { stripTerminal } from './activity.js';

/**
 * Automatic Claude Code account rotation: the decision, kept free of I/O so it can be tested.
 *
 * Signals used, all already collected:
 * - the status line's last report per login (`claude-account-usage/<token hash>`): exact for the
 *   login in use, and for a saved one a lower bound on what is left, because nothing spends it
 *   while it is not selected (a window that has since reset counts as unused);
 * - the CLI's own limit message on a session's screen, which names exhaustion even when the
 *   meter lags or was never reported.
 */

/** The limit messages Claude Code prints when a window is used up. */
const LIMIT_MESSAGE =
  /(?:5-hour|weekly|session|usage|opus) limit reached|you[’']ve hit your (?:\w+ )?limit|claude usage limit reached/i;

export function claudeLimitOnScreen(screen: string): boolean {
  return LIMIT_MESSAGE.test(stripTerminal(screen).slice(-3000));
}

/** A window's used share now: a window that reset since its report counts as unused. */
function used(w: UsageWindow, now: number): number {
  if (w.resetSinceReport || (w.resetsAt && Date.parse(w.resetsAt) <= now)) return 0;
  return w.usedPercent;
}

type Entry = {
  id: string;
  limits: { windows: UsageWindow[] } | null;
};

function entries(state: CodexAccountsState): Entry[] {
  return [
    { id: 'default', limits: state.defaultAccount?.limits ?? null },
    ...state.accounts.map((a) => ({ id: a.id, limits: a.limits ?? null })),
  ];
}

/** The account in use: the active saved profile, else the default login. */
export function currentClaudeId(state: CodexAccountsState): string {
  return state.activeProfileId ?? 'default';
}

/** Whether a reading shows a window used up (99% or more, as the meter rounds), or null if unknown. */
export function readingExhausted(
  limits: { windows: UsageWindow[] } | null,
  now: number,
): boolean | null {
  if (!limits?.windows.length) return null;
  return limits.windows.some((w) => used(w, now) >= 99);
}

/**
 * The account to switch to, or null to stay. `limitShown` is the CLI's own message on a session.
 * The current account counts as exhausted on a reading of 99% or more, or on the message when the
 * reading is not at least 5 points clear of it. Candidates: not tried, not exhausted by their last
 * reading; one never read is allowed but ranked last, and the next tick moves on if it is also out.
 * Ranking: most 5-hour left, then most weekly left, then saved order.
 */
export function nextClaudeAccount(
  state: CodexAccountsState,
  tried: readonly string[],
  limitShown: boolean,
  now = Date.now(),
): { id: string; name: string } | null {
  const all = entries(state);
  const currentId = currentClaudeId(state);
  const current = all.find((e) => e.id === currentId);
  const exhausted = readingExhausted(current?.limits ?? null, now);
  const worst = Math.max(0, ...(current?.limits?.windows ?? []).map((w) => used(w, now)));
  if (!(exhausted === true || (limitShown && (exhausted === null || worst >= 95)))) return null;
  const rank = all
    .map((e, order) => {
      const windows = e.limits?.windows ?? [];
      const five = windows.find((w) => w.windowMinutes === 300);
      const week = windows.find((w) => w.windowMinutes === 10_080);
      return {
        e,
        order,
        known: windows.length > 0,
        bad: readingExhausted(e.limits, now) === true,
        five: five ? 100 - used(five, now) : 100,
        week: week ? 100 - used(week, now) : 100,
      };
    })
    .filter((r) => r.e.id !== currentId && !tried.includes(r.e.id) && !r.bad)
    .sort(
      (a, b) =>
        Number(b.known) - Number(a.known) ||
        b.five - a.five ||
        b.week - a.week ||
        a.order - b.order,
    );
  const chosen = rank[0]?.e;
  if (!chosen) return null;
  const name =
    chosen.id === 'default'
      ? 'Default Claude account'
      : (state.accounts.find((a) => a.id === chosen.id)?.name ?? chosen.id);
  return { id: chosen.id, name };
}
