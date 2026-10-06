import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Card, ProjectDetail } from '../shared/types.js';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { LAN_HEADER } from './lan.js';

const HOST = { host: 'localhost:5180' };

function setup() {
  const app = createApp(openDb(':memory:'));
  const call = (
    method: string,
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.request(`/api${url}`, {
      method,
      headers: {
        ...HOST,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  return { call };
}

async function waitForScan(
  call: ReturnType<typeof setup>['call'],
  id: number,
): Promise<ProjectDetail> {
  for (let i = 0; i < 200; i++) {
    const project = (await (await call('GET', `/projects/${id}`)).json()) as ProjectDetail;
    if (project.scan.status !== 'scanning') return project;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('scan did not finish');
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd,
    stdio: 'pipe',
  });

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pm-test-'));
  writeFileSync(path.join(dir, 'index.ts'), 'export const a = 1;\n// note\nif (a) {}\n');
  git(dir, 'init', '-q');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'Initial commit');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('security guards', () => {
  it('rejects foreign Host headers (DNS rebinding)', async () => {
    const { call } = setup();
    const res = await call('GET', '/projects', undefined, { host: 'evil.example:5180' });
    expect(res.status).toBe(403);
  });

  it('rejects non-JSON writes (cross-site form posts)', async () => {
    const { call } = setup();
    const res = await call('POST', '/projects', undefined, { 'content-type': 'text/plain' });
    expect(res.status).toBe(415);
  });

  it('never opens a folder on this computer for a LAN device', async () => {
    const { call } = setup();
    const res = await call('POST', '/projects/1/open-folder', {}, { [LAN_HEADER]: '1' });
    expect(res.status).toBe(403);
  });
});

describe('projects and cards', () => {
  it('tracks a folder, scans it, and auto-moves cards from commit messages', async () => {
    const { call } = setup();

    expect((await call('POST', '/projects', { path: 'relative/path' })).status).toBe(400);
    expect((await call('POST', '/projects', { path: path.join(dir, 'nope') })).status).toBe(400);

    const created = await call('POST', '/projects', { path: dir });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as ProjectDetail;
    expect((await call('POST', '/projects', { path: dir })).status).toBe(409);

    const project = await waitForScan(call, id);
    expect(project.code).toMatchObject({ code: 2, comments: 1, complexity: 1 });
    expect(project.code!.languages[0]!.name).toBe('TypeScript');
    expect(project.git).toMatchObject({ isRepo: true, totalCommits: 1 });
    expect(project.disk!.files).toBeGreaterThan(1); // Includes .git internals.
    expect(project.disk!.gitBytes).toBeGreaterThan(0);

    const cardRes = await call('POST', `/projects/${id}/cards`, { title: 'Dark mode' });
    expect(cardRes.status).toBe(201);
    const card = (await cardRes.json()) as Card;
    expect(card).toMatchObject({ status: 'backlog', key: `PM-${card.id}` });

    // Commit dates have one-second resolution; make sure the commit is newer than the card.
    await new Promise((r) => setTimeout(r, 1100));
    writeFileSync(path.join(dir, 'theme.ts'), 'export const dark = true;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `Add theme toggle\n\nFixes ${card.key}`);

    await call('POST', `/projects/${id}/scan`, {});
    const rescanned = await waitForScan(call, id);
    expect(rescanned.scan.moves).toEqual([
      expect.objectContaining({ cardId: card.id, from: 'backlog', to: 'done' }),
    ]);
    const cards = (await (await call('GET', `/projects/${id}/cards`)).json()) as Card[];
    expect(cards[0]).toMatchObject({ status: 'done' });
    expect(cards[0]!.closedAt).not.toBeNull();

    // Moving the card back by hand must stick: the same commit isn't applied twice.
    await call('PATCH', `/cards/${card.id}`, { status: 'todo' });
    await call('POST', `/projects/${id}/scan`, {});
    expect((await waitForScan(call, id)).scan.moves).toEqual([]);

    expect((await call('DELETE', `/projects/${id}`)).status).toBe(204);
    expect((await call('GET', `/projects/${id}`)).status).toBe(404);
  }, 30_000);

  it('validates card input', async () => {
    const { call } = setup();
    expect((await call('POST', '/projects/999/cards', { title: 'x' })).status).toBe(404);
    expect((await call('PATCH', '/cards/1', { status: 'nope' })).status).toBe(400);
  });

  it('keeps the colour theme server-side (survives restarts and port changes)', async () => {
    const { call } = setup();
    // Unset until first saved, so the client can upload its browser copy.
    expect(await (await call('GET', '/preferences/theme')).json()).toEqual({ theme: null });
    expect((await call('PUT', '/preferences/theme', { theme: 'dark' })).status).toBe(200);
    expect(await (await call('GET', '/preferences/theme')).json()).toEqual({ theme: 'dark' });
    expect((await call('PUT', '/preferences/theme', { theme: 'neon' })).status).toBe(400);
  });

  it('keeps the sidebar custom order server-side, without duplicates', async () => {
    const { call } = setup();
    expect(await (await call('GET', '/preferences/project-order')).json()).toEqual({ order: [] });
    expect((await call('PUT', '/preferences/project-order', { order: [3, 1, 3, 2] })).status).toBe(
      200,
    );
    expect(await (await call('GET', '/preferences/project-order')).json()).toEqual({
      order: [3, 1, 2],
    });
    expect((await call('PUT', '/preferences/project-order', { order: ['x'] })).status).toBe(400);
  });

  it('switches board column presets per project', async () => {
    const { call } = setup();
    const created = (await (
      await call('POST', '/projects', { path: dir })
    ).json()) as ProjectDetail;
    expect(created.boardPreset).toBe('full');
    expect((await call('PATCH', '/projects/999', { boardPreset: 'simple' })).status).toBe(404);
    expect((await call('PATCH', `/projects/${created.id}`, { boardPreset: 'nope' })).status).toBe(
      400,
    );
    expect((await call('PATCH', `/projects/${created.id}`, {})).status).toBe(400);
    const simple = (await (
      await call('PATCH', `/projects/${created.id}`, { boardPreset: 'simple' })
    ).json()) as ProjectDetail;
    expect(simple.boardPreset).toBe('simple');
    // Renaming still works alongside, and the preset survives it.
    const renamed = (await (
      await call('PATCH', `/projects/${created.id}`, { name: 'Lean board' })
    ).json()) as ProjectDetail;
    expect(renamed).toMatchObject({ name: 'Lean board', boardPreset: 'simple' });
    await call('DELETE', `/projects/${created.id}`);
  });
});

describe('cards in flight', () => {
  it('lists In progress / Review cards across projects with their project name', async () => {
    const { call } = setup();
    const created = (await (
      await call('POST', '/projects', { path: dir })
    ).json()) as ProjectDetail;
    const todo = (await (
      await call('POST', `/projects/${created.id}/cards`, { title: 'Later', status: 'todo' })
    ).json()) as Card;
    const doing = (await (
      await call('POST', `/projects/${created.id}/cards`, { title: 'Now', status: 'in_progress' })
    ).json()) as Card;
    const list = (await (await call('GET', '/cards/in-flight')).json()) as (Card & {
      projectName: string;
    })[];
    expect(list.map((c) => c.id)).toEqual([doing.id]);
    expect(list[0]!.projectName).toBe(created.name);
    expect(list.some((c) => c.id === todo.id)).toBe(false);
    await waitForScan(call, created.id); // Don't leave a scan running on the temp repo.
  });
});

describe('card keys', () => {
  it('never reuses a card key, even after deleting the newest card', async () => {
    const { call } = setup();
    const created = (await (
      await call('POST', '/projects', { path: dir })
    ).json()) as ProjectDetail;
    const add = async (title: string) =>
      (await (await call('POST', `/projects/${created.id}/cards`, { title })).json()) as Card;
    const a = await add('First');
    const b = await add('Second');
    expect((await call('DELETE', `/cards/${b.id}`)).status).toBe(204);
    const c = await add('Third');
    expect(c.id).toBeGreaterThan(b.id); // PM-<b> stays retired: old commit refs can't hit "Third".
    expect(c.key).not.toBe(b.key);
    expect(a.id).toBeLessThan(b.id);
    await waitForScan(call, created.id);
  });
});
