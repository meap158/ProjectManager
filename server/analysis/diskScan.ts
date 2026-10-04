import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { DiskStats, FolderSize } from '../../shared/types.js';

/** Stop walking after this many entries so huge folders can't stall a scan indefinitely. */
const MAX_ENTRIES = 400_000;
const CONCURRENCY = 64;
const ROOT_FILES = '(root files)';

/**
 * Measures everything physically inside the folder, including ignored and dependency folders.
 * Symlinks are not followed. Sizes are apparent file sizes (not allocated clusters).
 */
export async function scanDisk(root: string): Promise<DiskStats> {
  const top = new Map<string, FolderSize>();
  let files = 0;
  let folders = 0;
  let bytes = 0;
  let entries = 0;
  let truncated = false;

  // Each queue item: absolute dir path + the top-level bucket it belongs to.
  const queue: { dir: string; bucket: string | null }[] = [{ dir: root, bucket: null }];
  let active = 0;

  await new Promise<void>((resolve) => {
    const pump = () => {
      while (active < CONCURRENCY && queue.length > 0 && !truncated) {
        const item = queue.shift()!;
        active++;
        processDir(item.dir, item.bucket).finally(() => {
          active--;
          pump();
        });
      }
      if (active === 0 && (queue.length === 0 || truncated)) resolve();
    };

    const processDir = async (dir: string, bucket: string | null) => {
      let dirents;
      try {
        dirents = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of dirents) {
        if (++entries > MAX_ENTRIES) {
          truncated = true;
          return;
        }
        const abs = path.join(dir, entry.name);
        const entryBucket = bucket ?? (entry.isDirectory() ? entry.name : ROOT_FILES);
        if (entry.isDirectory()) {
          folders++;
          if (bucket === null) top.set(entry.name, { name: entry.name, bytes: 0, files: 0 });
          queue.push({ dir: abs, bucket: entryBucket });
        } else if (entry.isFile()) {
          let size: number;
          try {
            size = (await lstat(abs)).size;
          } catch {
            continue;
          }
          files++;
          bytes += size;
          const t = top.get(entryBucket) ?? { name: entryBucket, bytes: 0, files: 0 };
          t.bytes += size;
          t.files++;
          top.set(entryBucket, t);
        }
      }
    };

    pump();
  });

  const topFolders = [...top.values()].sort((a, b) => b.bytes - a.bytes).slice(0, 12);
  return {
    files,
    folders,
    bytes,
    gitBytes: top.get('.git')?.bytes ?? 0,
    topFolders,
    truncated,
  };
}
