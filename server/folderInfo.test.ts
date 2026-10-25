import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FolderInfo } from '../shared/types.js';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { FileAccessError, folderInfo } from './projectFiles.js';

// The folder previewer's data (PM-286): entries with sizes and times for one level or the whole
// tree below, bounded, read only, never leaving the project.

function tree(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-folder-'));
  const put = (rel: string, content: string, when?: string) => {
    const full = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
    if (when) utimesSync(full, new Date(when), new Date(when));
  };
  put('README.md', 'hello', '2026-10-01T00:00:00Z');
  put('assets/logo.png', 'png-bytes', '2026-10-20T10:00:00Z');
  put('assets/icons/a.svg', '<svg/>', '2026-10-25T08:30:00Z');
  put('assets/icons/b.svg', '<svg/>', '2026-10-24T08:30:00Z');
  put('node_modules/pkg/index.js', 'x');
  put('.git/HEAD', 'ref');
  return root;
}

const names = (info: FolderInfo) => info.items.map((i) => i.path).sort();

describe('folderInfo', () => {
  it('lists one level with size, modified and created times', async () => {
    const info = await folderInfo(tree(), '');
    expect(names(info)).toEqual(['README.md', 'assets', 'node_modules']);
    const readme = info.items.find((i) => i.path === 'README.md')!;
    expect(readme).toMatchObject({ kind: 'file', size: 5, mtime: '2026-10-01T00:00:00.000Z' });
    expect(readme.ctime).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(info.items.find((i) => i.path === 'assets')).toMatchObject({ kind: 'dir', size: null });
    expect(info).toMatchObject({
      recursive: false,
      files: 1,
      folders: 2,
      totalSize: 5,
      truncated: false,
    });
  });

  it('walks the whole tree below, skipping node_modules and .git, and totals the files', async () => {
    const info = await folderInfo(tree(), 'assets', { recursive: true });
    expect(names(info)).toEqual([
      'assets/icons',
      'assets/icons/a.svg',
      'assets/icons/b.svg',
      'assets/logo.png',
    ]);
    expect(info.files).toBe(3);
    expect(info.folders).toBe(1);
    expect(info.totalSize).toBe(9 + 6 + 6);
    expect(info.newest).toBe('2026-10-25T08:30:00.000Z'); // The newest file, a.svg.
    const all = await folderInfo(tree(), '', { recursive: true });
    expect(all.items.some((i) => i.path.startsWith('node_modules/pkg'))).toBe(false);
    expect(all.items.some((i) => i.path.startsWith('.git'))).toBe(false);
    // The skipped folder itself is still listed (it exists), just not entered.
    expect(all.items.some((i) => i.path === 'node_modules')).toBe(true);
  });

  it('stops at the limit and says so', async () => {
    const info = await folderInfo(tree(), '', { recursive: true, limit: 3 });
    expect(info.items).toHaveLength(3);
    expect(info.truncated).toBe(true);
    const clamped = await folderInfo(tree(), '', { limit: 0 });
    expect(clamped.items).toHaveLength(1); // A limit below 1 is raised to 1.
  });

  it('refuses a path outside the project, a missing one, and a file', async () => {
    const root = tree();
    for (const bad of ['..', '../x', 'a/../..']) {
      await expect(folderInfo(root, bad)).rejects.toBeInstanceOf(FileAccessError);
    }
    await expect(folderInfo(root, 'nope')).rejects.toMatchObject({ status: 404 });
    await expect(folderInfo(root, 'README.md')).rejects.toMatchObject({ status: 400 });
    await expect(folderInfo(root, '.git')).rejects.toMatchObject({ status: 404 });
  });

  it('lists a link as a link and never follows it out of the project', async () => {
    const root = tree();
    const outside = mkdtempSync(path.join(os.tmpdir(), 'pm-folder-out-'));
    writeFileSync(path.join(outside, 'secret.txt'), 's');
    try {
      symlinkSync(outside, path.join(root, 'assets', 'escape'), 'junction');
    } catch {
      return; // This machine may not allow links; the check above covers the rest.
    }
    const info = await folderInfo(root, 'assets', { recursive: true });
    const link = info.items.find((i) => i.path === 'assets/escape');
    expect(link).toMatchObject({ symlink: true, kind: 'file' });
    expect(info.items.some((i) => i.path.includes('secret.txt'))).toBe(false);
  });
});

describe('GET /projects/:id/folder-info', () => {
  it('answers on every listener, validates the query, and refuses a bad path', async () => {
    const db = openDb(':memory:');
    const app = createApp(db);
    const host = { host: 'localhost:5180', 'content-type': 'application/json' };
    const made = await app.request('/api/projects', {
      method: 'POST',
      headers: host,
      body: JSON.stringify({ path: tree() }),
    });
    const { id } = (await made.json()) as { id: number };
    const get = (query: string, extra: Record<string, string> = {}) =>
      app.request(`/api/projects/${id}/folder-info${query}`, { headers: { ...host, ...extra } });

    const ok = await get('?path=assets&recursive=1&limit=10');
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as FolderInfo;
    expect(body.files).toBe(3);
    // A phone on the LAN or the tunnel reads it too (it changes nothing).
    expect((await get('?path=assets', { 'x-pm-lan': '1' })).status).toBe(200);
    expect((await get('?path=../..')).status).toBe(400);
    expect((await get('?path=nope')).status).toBe(404);
    // A junk limit falls back to the default instead of failing.
    expect((await get('?path=assets&limit=abc')).status).toBe(200);
  });
});
