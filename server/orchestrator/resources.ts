import { statfsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The machine must have room before an orchestrator starts another worker (PM-424). A worker
 * builds, installs and runs tests: on a full drive it fails with ENOSPC (a run hit this with C:
 * at 0 bytes), and low memory makes new processes fail to spawn. Work already running is left
 * alone; only new workers wait, and they start again once space comes back.
 */
export const MIN_FREE_DISK_BYTES = 2 * 1024 ** 3;
export const MIN_FREE_MEMORY_BYTES = 1024 ** 3;
const CACHE_MS = 15_000;

export interface ResourceProbe {
  /** Free bytes for the drive holding `dir`, or null when it cannot be read. */
  freeDisk: (dir: string) => number | null;
  freeMemory: () => number;
}

const systemProbe: ResourceProbe = {
  freeDisk(dir) {
    try {
      const s = statfsSync(dir);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      return null;
    }
  },
  freeMemory: () => os.freemem(),
};

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(1)} GB`;
let cache: { key: string; at: number; value: string | undefined } | undefined;

/**
 * Why new workers should wait, or undefined when there is room. Checks the drive of every
 * project folder in scope and of the temp folder (tests and builds write there), plus free memory.
 */
export function resourceBlock(
  projectFolders: string[],
  probe: ResourceProbe = systemProbe,
  now = Date.now(),
): string | undefined {
  const roots = [
    ...new Set(
      [...projectFolders, os.tmpdir()].map((dir) => path.parse(path.resolve(dir)).root || dir),
    ),
  ].sort();
  const key = roots.join('|');
  if (probe === systemProbe && cache && cache.key === key && now - cache.at < CACHE_MS)
    return cache.value;
  let value: string | undefined;
  for (const root of roots) {
    const free = probe.freeDisk(root);
    if (free !== null && free < MIN_FREE_DISK_BYTES) {
      value = `Low disk space: ${root} has ${gb(free)} free (needs ${gb(MIN_FREE_DISK_BYTES)}); new workers wait`;
      break;
    }
  }
  const memory = probe.freeMemory();
  if (!value && memory < MIN_FREE_MEMORY_BYTES)
    value = `Low memory: ${gb(memory)} free (needs ${gb(MIN_FREE_MEMORY_BYTES)}); new workers wait`;
  if (probe === systemProbe) cache = { key, at: now, value };
  return value;
}
