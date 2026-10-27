import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * A short memory of what the server was doing, so a "[perf] event loop was blocked" line can say
 * what ran around it (PM-332). Only the method and path are kept, never query strings or bodies.
 */
interface Entry {
  label: string;
  startedAt: number;
  endedAt: number | null;
}

const KEEP_MS = 60_000;
const MAX_ENTRIES = 400;
const entries: Entry[] = [];

function prune(now: number): void {
  while (
    entries.length > 0 &&
    (entries.length > MAX_ENTRIES || (entries[0]!.endedAt ?? now) < now - KEEP_MS)
  )
    entries.shift();
}

/** Wraps a request handler to record each request's span. */
export function traceRequests(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const now = Date.now();
    prune(now);
    const path = (req.url ?? '').split('?')[0] ?? '';
    const entry: Entry = { label: `${req.method ?? 'GET'} ${path}`, startedAt: now, endedAt: null };
    entries.push(entry);
    res.once('close', () => {
      entry.endedAt = Date.now();
    });
    handler(req, res);
  };
}

/** Requests that were running at any point in the last `windowMs`, longest first. */
export function recentRequests(windowMs: number, now = Date.now(), limit = 5): string[] {
  return entries
    .filter((e) => (e.endedAt ?? now) >= now - windowMs)
    .map((e) => ({ e, ms: (e.endedAt ?? now) - e.startedAt }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit)
    .map(({ e, ms }) => `${e.label} ${ms}ms${e.endedAt === null ? ' (still open)' : ''}`);
}
