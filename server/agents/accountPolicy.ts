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
