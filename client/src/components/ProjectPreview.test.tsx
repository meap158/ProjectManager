// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LocalApp } from '../../../shared/types';
import {
  isGroupOpen,
  groupApps,
  parsePreviewTarget,
  previewSrc,
  sortApps,
  type PreviewSort,
} from './ProjectPreview';

// The Preview tab's address parsing (PM-253): only a localhost port, never another host.

describe('parsePreviewTarget', () => {
  it.each([
    ['3000', 3000, '/'],
    [':5173/docs', 5173, '/docs'],
    ['localhost:3000/a?b=1', 3000, '/a?b=1'],
    ['http://127.0.0.1:8080/', 8080, '/'],
  ])('reads %s', (input, port, path) => {
    expect(parsePreviewTarget(input)).toEqual({ port, path });
  });

  it.each(['', 'example.com', 'https://example.com:3000/', '80', '70000', 'localhost', '3000 x'])(
    'refuses %j',
    (input) => {
      expect(parsePreviewTarget(input)).toBeNull();
    },
  );

  it('builds the proxied address', () => {
    expect(previewSrc({ port: 3000, path: '/x?y=1' })).toBe('/api/preview/3000/x?y=1');
  });
});

describe('sorting and grouping', () => {
  const app = (
    port: number,
    projectId: number | null,
    title: string | null = null,
    icon: string | null = null,
  ): LocalApp => ({
    port,
    pid: port,
    name: 'node.exe',
    command: '',
    projectId,
    title,
    icon,
  });
  const names = new Map([
    [1, 'Alpha'],
    [2, 'Zed'],
  ]);
  const apps = [app(3004, null, 'beta'), app(3002, 2), app(3001, 1), app(3000, null, 'Alef')];

  it('sorts by port, name either way, or project', () => {
    const ports = (sort: PreviewSort) => sortApps(apps, sort, names).map((a) => a.port);
    expect(ports('port')).toEqual([3000, 3001, 3002, 3004]);
    expect(ports('name')).toEqual([3000, 3001, 3004, 3002]);
    expect(ports('name-desc')).toEqual([3002, 3004, 3001, 3000]);
    expect(ports('project')).toEqual([3000, 3004, 3001, 3002]);
  });

  it("puts your projects' apps with an icon first, back ends next, the rest last", () => {
    const stack = [
      app(3000, null, 'Syncthing', '/i.png'),
      app(4000, 1, 'Shop', '/favicon.ico'),
      app(4001, 1),
      app(4002, 2, 'Admin', '/logo.svg'),
      app(4003, 2),
    ];
    const groups = groupApps(stack, 'port', names);
    expect(groups.map((g) => g.id)).toEqual(['apps', 'services', 'other']);
    expect(groups.map((g) => g.apps.map((a) => a.port))).toEqual([
      [4000, 4002],
      [4001, 4003],
      [3000],
    ]);
  });

  it('keeps the chosen order inside each group', () => {
    const groups = groupApps(
      [app(4000, 1, 'A', '/i'), app(4005, 1, 'B', '/i')],
      'name-desc',
      names,
    );
    expect(groups[0]?.apps.map((a) => a.port)).toEqual([4005, 4000]);
  });

  it('skips empty groups', () => {
    expect(groupApps([app(3000, null)]).map((g) => g.id)).toEqual(['other']);
    expect(groupApps([])).toEqual([]);
  });

  it('starts with your projects open and the system noise closed, unless it is all there is', () => {
    expect(isGroupOpen('apps', {}, true)).toBe(true);
    expect(isGroupOpen('services', {}, true)).toBe(true);
    expect(isGroupOpen('other', {}, true)).toBe(false);
    expect(isGroupOpen('other', {}, false)).toBe(true);
    expect(isGroupOpen('saved', {}, false)).toBe(true);
  });

  it('keeps whatever the person chose', () => {
    expect(isGroupOpen('other', { other: false }, false)).toBe(false);
    expect(isGroupOpen('services', { services: false }, true)).toBe(false);
    expect(isGroupOpen('other', { other: true }, true)).toBe(true);
  });
});
