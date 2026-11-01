import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { projectBranches } from './branches.js';
import { createApp } from './app.js';
import { openDb } from './db.js';
function repo() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-branches-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  return { root, git };
}
it('reads current/local/remote refs and upstream without changing checkout', async () => {
  const { root, git } = repo();
  writeFileSync(path.join(root, 'a'), 'a');
  git('add', '.');
  git('commit', '-m', 'First');
  git('branch', 'feature/test');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
  git('config', 'branch.main.remote', 'origin');
  git('config', 'branch.main.merge', 'refs/heads/main');
  git('config', 'remote.origin.url', 'https://example.com/test.git');
  git('config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*');
  const before = git('status', '--porcelain');
  const result = await projectBranches(root);
  expect(result.current).toBe('main');
  expect(result.branches.find((b) => b.current)).toMatchObject({
    upstream: 'origin/main',
    subject: 'First',
  });
  expect(result.branches.some((b) => b.name === 'feature/test' && !b.remote)).toBe(true);
  expect(result.branches.some((b) => b.name === 'origin/main' && b.remote)).toBe(true);
  expect(result.branches.some((b) => b.name === 'origin/HEAD')).toBe(false);
  expect(git('status', '--porcelain')).toBe(before);
  expect(git('branch', '--show-current')).toBe('main');
  git('checkout', '--detach');
  expect(await projectBranches(root)).toMatchObject({ detached: true, current: null });
});
it('handles unborn branches and non-repositories', async () => {
  const { root } = repo();
  expect(await projectBranches(root)).toMatchObject({
    isRepo: true,
    current: 'main',
    head: null,
    branches: [],
  });
  const plain = mkdtempSync(path.join(os.tmpdir(), 'pm-plain-'));
  expect(await projectBranches(plain)).toMatchObject({ isRepo: false });
});

it('keeps an old current branch when recent refs exceed the display cap', async () => {
  const { root, git } = repo();
  writeFileSync(path.join(root, 'a'), 'a');
  git('add', '.');
  git('commit', '-m', 'Old');
  const old = git('rev-parse', 'HEAD');
  git('checkout', '-b', 'new');
  writeFileSync(path.join(root, 'a'), 'b');
  git('add', '.');
  git('commit', '-m', 'New');
  const next = git('rev-parse', 'HEAD');
  execFileSync('git', ['update-ref', '--stdin'], {
    cwd: root,
    input:
      Array.from({ length: 505 }, (_, i) => `update refs/heads/recent-${i} ${next}`).join('\n') +
      '\n',
  });
  git('checkout', 'main');
  const result = await projectBranches(root);
  expect(result.branches).toHaveLength(500);
  expect(result.truncated).toBe(true);
  expect(result.branches[0]).toMatchObject({ current: true, name: 'main', subject: 'Old' });
  expect(git('rev-parse', 'HEAD')).toBe(old);
});

it('serves branch information on read-only listeners and preserves project errors', async () => {
  const db = openDb(':memory:');
  try {
    const app = createApp(db);
    const { root } = repo();
    const headers = { host: 'localhost:5180', 'content-type': 'application/json' };
    const made = await app.request('/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: root }),
    });
    const { id } = (await made.json()) as { id: number };
    for (const listener of [{}, { 'x-pm-lan': '1' }]) {
      const response = await app.request(`/api/projects/${id}/branches`, {
        headers: { ...headers, ...listener },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ isRepo: true, current: 'main' });
    }
    expect((await app.request('/api/projects/999999/branches', { headers })).status).toBe(404);
  } finally {
    db.close();
  }
});
