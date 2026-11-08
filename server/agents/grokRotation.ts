import type { NativeAccount, NativeAccountsState } from '../../shared/nativeAccounts.js';
import { usageIsFresh } from './accountPolicy.js';
import { stripTerminal } from './activity.js';

/**
 * Automatic Grok account rotation (PM-412): the decision, kept free of I/O so it can be tested.
 *
 * The only signal that authorizes a switch is a fresh Grok billing reading of the login in use
 * (credential-bound, under a minute old) at 99% or more of its credits. The CLI's own message on
 * a session's screen only asks for that reading sooner: Grok prints it inside a dialog, and a
 * stale screen must never move every session to another login on its own.
 */

/**
 * What Grok Build prints when an account's credits are used up, as seen in real session logs
 * ("You hit your weekly limit." above a "Buy more credits" choice) and in the 1.0.62 binary.
 * The rate-limit messages ("You've hit the rate limit for your plan", "Rate limited", "The
 * service is busy") clear by waiting, so they are deliberately not matched.
 */
const LIMIT_MESSAGE =
  /you hit your (?:weekly|daily|monthly|free usage) limit|out of credits or over your spending limit|purchase credits to keep using grok/i;

export function grokLimitOnScreen(screen: string): boolean {
  return LIMIT_MESSAGE.test(stripTerminal(screen).slice(-3000));
}

/** A left account is skipped this long when its reading names no reset time. */
export const GROK_SKIP_WITHOUT_RESET_MS = 24 * 60 * 60_000;

/** The account's credit window, when a reading has one whose reset has not passed. */
function liveWindow(account: NativeAccount | null | undefined, now: number) {
  const window = account?.limits?.windows[0];
  if (!window || window.resetSinceReport) return null;
  if (window.resetsAt && Date.parse(window.resetsAt) <= now) return null;
  return window;
}

/** Whether the login in use is verified out of credits: a fresh reading at 99% or more. */
export function grokCurrentExhausted(state: NativeAccountsState, now = Date.now()): boolean {
  const current = state.defaultAccount;
  if (!current || current.usageStatus !== 'fresh') return false;
  if (!usageIsFresh(current.limits?.asOf ?? current.usage.updatedAt, now)) return false;
  const window = liveWindow(current, now);
  return !!window && window.usedPercent >= 99;
}

/**
 * Until when a left account is skipped: its own reset when the reading names one, else a day.
 * Grok's credit windows are daily, weekly or monthly, so a fixed few hours would come straight
 * back to an account that is still out.
 */
export function grokSkipUntil(account: NativeAccount | null | undefined, now = Date.now()): number {
  const reset = liveWindow(account, now)?.resetsAt;
  const at = reset ? Date.parse(reset) : NaN;
  return Number.isFinite(at) && at > now ? at : now + GROK_SKIP_WITHOUT_RESET_MS;
}

/**
 * The saved account to switch to, or null to stay. Only when the current login is verified out
 * of credits. Candidates: saved, readable, not the current login, not skipped, and not out by
 * their own reading. One whose usage is unknown (an expired saved token is never refreshed here,
 * since that would retire its refresh token) is allowed but ranked last; if it is out too, the
 * next tick moves on. Accounts the owner left out (PM-531) are never chosen. Ranking: least credit used, then saved order.
 */
export function nextGrokAccount(
  state: NativeAccountsState,
  skipped: ReadonlyMap<string, number>,
  now = Date.now(),
): { id: string; name: string } | null {
  if (!grokCurrentExhausted(state, now)) return null;
  const currentId = state.defaultAccount?.id;
  const rank = state.accounts
    .map((account, order) => {
      const window = liveWindow(account, now);
      return { account, order, used: window ? window.usedPercent : null };
    })
    .filter(
      ({ account, used }) =>
        account.id !== currentId &&
        account.autoSwitchEligible !== false &&
        account.usageStatus !== 'unavailable' &&
        (skipped.get(account.id) ?? 0) <= now &&
        (used === null || used < 99),
    )
    .sort(
      (a, b) =>
        Number(b.used !== null) - Number(a.used !== null) ||
        (a.used ?? 0) - (b.used ?? 0) ||
        a.order - b.order,
    );
  const chosen = rank[0]?.account;
  return chosen ? { id: chosen.id, name: chosen.name } : null;
}
