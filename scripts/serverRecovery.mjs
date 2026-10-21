import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';

export const FATAL_MARKER = '[server] FATAL';

/** Keep crash evidence without allowing repeated output to fill the data disk. */
export function recordServerOutput(dataDir, text) {
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = path.join(dataDir, 'server-output.log');
    if (existsSync(file) && statSync(file).size >= 2 * 1024 * 1024) {
      rmSync(file + '.previous', { force: true });
      renameSync(file, file + '.previous');
    }
    appendFileSync(file, text);
  } catch {
    // Failure to write diagnostics must not take down the launcher.
  }
}

/** Bound crash loops, but let a server that ran stably recover again later. */
export function restartBudget(limit = 5, windowMs = 5 * 60_000) {
  let attempts = [];
  return (now = Date.now()) => {
    attempts = attempts.filter((at) => now - at < windowMs);
    if (attempts.length >= limit) return false;
    attempts.push(now);
    return true;
  };
}

/** tsx watch can remain alive after its server crashes; the fatal marker ends this wait too. */
export function childOutcome(proc) {
  return new Promise((resolve) => {
    let tail = '';
    const done = (result) => {
      proc.recoveryFailed = true;
      proc.off('exit', onExit);
      proc.off('error', onError);
      proc.stderr?.off('data', onData);
      resolve(result);
    };
    const onExit = (code, signal) => done({ code, signal });
    const onError = (error) => done({ code: null, error: error.message });
    const onData = (chunk) => {
      tail = (tail + chunk.toString()).slice(-8192);
      if (tail.includes(FATAL_MARKER)) done({ code: 1, fatal: true });
    };
    proc.once('exit', onExit);
    proc.once('error', onError);
    proc.stderr?.on('data', onData);
  });
}
