import type { ProviderLimits } from '../../shared/limits.js';

/** Shared by every account reader. Unknown and elapsed reset windows never authorize rotation. */
export const ACCOUNT_USAGE_MAX_AGE_MS = 60_000;
export function usageIsFresh(checkedAt: string | null | undefined, now = Date.now()): boolean {
  const checked = Date.parse(checkedAt ?? '');
  return Number.isFinite(checked) && checked <= now && now - checked <= ACCOUNT_USAGE_MAX_AGE_MS;
}
export function verifiedRemainingQuota(
  reading:
    | { status?: string; checkedAt?: string | null; limits?: ProviderLimits | null }
    | null
    | undefined,
  now = Date.now(),
): number | null {
  if (
    reading?.status !== 'fresh' ||
    !usageIsFresh(reading.checkedAt, now) ||
    !usageIsFresh(reading.limits?.asOf, now) ||
    !reading.limits?.windows.length
  )
    return null;
  if (
    reading.limits.windows.some(
      (w) =>
        !Number.isFinite(w.usedPercent) ||
        w.usedPercent < 0 ||
        w.usedPercent > 100 ||
        w.resetSinceReport ||
        (w.resetsAt !== null &&
          (!Number.isFinite(Date.parse(w.resetsAt)) || Date.parse(w.resetsAt) <= now)),
    )
  )
    return null;
  return Math.min(...reading.limits.windows.map((w) => 100 - w.usedPercent));
}

/**
 * Eligibility requires positive quota in every window. Preference is 5-hour remaining first,
 * then weekly remaining, then saved order (stable sort). A service that reports a different
 * set of windows falls back to its verified limiting window rather than inventing quota.
 * Compare whole percents, as Settings shows them, so readings that look equal tie. Null = unverified.
 */
export function switchQuota(
  reading: Parameters<typeof verifiedRemainingQuota>[0],
  now = Date.now(),
): { usable: number; fiveHour: number; weekly: number } | null {
  const usable = verifiedRemainingQuota(reading, now);
  if (usable === null || usable <= 0) return null;
  const windows = reading!.limits!.windows;
  const fiveHour = windows.find((w) => w.windowMinutes === 300);
  const weekly = windows.find((w) => w.windowMinutes === 10080);
  return {
    usable: Math.round(usable),
    fiveHour: Math.round(fiveHour ? 100 - fiveHour.usedPercent : usable),
    weekly: Math.round(weekly ? 100 - weekly.usedPercent : usable),
  };
}

export function bySwitchQuota(
  a: { fiveHour: number; weekly: number },
  b: { fiveHour: number; weekly: number },
): number {
  return b.fiveHour - a.fiveHour || b.weekly - a.weekly;
}

type ForecastAccount = { name: string; limits?: ProviderLimits | null };

/** Quota left now per the latest reading: the tightest window, an elapsed one counted as reset. */
function leftNow(limits: ProviderLimits | null | undefined, now: number): number | null {
  if (!limits?.windows.length) return null;
  return Math.min(
    ...limits.windows.map((w) =>
      w.resetSinceReport || (w.resetsAt !== null && Date.parse(w.resetsAt) <= now)
        ? 100
        : 100 - w.usedPercent,
    ),
  );
}

/** When an account at its limit has quota again: the latest reset among its spent windows. */
function backAt(limits: ProviderLimits | null | undefined, now: number): number | null {
  if (!limits?.windows.length) return null;
  const spent = limits.windows.filter(
    (w) => w.usedPercent >= 100 && !(w.resetsAt !== null && Date.parse(w.resetsAt) <= now),
  );
  if (!spent.length) return now;
  const times = spent.map((w) => (w.resetsAt ? Date.parse(w.resetsAt) : NaN));
  return times.every(Number.isFinite) ? Math.max(...times) : null;
}

/**
 * What automatic switching will do next for the account in use (PM-305's ranking, made visible):
 * nothing to say while it has more than `lowAt` percent left; then the account it would move to
 * (quota left now, best 5-hour then weekly, then list order, as `bySwitchQuota`); and when no
 * account has quota, the one whose quota comes back first. Reads the latest readings without the
 * freshness rule, so it is a forecast: the switch itself re-checks fresh usage.
 */
export function switchForecast(
  current: ForecastAccount,
  candidates: readonly ForecastAccount[],
  autoSwitch: boolean,
  now = Date.now(),
  lowAt = 10,
): import('../../shared/types.js').AccountSwitchForecast | null {
  const left = leftNow(current.limits, now);
  if (left === null || left > lowAt) return null;
  const atLimit = left <= 0;
  if (!autoSwitch) return atLimit ? { kind: 'off' } : null;
  const window = (limits: ProviderLimits | null | undefined, minutes: number, fallback: number) => {
    const w = limits?.windows.find((x) => x.windowMinutes === minutes);
    return Math.round(w ? 100 - w.usedPercent : fallback);
  };
  const ready = candidates
    .map((account) => ({ account, left: leftNow(account.limits, now) }))
    .filter((c): c is { account: ForecastAccount; left: number } => c.left !== null && c.left >= 1)
    .map((c) => ({
      ...c,
      fiveHour: window(c.account.limits, 300, c.left),
      weekly: window(c.account.limits, 10080, c.left),
    }))
    .sort(bySwitchQuota);
  const best = ready[0];
  if (best)
    return {
      kind: 'next',
      name: best.account.name,
      left: Math.round(best.left),
      fiveHour: best.fiveHour,
      weekly: best.weekly,
      atLimit,
    };
  if (!atLimit) return null;
  const comeback = [
    { account: current, current: true },
    ...candidates.map((account) => ({ account, current: false })),
  ]
    .map((c) => ({ ...c, at: backAt(c.account.limits, now) }))
    .filter((c): c is typeof c & { at: number } => c.at !== null)
    .sort((a, b) => a.at - b.at || Number(b.current) - Number(a.current))[0];
  return comeback
    ? {
        kind: 'wait',
        name: comeback.account.name,
        at: new Date(comeback.at).toISOString(),
        current: comeback.current,
      }
    : null;
}
