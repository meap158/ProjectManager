import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OutputLog } from './supervisor.js';
import { logicalSize, physicalSize, removeLog } from './logFile.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function log() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-log-'));
  dirs.push(dir);
  return new OutputLog(path.join(dir, 'output.log'));
}
function replay(output: OutputLog) {
  let offset = 0;
  let text = '';
  while (offset < output.totalBytes) {
    const next = output.read(offset);
    expect(next.nextOffset).toBeGreaterThan(offset);
    text += next.data;
    offset = next.nextOffset;
  }
  return text;
}
it('releases inactive bytes without losing replay or subsequent appends', () => {
  const output = log();
  output.append('before 😀\n');
  expect(output.releaseCache()).toBe(true);
  const cache = output as unknown as { chunks: unknown[] };
  expect(cache.chunks).toHaveLength(0);
  expect(replay(output)).toBe('before 😀\n');
  output.append('after 漢字\n');
  expect(replay(output)).toBe('before 😀\nafter 漢字\n');
});
it('keeps the memory fallback if the disk log is missing or incomplete', () => {
  const output = log();
  output.append('persisted');
  // Host mirroring can be ahead of disk visibility; never discard those bytes.
  output.ingest(output.totalBytes, ' pending');
  expect(output.releaseCache()).toBe(false);
  expect(replay(output)).toBe('persisted pending');
  rmSync(output.file);
  expect(output.releaseCache()).toBe(false);
  expect(replay(output)).toBe('persisted pending');
});
it('bounds cache allocation and object count for tiny output events', () => {
  const output = log();
  for (let i = 0; i < 100000; i++) output.ingest(i, 'x');
  const cache = output as unknown as { chunks: { data: Buffer; bytes: number }[] };
  expect(cache.chunks.length).toBe(25);
  expect(cache.chunks.reduce((n, c) => n + c.data.length, 0)).toBe(25 * 4096);
  expect(replay(output)).toBe('x'.repeat(100000));
});
it('compacts a full log without stopping output or moving offsets backwards', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-log-'));
  dirs.push(dir);
  const file = path.join(dir, 'output.log');
  const output = new OutputLog(file, undefined, 4096);
  output.append('a'.repeat(4000));
  output.append('b'.repeat(200)); // Exceeds the cap: compacts to the last 1 KB first.
  expect(output.totalBytes).toBe(4200);
  expect(physicalSize(file)).toBeLessThanOrEqual(4096);
  expect(logicalSize(file)).toBe(4200);
  expect(output.releaseCache()).toBe(true);
  // A reader behind the compacted head resumes at the head; new output is still served.
  const head = output.read(0);
  expect(head.data.endsWith('b'.repeat(200))).toBe(true);
  expect(head.nextOffset).toBe(4200);
  expect(output.read(4000).data).toBe('b'.repeat(200));
  // A fresh reader (server restart) agrees on the logical size.
  expect(new OutputLog(file).totalBytes).toBe(4200);
  removeLog(file);
  expect(logicalSize(file)).toBe(0);
});
it('caps a large append while retaining exact full disk replay and UTF-8 boundaries', () => {
  const output = log();
  const text = 'a'.repeat(4095) + '😀漢字'.repeat(60000);
  output.append(text);
  const cache = output as unknown as {
    chunks: { data: Buffer; bytes: number }[];
    baseOffset: number;
  };
  expect(cache.chunks.length).toBeLessThanOrEqual(64);
  expect(cache.chunks.reduce((n, c) => n + c.data.length, 0)).toBeLessThanOrEqual(256 * 1024);
  expect(replay(output)).toBe(text);
  // A valid character boundary in the retained tail is served from memory.
  const offset = Buffer.byteLength(text) - Buffer.byteLength('😀漢字'.repeat(10));
  expect(output.read(offset).data).toBe('😀漢字'.repeat(10));
});
