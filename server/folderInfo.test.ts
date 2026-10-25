import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FolderInfo } from '../shared/types.js';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { FileAccessError, folderInfo, gitMarkOf } from './projectFiles.js';

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

describe('folderInfo extras', () => {
  const png = (w: number, h: number) =>
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]),
      Buffer.from('IHDR'),
      Buffer.from([w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255]),
      Buffer.from([h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255]),
      Buffer.alloc(9),
    ]);

  it('reads the pixel size of pictures from their headers, and nothing for other files', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pm-folder-dim-'));
    writeFileSync(path.join(root, 'a.png'), png(640, 480));
    writeFileSync(path.join(root, 'b.svg'), '<svg width="32" height="16"></svg>');
    writeFileSync(path.join(root, 'broken.png'), 'not really a png');
    writeFileSync(path.join(root, 'notes.md'), '# hi');
    const info = await folderInfo(root, '');
    const by = (name: string) => info.items.find((i) => i.name === name)!;
    expect([by('a.png').width, by('a.png').height]).toEqual([640, 480]);
    expect([by('b.svg').width, by('b.svg').height]).toEqual([32, 16]);
    expect([by('broken.png').width, by('broken.png').height]).toEqual([null, null]);
    expect(by('notes.md').width).toBeNull();
  });

  it('classifies git status codes', () => {
    expect(gitMarkOf('??')).toBe('untracked');
    expect(gitMarkOf(' M')).toBe('modified');
    expect(gitMarkOf('MM')).toBe('modified');
    expect(gitMarkOf('A ')).toBe('added');
    expect(gitMarkOf('UU')).toBe('conflict');
    expect(gitMarkOf('AA')).toBe('conflict');
    expect(gitMarkOf(' D')).toBe('modified');
  });

  it('marks what differs from the last commit, folders included, with one status for the listing', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pm-folder-git-'));
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
        cwd: root,
        stdio: 'ignore',
      });
    const put = (rel: string, text: string) => {
      const full = path.join(root, ...rel.split('/'));
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, text);
    };
    git('init', '-q');
    put('kept.md', 'one');
    put('changed.md', 'one');
    put('assets/inside.md', 'one');
    put('quiet/fine.md', 'one');
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    put('changed.md', 'two');
    put('assets/inside.md', 'two');
    put('fresh.md', 'new');
    put('newdir/a.md', 'new');
    put('staged.md', 'staged');
    git('add', 'staged.md');

    const info = await folderInfo(root, '');
    const mark = (name: string) => info.items.find((i) => i.name === name)?.git;
    expect(mark('kept.md')).toBeNull();
    expect(mark('changed.md')).toBe('modified');
    expect(mark('fresh.md')).toBe('untracked');
    expect(mark('staged.md')).toBe('added');
    expect(mark('assets')).toBe('modified'); // Something inside changed.
    expect(mark('newdir')).toBe('untracked'); // Everything inside is new.
    expect(mark('quiet')).toBeNull();
    // A listing of a subfolder is marked relative to it.
    const inner = await folderInfo(root, 'assets');
    expect(inner.items.find((i) => i.name === 'inside.md')?.git).toBe('modified');
  });

  it('gives no marks, and no error, outside a git repository', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'pm-folder-nogit-'));
    writeFileSync(path.join(root, 'a.md'), 'x');
    const info = await folderInfo(root, '');
    expect(info.items[0]!.git).toBeNull();
  });
});

describe('GET /projects/:id/raw validators', () => {
  it('answers a repeat request for an unchanged file with an empty 304, and sends the bytes again after a change', async () => {
    const root = tree();
    const db = openDb(':memory:');
    const app = createApp(db);
    const host = { host: 'localhost:5180', 'content-type': 'application/json' };
    const made = await app.request('/api/projects', {
      method: 'POST',
      headers: host,
      body: JSON.stringify({ path: root }),
    });
    const { id } = (await made.json()) as { id: number };
    const get = (headers: Record<string, string> = {}) =>
      app.request(`/api/projects/${id}/raw?path=${encodeURIComponent('assets/logo.png')}`, {
        headers: { host: host.host, ...headers },
      });
    const first = await get();
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"[0-9a-f]+-[0-9a-f]+"$/);
    expect(first.headers.get('cache-control')).toBe('private, no-cache'); // Always revalidated.
    const again = await get({ 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect((await again.arrayBuffer()).byteLength).toBe(0);
    expect(again.headers.get('etag')).toBe(etag);
    // The file changes: the old validator no longer matches.
    writeFileSync(path.join(root, 'assets', 'logo.png'), 'changed-bytes-longer');
    expect((await get({ 'if-none-match': etag })).status).toBe(200);
    // A different validator, or none, gets the file.
    expect((await get({ 'if-none-match': 'W/"nope"' })).status).toBe(200);
  });
});
