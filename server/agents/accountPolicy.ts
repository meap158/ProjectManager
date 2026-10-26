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
