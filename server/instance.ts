// One ProjectManager server per data folder. Two servers on the same database would each run an
// agent supervisor and both relaunch the same supervised sessions (duplicate agent processes).
// The running server records itself in <dataDir>/server.json; a second start finds it, confirms
// it answers, and hands over instead of starting (the launcher then just opens that URL).

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface InstanceInfo {
  pid: number;
  /** Process that owns this instance across dev restarts (the launcher), else the server. */
  owner: number;
  url: string;
  startedAt: string;
}

/** scripts/launch.mjs watches for this line (followed by the URL). Keep in sync with it. */
export const ALREADY_RUNNING_MARKER = '[server] ALREADY_RUNNING';

const fileFor = (dataDir: string) => path.join(dataDir, 'server.json');

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // Signal 0 only checks existence (works on Windows too).
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function readInstance(dataDir: string): InstanceInfo | null {
  try {
    return JSON.parse(readFileSync(fileFor(dataDir), 'utf8')) as InstanceInfo;
  } catch {
    return null;
  }
}

/** A record this young from a live process counts as "starting up" even if it doesn't answer. */
const STARTUP_GRACE_MS = 60_000;

/** Another live server for this data folder (not our own previous incarnation), or null. */
export async function findOtherInstance(
  dataDir: string,
  owner: number,
): Promise<InstanceInfo | null> {
  const other = readInstance(dataDir);
  if (!other || other.owner === owner || other.pid === process.pid || !isAlive(other.pid)) {
    return null;
  }
  if (Date.now() - Date.parse(other.startedAt) < STARTUP_GRACE_MS) return other;
  try {
    // Older records must answer: guards against a reused PID after a crash.
    const res = await fetch(`${other.url.replace('localhost', '127.0.0.1')}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? other : null;
  } catch {
    return null;
  }
}

/**
 * Claims the data folder before anything else starts. Creating the record exclusively ('wx')
 * means two servers starting at the same moment can't both win. Returns the other instance when
 * one already holds the folder.
 */
export async function claimInstance(
  dataDir: string,
  info: InstanceInfo,
): Promise<InstanceInfo | null> {
  mkdirSync(dataDir, { recursive: true });
  const body = JSON.stringify(info, null, 2);
  try {
    writeFileSync(fileFor(dataDir), body, { flag: 'wx' });
    return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const other = await findOtherInstance(dataDir, info.owner);
  if (other) return other;
  writeFileSync(fileFor(dataDir), body); // Stale record (crashed server) or our own restart.
  return null;
}

/** Removes the record if it is still ours. */
export function releaseInstance(dataDir: string, pid: number): void {
  if (readInstance(dataDir)?.pid === pid) rmSync(fileFor(dataDir), { force: true });
}
