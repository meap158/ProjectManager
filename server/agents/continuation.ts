import { stripTerminal } from './activity.js';
import type { UsageWindow } from '../../shared/limits.js';

export function allowanceReset(tail: string, windows: UsageWindow[], now: number): string | null {
  if (!/you[’']ve hit your usage limit/i.test(stripTerminal(tail).slice(-2000))) return null;
  const resets = windows
    .filter((w) => w.usedPercent >= 99 && w.resetsAt)
    .map((w) => Date.parse(w.resetsAt!));
  // Every exhausted window must have an unambiguous reset.
  // Reports can lag or round down to 99%; the actual denial above is required evidence.
  if (!resets.length || windows.some((w) => w.usedPercent >= 99 && !w.resetsAt)) return null;
  const reset = Math.max(...resets) + 30_000;
  return Number.isFinite(reset) && reset > now ? new Date(reset).toISOString() : null;
}

/**
 * The usage limit a screen shows (PM-58): when the exhausted windows reset (the latest of
 * them), or null for an unknown time. Undefined when no limit is showing, or it has reset.
 */
/** Whether Codex's usage-limit message is on screen (cheap: check before reading quota). */
export function mentionsUsageLimit(screen: string): boolean {
  return /you[’']ve hit your usage limit/i.test(screen);
}

export function usageLimitShown(
  screen: string,
  windows: UsageWindow[],
  now: number,
): { resetsAt: string | null } | undefined {
  if (!mentionsUsageLimit(screen)) return undefined;
  const resets = windows
    .filter((w) => w.usedPercent >= 99 && w.resetsAt)
    .map((w) => Date.parse(w.resetsAt!))
    .filter(Number.isFinite);
  if (!resets.length) return { resetsAt: null };
  const reset = Math.max(...resets);
  return reset > now ? { resetsAt: new Date(reset).toISOString() } : undefined;
}

export function emptyCodexPrompt(tail: string): boolean {
  const text = stripTerminal(tail).slice(-1200);
  const prompts = [...text.matchAll(/(?:^|\n)[ \t]*[›❯>][ \t]*([^\r\n]*)/g)];
  const last = prompts.at(-1)?.[1]?.trim();
  return last !== undefined && /^(?:Ask \S+ to do anything)?$/i.test(last);
}
