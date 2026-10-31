import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { folderSnapshot } from './folderSnapshot.js';

afterEach(() => vi.restoreAllMocks());
function tree() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-snapshot-'));
  mkdirSync(path.join(root, 'nested'));
  mkdirSync(path.join(root, '.git'));
  mkdirSync(path.join(root, 'node_modules'));
  for (let i = 0; i < 40; i++) writeFileSync(path.join(root, `file${i}.txt`), 'text');
  writeFileSync(path.join(root, 'nested', 'later.txt'), 'nested');
  writeFileSync(path.join(root, '.git', 'secret'), 'hidden');
  writeFileSync(path.join(root, 'node_modules', 'ignored'), 'hidden');
  return root;
}
it('shares scans across simultaneous requests, continuation pages and type filters', async () => {
  const root = tree();
  const a = folderSnapshot(root, root, true, 0, false);
  const b = folderSnapshot(root, root, true, 2000, false);
  expect(a).toBe(b);
  const snapshot = await a;
  expect(await folderSnapshot(root, root, true, 4000, false)).toBe(snapshot);
  expect(snapshot.entries).toHaveLength(43);
  expect(snapshot.entries.some(({ item }) => item.path === 'nested/later.txt')).toBe(true);
  expect(snapshot.entries.some(({ item }) => item.path.startsWith('.git'))).toBe(false);
  expect(snapshot.entries.some(({ item }) => item.path.startsWith('node_modules/'))).toBe(false);
  expect(new Set(snapshot.entries.map(({ index }) => index)).size).toBe(43);
});
it('refresh bypasses a recent snapshot and normal reads expire after thirty seconds', async () => {
  const root = tree();
  const initial = await folderSnapshot(root, root, false, 0, false);
  writeFileSync(path.join(root, 'new.txt'), 'new');
  expect(await folderSnapshot(root, root, false, 0, false)).toBe(initial);
  const fresh = await folderSnapshot(root, root, false, 0, true);
  expect(fresh.entries).toHaveLength(initial.entries.length + 1);
  const later = Date.now() + 31_000;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  expect(await folderSnapshot(root, root, false, 0, false)).not.toBe(fresh);
});
it('keeps at most three scope snapshots', async () => {
  const root = tree();
  const first = await folderSnapshot(root, root, false, 0, false);
  for (let i = 0; i < 3; i++) {
    const dir = path.join(root, `scope${i}`);
    mkdirSync(dir);
    await folderSnapshot(root, dir, false, 0, false);
  }
  expect(await folderSnapshot(root, root, false, 0, false)).not.toBe(first);
});
