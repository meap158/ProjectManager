import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { Card, ProjectDetail } from '../shared/types.js';
import { createApp } from './app.js';
import { openDb } from './db.js';

// Boards follow commits without a scan: the commit watcher calls scanner.applyCommitRefs when a
// project's HEAD moves. These tests drive applyCommitRefs directly, as the watcher does.

const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-refs-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const commit = (message: string, date?: string) => {
  writeFileSync(path.join(dir, `f${Math.random()}.txt`), message);
  const env = date
    ? { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date }
    : process.env;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], {
      cwd: dir,
      stdio: 'pipe',
      env,
    });
  git('add', '.');
  git('commit', '-q', '-m', message);
};

const app = createApp(openDb(':memory:'));
const call = (method: string, url: string, body?: unknown) =>
  app.request(`/api${url}`, {
    method,
    headers: { host: 'localhost', ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
const cardsOf = async (id: number) =>
  (await (await call('GET', `/projects/${id}/cards`)).json()) as Card[];

describe('commit references without a scan', () => {
  it('moves cards from new commits, counts same-second commits, and never replays', async () => {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    commit('Initial commit');
    const { id } = (await (await call('POST', '/projects', { path: dir })).json()) as ProjectDetail;
    // Let the initial scan finish (it also applies refs).
    for (let i = 0; i < 200; i++) {
      const p = (await (await call('GET', `/projects/${id}`)).json()) as ProjectDetail;
      if (p.scan.status !== 'scanning') break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const a = (await (await call('POST', `/projects/${id}/cards`, { title: 'A' })).json()) as Card;
    const b = (await (await call('POST', `/projects/${id}/cards`, { title: 'B' })).json()) as Card;

    // Two commits in the same second (one-second commit-date resolution), newer than the cards.
    const at = new Date(Date.now() + 5000).toISOString();
    commit(`Start A (${a.key})`, at);
    commit(`Finish B\n\nFixes ${b.key}`, at);

    const moves = await app.scanner.applyCommitRefs(id);
    expect(moves.map((m) => [m.key, m.to]).sort()).toEqual([
      [a.key, 'in_progress'],
      [b.key, 'done'],
    ]);

    // Moved back by hand: the same commits are never applied again.
    await call('PATCH', `/cards/${b.id}`, { status: 'todo' });
    expect(await app.scanner.applyCommitRefs(id)).toEqual([]);
    expect((await cardsOf(id)).find((c) => c.id === b.id)?.status).toBe('todo');

    // A later commit in that same second still counts.
    commit(`Done with A\n\nCloses ${a.key}`, at);
    expect((await app.scanner.applyCommitRefs(id)).map((m) => [m.key, m.to])).toEqual([
      [a.key, 'done'],
    ]);
  }, 30_000);
});
