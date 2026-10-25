import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { FilePin } from '../shared/types.js';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { MAX_PINS_PER_SCOPE, cleanPinPath } from './store.js';

// Pinned files and folders on the Files tab (PM-284): a pin is a validated relative path kept in
// this app's database, for one project or (by relative path) for every project.

describe('cleanPinPath', () => {
  it('keeps plain relative paths and tidies the edges', () => {
    expect(cleanPinPath('docs/ROADMAP.md')).toBe('docs/ROADMAP.md');
    expect(cleanPinPath('  ./docs/ ')).toBe('docs');
    expect(cleanPinPath('src//')).toBe('src');
    expect(cleanPinPath('.github')).toBe('.github');
    expect(cleanPinPath('My notes/a b.md')).toBe('My notes/a b.md');
  });

  it('refuses anything that could leave the project or is not a path', () => {
    for (const bad of [
      '',
      '   ',
      '/etc/passwd',
      '../x',
      'a/../b',
      'a/./b',
      'a//b',
      'C:/Windows',
      'a\\b',
      'a:b',
      'a\u0000b',
      'x'.repeat(501),
    ]) {
      expect(() => cleanPinPath(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

function setup() {
  const mk = (files: string[]) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-pins-'));
    for (const file of files) {
      const full = path.join(dir, ...file.split('/'));
      mkdirSync(path.dirname(full), { recursive: true });
      if (!file.endsWith('/')) writeFileSync(full, 'x');
    }
    mkdirSync(path.join(dir, 'docs'), { recursive: true });
    return dir;
  };
  const db = openDb(':memory:');
  const app = createApp(db);
  const host = { host: 'localhost:5180', 'content-type': 'application/json' };
  const call = (method: string, url: string, body?: unknown, extra: Record<string, string> = {}) =>
    app.request(`/api${url}`, {
      method,
      headers: { ...host, ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const project = async (dir: string) =>
    ((await (await call('POST', '/projects', { path: dir })).json()) as { id: number }).id;
  const pins = async (id: number) =>
    ((await (await call('GET', `/projects/${id}/file-pins`)).json()) as { pins: FilePin[] }).pins;
  return { call, project, pins, mk };
}

describe('file pins API', () => {
  it('pins one project’s path, shows what is there, and unpins', async () => {
    const t = setup();
    const a = await t.project(t.mk(['ROADMAP.md', 'docs/guide.md']));
    const b = await t.project(t.mk(['README.md']));

    const added = await t.call('POST', `/projects/${a}/file-pins`, {
      path: 'ROADMAP.md',
      scope: 'project',
    });
    expect(added.status).toBe(201);
    const { id } = (await added.json()) as { id: number };
    expect(await t.pins(a)).toEqual([{ id, path: 'ROADMAP.md', scope: 'project', kind: 'file' }]);
    expect(await t.pins(b)).toEqual([]); // Another project does not see it.

    // The same path again is the same pin, not a duplicate.
    const again = await t.call('POST', `/projects/${a}/file-pins`, {
      path: './ROADMAP.md',
      scope: 'project',
    });
    expect(((await again.json()) as { id: number }).id).toBe(id);
    expect(await t.pins(a)).toHaveLength(1);

    expect((await t.call('DELETE', `/file-pins/${id}`)).status).toBe(204);
    expect(await t.pins(a)).toEqual([]);
    expect((await t.call('DELETE', `/file-pins/${id}`)).status).toBe(404);
  });

  it('an all-projects pin shows in every project, marked missing where the path is absent', async () => {
    const t = setup();
    const a = await t.project(t.mk(['ROADMAP.md']));
    const b = await t.project(t.mk(['README.md']));
    const added = await t.call('POST', `/projects/${a}/file-pins`, {
      path: 'ROADMAP.md',
      scope: 'all',
    });
    const { id } = (await added.json()) as { id: number };
    expect(await t.pins(a)).toEqual([{ id, path: 'ROADMAP.md', scope: 'all', kind: 'file' }]);
    // It follows the relative path: project b has no ROADMAP.md, so it is listed with no kind.
    expect(await t.pins(b)).toEqual([{ id, path: 'ROADMAP.md', scope: 'all', kind: null }]);
  });

  it('lists a project’s own pins first, then the all-projects ones, in the user’s order', async () => {
    const t = setup();
    const a = await t.project(t.mk(['one.md', 'two.md', 'three.md']));
    const pin = async (p: string, scope: 'project' | 'all') =>
      (
        (await (await t.call('POST', `/projects/${a}/file-pins`, { path: p, scope })).json()) as {
          id: number;
        }
      ).id;
    const g = await pin('three.md', 'all');
    const one = await pin('one.md', 'project');
    const two = await pin('two.md', 'project');
    expect((await t.pins(a)).map((p) => p.id)).toEqual([one, two, g]);
    expect((await t.call('POST', `/file-pins/${two}/move`, { direction: 'up' })).status).toBe(204);
    expect((await t.pins(a)).map((p) => p.id)).toEqual([two, one, g]);
    // At an end there is nothing to swap with; it stays put without an error.
    await t.call('POST', `/file-pins/${two}/move`, { direction: 'up' });
    expect((await t.pins(a)).map((p) => p.id)).toEqual([two, one, g]);
    await t.call('POST', `/file-pins/${g}/move`, { direction: 'down' });
    expect((await t.pins(a)).map((p) => p.id)).toEqual([two, one, g]);
  });

  it('refuses unsafe or absent paths, and caps each scope', async () => {
    const t = setup();
    const a = await t.project(t.mk(['ok.md']));
    const post = (p: string, scope: 'project' | 'all' = 'project') =>
      t.call('POST', `/projects/${a}/file-pins`, { path: p, scope });
    expect((await post('../outside')).status).toBe(400);
    expect((await post('/abs')).status).toBe(400);
    expect((await post('missing.md')).status).toBe(404);
    expect((await post('ok.md')).status).toBe(201);
    expect(MAX_PINS_PER_SCOPE).toBe(50);
  });

  it('can only be changed on this computer, but read from anywhere', async () => {
    const t = setup();
    const a = await t.project(t.mk(['ok.md']));
    const body = { path: 'ok.md', scope: 'project' };
    for (const header of ['x-pm-lan', 'x-pm-remote']) {
      const refused = await t.call('POST', `/projects/${a}/file-pins`, body, { [header]: '1' });
      expect(refused.status).toBe(403);
    }
    const added = await t.call('POST', `/projects/${a}/file-pins`, body);
    const { id } = (await added.json()) as { id: number };
    expect(
      (await t.call('DELETE', `/file-pins/${id}`, undefined, { 'x-pm-lan': '1' })).status,
    ).toBe(403);
    expect(
      (await t.call('POST', `/file-pins/${id}/move`, { direction: 'up' }, { 'x-pm-remote': '1' }))
        .status,
    ).toBe(403);
    const read = await t.call('GET', `/projects/${a}/file-pins`, undefined, { 'x-pm-lan': '1' });
    expect(read.status).toBe(200);
  });
});
