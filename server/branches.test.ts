import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { projectBranches } from './branches.js';
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
