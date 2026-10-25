// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import type { LocalApp } from '../../../shared/types';
import {
  appMenuItems,
  isGroupOpen,
  groupApps,
  parsePreviewTarget,
  previewFrame,
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
    web: !!(title || icon),
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

  it('counts a project app that serves a web page as an app even without a fetched icon', () => {
    const page = { ...app(4400, 1, 'FrameMotion Console'), icon: null, web: true };
    const api = { ...app(4401, 1), web: false };
    const groups = groupApps([api, page], 'port', names);
    expect(groups.map((g) => [g.id, g.apps.map((a) => a.port)])).toEqual([
      ['apps', [4400]],
      ['services', [4401]],
    ]);
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

describe('previewFrame', () => {
  const target = { port: 5188, path: '/docs?x=1' };

  it('gives the app its own origin when this app is opened on this computer', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
      const frame = previewFrame(target, { protocol: 'http:', hostname, port: '5180' });
      expect(frame.src).toBe('http://p5188.localhost:5180/docs?x=1');
      expect(frame.ownOrigin).toBe(true);
      expect(frame.sandbox).toContain('allow-same-origin');
    }
  });

  it('keeps the read-only path mode, with no origin of its own, from any other address', () => {
    for (const hostname of ['192.168.1.20', 'pm.example.com', 'phone.local']) {
      const frame = previewFrame(target, { protocol: 'http:', hostname, port: '5180' });
      expect(frame.src).toBe('/api/preview/5188/docs?x=1');
      expect(frame.ownOrigin).toBe(false);
      expect(frame.sandbox).not.toContain('allow-same-origin');
    }
    expect(
      previewFrame(target, { protocol: 'https:', hostname: 'localhost', port: '' }).ownOrigin,
    ).toBe(false);
  });

  it('omits the port when this app is served on a default one', () => {
    expect(
      previewFrame(
        { port: 3000, path: '/' },
        { protocol: 'http:', hostname: 'localhost', port: '' },
      ).src,
    ).toBe('http://p3000.localhost/');
  });
});

describe('appMenuItems (PM-270)', () => {
  const app = (projectId: number | null) =>
    ({
      port: 3000,
      pid: 1,
      name: '',
      command: '',
      projectId,
      title: null,
      icon: null,
      web: true,
    }) as LocalApp;
  it('offers the project only when the app belongs to one, and Stop last', () => {
    expect(appMenuItems(app(null)).map((i) => i.command)).toEqual([
      'open',
      'open-tab',
      'copy',
      'stop',
    ]);
    expect(appMenuItems(app(4)).map((i) => i.command)).toEqual([
      'open',
      'open-tab',
      'copy',
      'project',
      'stop',
    ]);
  });
});
