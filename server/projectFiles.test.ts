import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { FileAccessError, listFolder, previewFile, readRaw } from './projectFiles.js';

// The Files tab (PM-252): one folder at a time, folders first, .git hidden, git-ignored entries
// marked, nothing outside the project, previews capped and typed.

let root: string;
beforeAll(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pm-files-'));
  mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# Hello\n');
  writeFileSync(path.join(root, 'file10.txt'), 'ten');
  writeFileSync(path.join(root, 'file2.txt'), 'two');
  writeFileSync(path.join(root, 'src', 'index.ts'), 'export {};\n');
  writeFileSync(path.join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  writeFileSync(path.join(root, 'blob.bin'), Buffer.from([1, 2, 0, 3]));
  writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n*.bin\n');
  execFileSync('git', ['init', '-q'], { cwd: root });
});
// The app in the route test scans the folder in the background and may still hold it: a temp
// folder left behind is harmless.
afterAll(() => {
  try {
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Still busy.
  }
});

describe('listFolder', () => {
  it('lists folders first, by name with numbers in order, .git hidden, ignored marked', async () => {
    const { entries, path: at } = await listFolder(root, '');
    expect(at).toBe('');
    expect(entries.map((e) => e.name)).toEqual([
      'node_modules',
      'src',
      '.gitignore',
      'blob.bin',
      'file2.txt',
      'file10.txt',
      'logo.png',
      'README.md',
    ]);
    const by = Object.fromEntries(entries.map((e) => [e.name, e]));
    expect(by.node_modules).toMatchObject({ kind: 'dir', ignored: true });
    expect(by['blob.bin']).toMatchObject({ kind: 'file', ignored: true, size: 4 });
    expect(by['README.md']).toMatchObject({ ignored: false, path: 'README.md' });
  });

  it('opens a sub folder by its relative path', async () => {
    const { entries } = await listFolder(root, 'src');
    expect(entries.map((e) => [e.path, e.kind])).toEqual([
      ['src/deep', 'dir'],
      ['src/index.ts', 'file'],
    ]);
  });

  it('refuses paths outside the project, and .git', async () => {
    for (const bad of ['..', '../..', 'src/../../x', '.git', 'src/.git']) {
      await expect(listFolder(root, bad)).rejects.toBeInstanceOf(FileAccessError);
    }
  });
});

describe('previewFile', () => {
  it('returns text, and says what other files are', async () => {
    expect(await previewFile(root, 'README.md')).toMatchObject({
      kind: 'text',
      content: '# Hello\n',
      size: 8,
    });
    expect((await previewFile(root, 'logo.png')).kind).toBe('image');
    expect((await previewFile(root, 'blob.bin')).kind).toBe('binary');
    await expect(previewFile(root, 'src')).rejects.toMatchObject({ status: 400 });
    await expect(previewFile(root, 'missing.txt')).rejects.toMatchObject({ status: 404 });
  });

  it('reads raw bytes with a type for images', async () => {
    const raw = await readRaw(root, 'logo.png');
    expect(raw.type).toBe('image/png');
    expect(raw.bytes.length).toBe(6);
  });
});

describe('routes', () => {
  it('serves the tree, previews and raw bytes, raw never runnable on this origin', async () => {
    const db = openDb(':memory:');
    const app = createApp(db);
    const host = { host: 'localhost:5180' };
    const created = await app.request('/api/projects', {
      method: 'POST',
      headers: { ...host, 'content-type': 'application/json' },
      body: JSON.stringify({ path: root }),
    });
    const { id } = (await created.json()) as { id: number };
    const tree = await app.request(`/api/projects/${id}/tree?path=src`, { headers: host });
    expect(((await tree.json()) as { entries: unknown[] }).entries).toHaveLength(2);
    const raw = await app.request(`/api/projects/${id}/raw?path=logo.png`, { headers: host });
    expect(raw.headers.get('content-security-policy')).toMatch(/^sandbox/);
    expect(raw.headers.get('x-content-type-options')).toBe('nosniff');
    const outside = await app.request(`/api/projects/${id}/file?path=../x`, { headers: host });
    expect(outside.status).toBe(400);
    await app.supervisor.shutdown();
    db.close();
  });
});
