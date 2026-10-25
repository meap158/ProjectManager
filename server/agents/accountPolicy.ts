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
 * How auto-switch orders accounts that still have quota: most usable quota first (the lowest
 * remaining window, since an account stops at whichever window runs out), then most weekly
 * quota left, then the saved list order (the caller's order; the sort is stable). Compared in
 * whole percents, as Settings shows them, so readings that look equal tie. Null = unverified.
 */
export function switchQuota(
  reading: Parameters<typeof verifiedRemainingQuota>[0],
  now = Date.now(),
): { usable: number; weekly: number } | null {
  const usable = verifiedRemainingQuota(reading, now);
  if (usable === null || usable <= 0) return null;
  const windows = reading!.limits!.windows;
  const longest = windows.reduce((a, b) => (b.windowMinutes > a.windowMinutes ? b : a));
  return { usable: Math.round(usable), weekly: Math.round(100 - longest.usedPercent) };
}

export function bySwitchQuota(
  a: { usable: number; weekly: number },
  b: { usable: number; weekly: number },
): number {
  return b.usable - a.usable || b.weekly - a.weekly;
}
