// Agent output logs with a bounded size on disk but byte offsets that only ever grow.
//
// Terminals resume "after byte N", so offsets must stay monotonic for a session's whole life. When
// a log reaches its cap it is compacted to its most recent tail and the number of bytes dropped
// from the head is recorded in a `<log>.base` sidecar. Logical offset = base + position in file.
// Before this, a full log stopped recording *and* streaming, so a long-lived TUI (OpenCode redraws
// constantly) went blank after a restart: no screen, no input box.

import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
} from 'node:fs';

/** Recent output kept when a full log is compacted: more than a viewer replays on open. */
export const LOG_KEEP_BYTES = 1024 * 1024;

function baseFile(file: string): string {
  return `${file}.base`;
}

/** Bytes dropped from the head of `file` by earlier compactions (0 if never compacted). */
export function logBase(file: string): number {
  try {
    const value = Number(readFileSync(baseFile(file), 'utf8').trim());
    return Number.isSafeInteger(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Physical size of the log file (0 if missing). */
export function physicalSize(file: string): number {
  try {
    const fd = openSync(file, 'r');
    try {
      return fstatSync(fd).size;
    } finally {
      closeSync(fd);
    }
  } catch {
    return 0;
  }
}

/** Total bytes ever written to the log: the offset the next byte will have. */
export function logicalSize(file: string): number {
  return logBase(file) + physicalSize(file);
}

/**
 * Compact a full log to its last `keep` bytes, preserving logical offsets. The caller must be the
 * log's only writer and must not hold an open append descriptor across this call. Returns the new
 * physical size. Content is written before the base so a concurrent reader at worst sees the old
 * base for a moment; it never reads past a missing head.
 */
export function compactLog(file: string, keep = LOG_KEEP_BYTES): number {
  const base = logBase(file);
  const size = physicalSize(file);
  const len = Math.max(0, Math.min(keep, size));
  let tail = Buffer.alloc(0);
  if (len > 0) {
    const fd = openSync(file, 'r');
    try {
      tail = Buffer.allocUnsafe(len);
      const read = readSync(fd, tail, 0, len, size - len);
      tail = tail.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }
  writeFileSync(file, tail);
  writeFileSync(baseFile(file), String(base + size - tail.length));
  return tail.length;
}

/** Delete a log and its offset sidecar. */
export function removeLog(file: string): void {
  rmSync(file, { force: true });
  rmSync(baseFile(file), { force: true });
}
