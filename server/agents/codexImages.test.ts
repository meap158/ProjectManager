import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { IMAGE_NOTE, KEEP_IMAGES, lastCompactionOffset, slimResumeImages } from './codexImages.js';

// PM-276: a relaunched Codex re-sends its whole history; too many screenshots and the request is
// dropped. The rollout gets one appended compaction record with the newest screenshots only.

let dir = '';
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = '';
});

const file = (lines: unknown[], trailingNewline = true) => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pm-codex-images-'));
  const target = path.join(dir, 'rollout-2026-01-01T00-00-00-0000.jsonl');
  writeFileSync(
    target,
    lines.map((l) => JSON.stringify(l)).join('\n') + (trailingNewline ? '\n' : ''),
  );
  return target;
};
/** A screenshot of about `mb` megabytes as a data URL. */
const image = (mb: number, tag: string) => ({
  type: 'input_image',
  image_url: `data:image/png;base64,${tag}${'A'.repeat(Math.round(mb * 1024 * 1024))}`,
});
const shot = (ordinal: number, mb: number) => ({
  timestamp: 't',
  ordinal,
  type: 'response_item',
  payload: {
    type: 'function_call_output',
    call_id: `c${ordinal}`,
    output: [{ type: 'input_text', text: 'screenshot' }, image(mb, `IMG${ordinal}`)],
  },
});
const say = (ordinal: number, text: string) => ({
  timestamp: 't',
  ordinal,
  type: 'response_item',
  payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
});
const records = (target: string) =>
  readFileSync(target, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; ordinal?: number; payload: never });

describe('slimResumeImages', () => {
  it('leaves a conversation with few screenshots alone', async () => {
    const target = file([say(1, 'hi'), shot(2, 1), shot(3, 1)]);
    const before = readFileSync(target, 'utf8');
    expect(await slimResumeImages(target)).toBeNull();
    expect(readFileSync(target, 'utf8')).toBe(before);
  });

  it('appends a compaction keeping only the newest screenshots, originals untouched', async () => {
    const lines = [say(1, 'start'), ...[2, 3, 4, 5, 6, 7].map((o) => shot(o, 1.5)), say(8, 'go')];
    const target = file(lines);
    const before = readFileSync(target, 'utf8');
    const result = await slimResumeImages(target);
    expect(result).toMatchObject({ images: 6, removed: 4 });
    const after = readFileSync(target, 'utf8');
    expect(after.startsWith(before)).toBe(true); // Nothing above the new record changed.
    const added = records(target).pop()!;
    expect(added.type).toBe('compacted');
    expect(added.ordinal).toBe(9);
    const history = (added.payload as { replacement_history: unknown[] }).replacement_history;
    expect(history).toHaveLength(lines.length);
    const text = JSON.stringify(history);
    // 4 MB keeps the two newest 1.5 MB screenshots (a third would pass the byte budget).
    expect(text.includes('IMG7A') && text.includes('IMG6A')).toBe(true);
    expect(['IMG2A', 'IMG3A', 'IMG4A', 'IMG5A'].some((tag) => text.includes(tag))).toBe(false);
    expect(text.split(IMAGE_NOTE).length - 1).toBe(4);
    expect(KEEP_IMAGES).toBeGreaterThanOrEqual(2);
  });

  it('rebuilds from the last compaction, not from the start', async () => {
    const compacted = {
      timestamp: 't',
      ordinal: 10,
      type: 'compacted',
      payload: {
        message: '',
        replacement_history: [say(0, 'summary').payload, shot(0, 3).payload],
      },
    };
    const target = file([
      shot(1, 5),
      shot(2, 5),
      compacted,
      shot(11, 3),
      shot(12, 3),
      say(13, 'x'),
    ]);
    const result = await slimResumeImages(target);
    expect(result).toMatchObject({ images: 3, removed: 2 });
    const history = JSON.stringify(
      (records(target).pop()!.payload as { replacement_history: unknown[] }).replacement_history,
    );
    // Tags end where the filler starts ('A'), so IMG1A is not IMG11A.
    expect(history.includes('IMG1A') || history.includes('IMG2A')).toBe(false); // Before compaction.
    expect(history.includes('summary')).toBe(true);
    expect(history.includes('IMG12A')).toBe(true);
  });

  it('skips a rollout that is still being written', async () => {
    const target = file([...[1, 2, 3, 4, 5, 6].map((o) => shot(o, 2))], false);
    expect(await slimResumeImages(target)).toBeNull();
  });

  it('a second relaunch does not stack another record when nothing new was added', async () => {
    const target = file([...[1, 2, 3, 4, 5, 6].map((o) => shot(o, 2))]);
    expect(await slimResumeImages(target)).not.toBeNull();
    const size = readFileSync(target).length;
    expect(await slimResumeImages(target)).toBeNull();
    expect(readFileSync(target).length).toBe(size);
  });
});

describe('lastCompactionOffset', () => {
  it('finds the last compaction line across read chunks, or 0', async () => {
    const big = say(1, 'x'.repeat(9 * 1024 * 1024)); // Larger than one backwards read.
    const compacted = { timestamp: 't', type: 'compacted', payload: { replacement_history: [] } };
    const target = file([compacted, big, compacted, big, say(3, 'end')]);
    const text = readFileSync(target, 'utf8');
    const offset = await lastCompactionOffset(target);
    expect(text.slice(offset, offset + 60)).toContain('"compacted"');
    expect(offset).toBeGreaterThan(9 * 1024 * 1024);
    expect(await lastCompactionOffset(file([say(1, 'a'), say(2, 'b')]))).toBe(0);
  });
});
