import { expect, it } from 'vitest';
import type { ProjectBranch } from '../../../shared/branches';
import { filterBranches, offeredFacets, parseTracking, STALE_DAYS } from './branchFilter';

const NOW = Date.parse('2026-11-04T12:00:00Z');
const DAY = 86_400_000;
const b = (over: Partial<ProjectBranch>): ProjectBranch => ({
  name: 'x',
  remote: false,
  current: false,
  hash: 'abc1234',
  subject: '',
  committedAt: new Date(NOW - DAY).toISOString(),
  upstream: null,
  tracking: '',
  worktree: false,
  ...over,
});
const list = [
  b({ name: 'feature/login', upstream: 'origin/feature/login', tracking: '[ahead 2]' }),
  b({ name: 'fix/crash', tracking: '[gone]', upstream: 'origin/fix/crash' }),
  b({ name: 'origin/main', remote: true, subject: 'Sửa lỗi đăng nhập', hash: 'f00dbee' }),
  b({ name: 'old/spike', committedAt: new Date(NOW - (STALE_DAYS + 1) * DAY).toISOString() }),
  b({ name: 'wt/review', worktree: true, tracking: '[ahead 1, behind 3]' }),
  b({ name: 'release-10', committedAt: '' }),
  b({ name: 'release-9' }),
];
const run = (query = '', facet: Parameters<typeof filterBranches>[1]['facet'] = 'all') =>
  filterBranches(list, { query, facet, sort: 'name' }, NOW);
const names = (r: ReturnType<typeof run>) => r.shown.map((x) => x.name);

it('parses every tracking form git prints', () => {
  expect(parseTracking('[ahead 2, behind 11]')).toEqual({ ahead: 2, behind: 11, gone: false });
  expect(parseTracking('[behind 1]')).toEqual({ ahead: 0, behind: 1, gone: false });
  expect(parseTracking('[gone]')).toEqual({ ahead: 0, behind: 0, gone: true });
  expect(parseTracking('')).toEqual({ ahead: 0, behind: 0, gone: false });
});

it('matches every word against name, upstream, hash and message, ignoring case and accents', () => {
  expect(names(run('FEATURE'))).toEqual(['feature/login']);
  expect(names(run('origin/fix'))).toEqual(['fix/crash']);
  expect(names(run('f00d'))).toEqual(['origin/main']);
  expect(names(run('sua loi dang'))).toEqual(['origin/main']);
  expect(names(run('  release   9 '))).toEqual(['release-9']);
  expect(names(run('login nope'))).toEqual([]);
});

it('filters by kind', () => {
  expect(names(run('', 'remote'))).toEqual(['origin/main']);
  expect(names(run('', 'local'))).not.toContain('origin/main');
  expect(names(run('', 'worktree'))).toEqual(['wt/review']);
  expect(names(run('', 'diverged'))).toEqual(['feature/login', 'wt/review']);
  expect(names(run('', 'gone'))).toEqual(['fix/crash']);
  expect(names(run('', 'stale'))).toEqual(['old/spike']);
});

it('counts each kind within the current search', () => {
  const { counts } = run('release');
  expect(counts).toMatchObject({ all: 2, local: 2, remote: 0, stale: 0 });
  expect(run().counts).toMatchObject({ all: 7, local: 6, remote: 1, diverged: 2, gone: 1 });
});

it('sorts names naturally, and by newest commit with undated refs last', () => {
  expect(names(run('release'))).toEqual(['release-9', 'release-10']);
  const recent = filterBranches(list, { query: '', facet: 'all', sort: 'recent' }, NOW).shown;
  expect(recent.at(-1)?.name).toBe('release-10');
  expect(recent.at(-2)?.name).toBe('old/spike');
});

it('offers only kinds the list has, plus All and the chosen one', () => {
  const plain = [b({ name: 'a' }), b({ name: 'b' })];
  expect(offeredFacets(plain, 'all', NOW)).toEqual(['all', 'local']);
  expect(offeredFacets(plain, 'gone', NOW)).toEqual(['all', 'local', 'gone']);
  expect(offeredFacets(list, 'all', NOW)).toHaveLength(7);
});
