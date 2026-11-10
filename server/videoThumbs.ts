import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { mediaKind } from '../shared/media.js';
import { FileAccessError, resolveInside } from './projectFiles.js';

/*
 * Video thumbnails for the Files tab (PM-647): one small JPEG frame per video, made once by
 * ffmpeg and kept on disk, so the grid never reads a whole video to show a picture of it.
 *
 * - The cache key is the file's absolute path, size and modified time: an edited video gets a
 *   new frame, an unchanged one is never decoded again.
 * - At most two ffmpeg processes run at once and each has a time limit, so opening a folder of
 *   200 videos queues work instead of starting 200 decoders.
 * - Without ffmpeg (or for a file it cannot read) the answer is 404 and the grid keeps its icon.
 *   A failure is remembered for the same key, so it is not retried on every scroll.
 * - Project files are only read, never written: frames go to the app's own data folder.
 * - The folder is capped: past MAX_FILES frames (about 10 KB each), the oldest are removed. It is
 *   checked on the first frame made after a start and then every PRUNE_EVERY frames, never on a
 *   read, so showing a grid stays a plain file read.
 */

const WIDTH = 320;
const MAX_RUNNING = 2;
const TIMEOUT_MS = 20_000;
const MAX_FILES = 5000;
const PRUNE_EVERY = 100;

export type ThumbResult = { bytes: Buffer; etag: string };

export class VideoThumbs {
  private running = 0;
  private readonly queue: (() => void)[] = [];
  private readonly pending = new Map<string, Promise<Buffer | null>>();
  private readonly failed = new Set<string>();
  private missingFfmpeg = false;
  private made = 0;

  constructor(
    private readonly cacheDir: string,
    private readonly ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg',
    private readonly limits = { maxFiles: MAX_FILES, pruneEvery: PRUNE_EVERY },
  ) {}

  /** Removes the oldest frames once the folder holds more than the cap. */
  async prune(): Promise<void> {
    const names = (await readdir(this.cacheDir).catch(() => [] as string[])).filter((n) =>
      /^[0-9a-f]{32}\.jpg$/.test(n),
    );
    if (names.length <= this.limits.maxFiles) return;
    const dated = await Promise.all(
      names.map(async (name) => {
        const file = path.join(this.cacheDir, name);
        const info = await stat(file).catch(() => null);
        return { file, at: info?.mtimeMs ?? 0 };
      }),
    );
    dated.sort((a, b) => a.at - b.at);
    for (const { file } of dated.slice(0, dated.length - this.limits.maxFiles))
      await rm(file, { force: true });
  }

  /** The frame for a video in the project, or null when none can be made. */
  async thumb(root: string, rel: string): Promise<ThumbResult | null> {
    const abs = await resolveInside(root, rel);
    if (mediaKind(abs) !== 'video') throw new FileAccessError(400, 'Not a video file');
    const info = await stat(abs);
    if (!info.isFile()) throw new FileAccessError(400, 'Not a file');
    const key = createHash('sha1')
      .update(`${abs}\0${info.size}\0${info.mtimeMs}`)
      .digest('hex')
      .slice(0, 32);
    const etag = `"t-${key}"`;
    if (this.missingFfmpeg || this.failed.has(key)) return null;
    const file = path.join(this.cacheDir, `${key}.jpg`);
    const cached = await readFile(file).catch(() => null);
    if (cached) return { bytes: cached, etag };
    let job = this.pending.get(key);
    if (!job) {
      job = this.limited(() => this.make(abs, file)).finally(() => this.pending.delete(key));
      this.pending.set(key, job);
    }
    const bytes = await job;
    if (!bytes) {
      this.failed.add(key);
      return null;
    }
    return { bytes, etag };
  }

  private async limited<T>(run: () => Promise<T>): Promise<T> {
    if (this.running >= MAX_RUNNING) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.running++;
    try {
      return await run();
    } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  private async make(abs: string, file: string): Promise<Buffer | null> {
    await mkdir(this.cacheDir, { recursive: true });
    // Written beside the final name and renamed, so a half-written frame is never served.
    const temp = `${file}.${process.pid}.tmp.jpg`;
    try {
      // One second in skips a black first frame; a clip shorter than that takes its first frame.
      for (const at of ['1', '0']) {
        if (!(await this.frame(abs, temp, at))) continue;
        const bytes = await readFile(temp).catch(() => null);
        if (bytes && bytes.length > 0) {
          await rename(temp, file);
          if (this.made++ % this.limits.pruneEvery === 0)
            await this.prune().catch((error: unknown) =>
              console.warn('[files] video thumbnail cache cleanup failed', error),
            );
          return bytes;
        }
      }
      return null;
    } finally {
      await rm(temp, { force: true });
    }
  }

  private frame(abs: string, out: string, at: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(
        this.ffmpeg,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-nostdin',
          '-ss',
          at,
          '-i',
          abs,
          '-frames:v',
          '1',
          '-vf',
          `scale='min(${WIDTH},iw)':-2`,
          '-q:v',
          '5',
          '-f',
          'image2',
          '-y',
          out,
        ],
        { timeout: TIMEOUT_MS, windowsHide: true },
        (error) => {
          if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            // No ffmpeg on this computer: stop trying until the app restarts.
            this.missingFfmpeg = true;
            console.warn('[files] ffmpeg not found; video thumbnails are off');
          }
          resolve(!error);
        },
      );
    });
  }
}
