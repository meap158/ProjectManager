import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { invalidName, openCommand, openEntry, renameEntry } from './projectFileActions.js';
import { FileAccessError } from './projectFiles.js';

// The Files context menu (PM-259): rename stays in its folder and never overwrites, .git is off
// limits, links out are refused, runnable files are never started, and only this computer asks.

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'pm-actions-'));
  outside = mkdtempSync(path.join(os.tmpdir(), 'pm-actions-out-'));
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, '.git'), { recursive: true });
  writeFileSync(path.join(root, 'README.md'), '# hi');
  writeFileSync(path.join(root, 'LICENSE'), 'MIT');
  writeFileSync(path.join(root, 'taken.txt'), 'x');
  writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
  writeFileSync(path.join(root, '.git', 'HEAD'), 'ref');
  writeFileSync(path.join(root, 'run.bat'), 'echo');
  writeFileSync(path.join(outside, 'secret.txt'), 's');
});
afterAll(() => {
  // Temp folders are left behind on purpose: a background scan may still hold them on Windows.
});

const status = async (p: Promise<unknown>) =>
  p.then(
    () => 0,
    (e: unknown) => (e instanceof FileAccessError ? e.status : -1),
  );

describe('invalidName', () => {
  it('accepts ordinary names, dotfiles and names with spaces', () => {
    for (const name of ['a.txt', 'My notes.md', '.env.example', 'LICENSE', 'v1.2.3'])
      expect(invalidName(name)).toBeNull();
  });
  it('refuses paths, separators, reserved and unsafe names', () => {
    for (const name of [
      '',
      ' ',
      ' a',
      'a ',
      '.',
      '..',
      'a/b',
      'a\\b',
      '..\\x',
      'a:b',
      'a*b',
      'a?b',
      'a|b',
      'a\u0000b',
      'a.',
      'con',
      'NUL.txt',
      'com1',
      '.git',
      '.GIT',
      'x'.repeat(256),
    ])
      expect(invalidName(name), JSON.stringify(name)).not.toBeNull();
  });
});

describe('renameEntry', () => {
  it('renames a file and a folder in place and returns the new relative path', async () => {
    expect(await renameEntry(root, 'README.md', 'GUIDE.md')).toBe('GUIDE.md');
    expect(existsSync(path.join(root, 'GUIDE.md'))).toBe(true);
    expect(existsSync(path.join(root, 'README.md'))).toBe(false);
    expect(await renameEntry(root, 'src/a.ts', 'b.ts')).toBe('src/b.ts');
    expect(await renameEntry(root, 'src', 'lib')).toBe('lib');
    expect(existsSync(path.join(root, 'lib', 'b.ts'))).toBe(true);
  });

  it('never overwrites an existing entry', async () => {
    expect(await status(renameEntry(root, 'README.md', 'taken.txt'))).toBe(409);
    expect(existsSync(path.join(root, 'README.md'))).toBe(true);
  });

  it('allows a change of letter case alone', async () => {
    expect(await renameEntry(root, 'LICENSE', 'License')).toBe('License');
  });

  it('refuses names that are not one plain name', async () => {
    for (const name of ['../x', 'a/b', '', '.git', 'con'])
      expect(await status(renameEntry(root, 'README.md', name)), name).toBe(400);
    expect(existsSync(path.join(root, 'README.md'))).toBe(true);
  });

  it('refuses the project folder, .git and anything inside it, and paths that leave the project', async () => {
    expect(await status(renameEntry(root, '', 'x'))).toBe(400);
    expect(await status(renameEntry(root, '.git', 'x'))).toBe(404);
    expect(await status(renameEntry(root, '.git/HEAD', 'x'))).toBe(404);
    expect(await status(renameEntry(root, '../pm-actions-out', 'x'))).toBe(400);
    expect(await status(renameEntry(root, 'nope.txt', 'x'))).toBe(404);
    expect(existsSync(path.join(root, '.git', 'HEAD'))).toBe(true);
  });

  it('refuses to rename through a link that leaves the project', async () => {
    try {
      symlinkSync(outside, path.join(root, 'escape'), 'junction');
    } catch {
      return; // links not allowed on this machine: nothing to test
    }
    expect(await status(renameEntry(root, 'escape/secret.txt', 'x.txt'))).toBe(400);
    expect(existsSync(path.join(outside, 'secret.txt'))).toBe(true);
    // The link itself, inside the project, can be renamed; its target is untouched.
    expect(await renameEntry(root, 'escape', 'elsewhere')).toBe('elsewhere');
    expect(existsSync(path.join(outside, 'secret.txt'))).toBe(true);
  });
});

