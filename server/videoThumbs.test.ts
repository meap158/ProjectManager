import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { VideoThumbs } from './videoThumbs.js';

// Video thumbnails (PM-647): a frame made once and cached, nothing written in the project.

const ffmpegAvailable = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

const root = mkdtempSync(path.join(os.tmpdir(), 'pm-thumbs-project-'));
const cache = mkdtempSync(path.join(os.tmpdir(), 'pm-thumbs-cache-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(cache, { recursive: true, force: true });
});

describe('VideoThumbs', () => {
  it('refuses paths that are not videos or leave the project', async () => {
    writeFileSync(path.join(root, 'notes.txt'), 'hi');
    const thumbs = new VideoThumbs(cache);
    await expect(thumbs.thumb(root, 'notes.txt')).rejects.toThrow('Not a video file');
    await expect(thumbs.thumb(root, '../outside.mp4')).rejects.toThrow();
  });

  it('answers null without ffmpeg, and stops trying', async () => {
    writeFileSync(path.join(root, 'broken.mp4'), 'not a video');
    const thumbs = new VideoThumbs(cache, path.join(root, 'no-such-ffmpeg.exe'));
    expect(await thumbs.thumb(root, 'broken.mp4')).toBeNull();
    expect(await thumbs.thumb(root, 'broken.mp4')).toBeNull();
  });

  it.skipIf(!ffmpegAvailable)('makes a JPEG frame once and serves it from the cache', async () => {
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc=size=640x360:rate=10:duration=0.5',
        '-pix_fmt',
        'yuv420p',
        '-y',
        path.join(root, 'short.mp4'),
      ],
      { windowsHide: true },
    );
    const before = readdirSync(root).sort();
    const thumbs = new VideoThumbs(cache);
    // Shorter than the one-second seek: falls back to the first frame.
    const first = await thumbs.thumb(root, 'short.mp4');
    expect(first).not.toBeNull();
    expect(first!.bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
    expect(readdirSync(cache).filter((f) => f.endsWith('.jpg'))).toHaveLength(1);
    const again = await new VideoThumbs(cache, path.join(root, 'no-such-ffmpeg.exe')).thumb(
      root,
      'short.mp4',
    );
    expect(again?.etag).toBe(first!.etag);
    expect(readdirSync(root).sort()).toEqual(before);
  });

  it('keeps the newest frames once the folder passes its cap, and nothing else', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-thumbs-prune-'));
    try {
      const names = ['a', 'b', 'c', 'd'].map((c) => `${c.repeat(32)}.jpg`);
      names.forEach((name, i) => {
        const file = path.join(dir, name);
        writeFileSync(file, 'x');
        utimesSync(file, 1000 + i, 1000 + i);
      });
      writeFileSync(path.join(dir, 'notes.txt'), 'kept');
      await new VideoThumbs(dir, 'ffmpeg', { maxFiles: 2, pruneEvery: 1 }).prune();
      expect(readdirSync(dir).sort()).toEqual([names[2], names[3], 'notes.txt']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!ffmpegAvailable)('remembers a file ffmpeg cannot read', async () => {
    writeFileSync(path.join(root, 'junk.mp4'), 'not a video');
    const thumbs = new VideoThumbs(cache);
    expect(await thumbs.thumb(root, 'junk.mp4')).toBeNull();
    expect(await thumbs.thumb(root, 'junk.mp4')).toBeNull();
  });
});
