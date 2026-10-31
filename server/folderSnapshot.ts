import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { FolderItem } from '../shared/types.js';

const TTL = 30_000;
const MAX_SCOPES = 3;
export const FOLDER_WALK_BATCH = 20_000;
interface Snapshot {
  entries: { index: number; item: FolderItem }[];
  scanned: number;
  complete: boolean;
}
const snapshots = new Map<string, { until: number; pending: Promise<Snapshot> }>();

/** The caller resolves and validates the folder before consulting this bounded, short-lived cache. */
export function folderSnapshot(
  root: string,
  dir: string,
  recursive: boolean,
  offset: number,
  fresh: boolean,
): Promise<Snapshot> {
  const scope = JSON.stringify([root, dir, recursive]);
  const end = (Math.floor(offset / FOLDER_WALK_BATCH) + 1) * FOLDER_WALK_BATCH;
  const key = `${scope}:${end}`;
  if (fresh) for (const k of snapshots.keys()) if (k.startsWith(`${scope}:`)) snapshots.delete(k);
  const cached = snapshots.get(key);
  if (cached && cached.until > Date.now()) return cached.pending;
  snapshots.delete(key);
  const entry = { until: Infinity, pending: Promise.resolve(null as unknown as Snapshot) };
  entry.pending = scan(root, dir, recursive, end).then(
    (result) => {
      entry.until = Date.now() + TTL;
      // Very deep walks remain readable, but do not retain oversized snapshots.
      if (result.entries.length > 60_000 && snapshots.get(key) === entry) snapshots.delete(key);
      return result;
    },
    (error) => {
      if (snapshots.get(key) === entry) snapshots.delete(key);
      throw error;
    },
  );
  snapshots.set(key, entry);
  while (snapshots.size > MAX_SCOPES) snapshots.delete(snapshots.keys().next().value!);
  return entry.pending;
}

async function scan(root: string, dir: string, recursive: boolean, end: number): Promise<Snapshot> {
  const entries: Snapshot['entries'] = [];
  const queue = [dir];
  let scanned = 0;
  let complete = true;
  outer: for (let at = 0; at < queue.length; at++) {
    const current = queue[at]!;
    const handle = await opendir(current).catch(() => null);
    if (!handle) continue;
    const batch: import('node:fs').Dirent[] = [];
    const consume = async () => {
      const records = await Promise.all(
        batch.map(async (entry) => ({
          entry,
          info: await lstat(path.join(current, entry.name)).catch(() => null),
        })),
      );
      batch.length = 0;
      for (const { entry, info } of records) {
        const index = ++scanned;
        if (!info) continue;
        const symlink = info.isSymbolicLink();
        const isDir = !symlink && info.isDirectory();
        const abs = path.join(current, entry.name);
        if (isDir && recursive && entry.name !== 'node_modules') queue.push(abs);
        entries.push({
          index,
          item: {
            name: entry.name,
            path: path.relative(root, abs).split(path.sep).join('/'),
            kind: isDir ? 'dir' : 'file',
            size: isDir ? null : info.size,
            mtime: info.mtime.toISOString(),
            ctime: (info.birthtimeMs > 0 ? info.birthtime : info.ctime).toISOString(),
            ignored: false,
            symlink,
            width: null,
            height: null,
            git: null,
          },
        });
      }
    };
    for await (const entry of handle) {
      if (entry.name === '.git') continue;
      if (scanned + batch.length >= end) {
        await consume();
        complete = false;
        break outer;
      }
      batch.push(entry);
      if (batch.length === 32) await consume();
    }
    await consume();
  }
  return { entries, scanned, complete };
}