describe('openCommand', () => {
  it('builds argument arrays per platform, never a shell string', () => {
    expect(openCommand('win32', 'S:\\p\\a b.md', 'open', false)).toEqual({
      command: 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', 'S:\\p\\a b.md'],
      verbatim: false,
    });
    expect(openCommand('win32', 'S:\\p\\a b.md', 'reveal', false)).toEqual({
      command: 'explorer.exe',
      args: ['/select,"S:\\p\\a b.md"'],
      verbatim: true,
    });
    expect(openCommand('win32', 'S:\\p\\src', 'open', true).command).toBe('explorer.exe');
    expect(openCommand('darwin', '/p/a.md', 'reveal', false).args).toEqual(['-R', '/p/a.md']);
    expect(openCommand('linux', '/p/a.md', 'reveal', false).args).toEqual(['/p']);
    expect(openCommand('linux', '/p/src', 'reveal', true).args).toEqual(['/p/src']);
  });
});

describe('openEntry', () => {
  it('launches an explicitly requested batch file with its own working directory and no shell interpolation', async () => {
    const launch = vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }));
    await openEntry(
      root,
      'run.bat',
      'run',
      'win32',
      launch as unknown as typeof import('node:child_process').spawn,
    );
    expect(launch).toHaveBeenCalledWith(
      'rundll32.exe',
      ['url.dll,FileProtocolHandler', path.join(root, 'run.bat')],
      expect.objectContaining({ cwd: root, windowsHide: false, windowsVerbatimArguments: false }),
    );
    expect(await status(openEntry(root, 'run.bat', 'run', 'linux'))).toBe(400);
    expect(await status(openEntry(root, '.git/HEAD', 'run', 'win32'))).toBe(404);
  });
  it('never starts a file the system would run, and keeps inside the project', async () => {
    expect(await status(openEntry(root, 'run.bat', 'open'))).toBe(400);
    expect(await status(openEntry(root, '../x', 'open'))).toBe(400);
    expect(await status(openEntry(root, '.git/HEAD', 'reveal'))).toBe(404);
    expect(await status(openEntry(root, 'missing.txt', 'open'))).toBe(404);
  });
});

describe('routes', () => {
  it('answer on this computer only, and rename through the API', async () => {
    const db = openDb(':memory:');
    const app = createApp(db);
    const host = { host: 'localhost:5180', 'content-type': 'application/json' };
    const created = await app.request('/api/projects', {
      method: 'POST',
      headers: host,
      body: JSON.stringify({ path: root }),
    });
    const { id } = (await created.json()) as { id: number };
    const call = (route: string, body: unknown, extra: Record<string, string> = {}) =>
      app.request(`/api/projects/${id}/files/${route}`, {
        method: 'POST',
        headers: { ...host, ...extra },
        body: JSON.stringify(body),
      });

    const lan = await call('rename', { path: 'README.md', name: 'x.md' }, { 'x-pm-lan': '1' });
    expect(lan.status).toBe(403);
    const remote = await call('open', { path: 'README.md', mode: 'open' }, { 'x-pm-remote': '1' });
    expect(remote.status).toBe(403);
    // Run in terminal answers a remote session (it reaches the launcher check: README.md is not
    // a .bat, so 400, not 403), but never a LAN device.
    const remoteRun = await call(
      'open',
      { path: 'README.md', mode: 'run' },
      { 'x-pm-remote': '1', 'x-pm-lan': '1' },
    );
    expect(remoteRun.status).toBe(400);
    const lanRun = await call('open', { path: 'README.md', mode: 'run' }, { 'x-pm-lan': '1' });
    expect(lanRun.status).toBe(403);
    expect(existsSync(path.join(root, 'README.md'))).toBe(true);

    const ok = await call('rename', { path: 'README.md', name: 'GUIDE.md' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ path: 'GUIDE.md' });
    const clash = await call('rename', { path: 'GUIDE.md', name: 'taken.txt' });
    expect(clash.status).toBe(409);
    const bad = await call('rename', { path: 'GUIDE.md', name: '../x' });
    expect(bad.status).toBe(400);
    await app.supervisor.shutdown();
    db.close();
    rmSync(outside, { recursive: true, force: true });
  });
});
