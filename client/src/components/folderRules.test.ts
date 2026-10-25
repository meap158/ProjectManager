// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import type { FolderItem } from '../../../shared/types';
import {
  DEFAULT_VIEW,
  applyFilters,
  changedSince,
  hasViewParams,
  readSavedView,
  readSeen,
  readViewParams,
  sortItems,
  typeGroupOf,
  writeSavedView,
  writeSeen,
  writeViewParams,
  type FolderViewState,
} from './folderRules';

const item = (
  path: string,
  patch: Partial<FolderItem> & { kind?: 'dir' | 'file' } = {},
): FolderItem => ({
  name: path.split('/').pop()!,
  path,
  kind: 'file',
  size: 100,
  mtime: '2026-10-20T10:00:00.000Z',
  ctime: '2026-10-01T10:00:00.000Z',
  ignored: false,
  symlink: false,
  width: null,
  height: null,
  git: null,
  ...patch,
});
const state = (patch: Partial<FolderViewState> = {}): FolderViewState => ({
  ...DEFAULT_VIEW,
  ...patch,
});
const NOW = Date.parse('2026-10-26T12:00:00Z');

describe('typeGroupOf', () => {
  it('groups by extension, case-insensitively, with folders and the unknown apart', () => {
    expect(typeGroupOf(item('a/Logo.PNG'))).toBe('image');
    expect(typeGroupOf(item('clip.mp4'))).toBe('video');
    expect(typeGroupOf(item('x.tsx'))).toBe('code');
    expect(typeGroupOf(item('data.json'))).toBe('data');
    expect(typeGroupOf(item('README.md'))).toBe('document');
    expect(typeGroupOf(item('a.zip'))).toBe('archive');
    expect(typeGroupOf(item('noext'))).toBe('other');
    expect(typeGroupOf(item('.gitignore'))).toBe('other'); // A leading dot is a name, not an extension.
    expect(typeGroupOf(item('assets', { kind: 'dir' }))).toBe('folder');
  });
});

describe('applyFilters', () => {
  const all = [
    item('assets', { kind: 'dir', size: null }),
    item('assets/logo.png'),
    item('assets/old.png', { mtime: '2026-08-01T00:00:00.000Z' }),
    item('notes.md', { mtime: '2026-10-26T08:00:00.000Z' }),
    item('run.sh', { mtime: '2026-10-22T08:00:00.000Z' }),
  ];
  const paths = (s: FolderViewState) => applyFilters(all, s, NOW).map((i) => i.path);

  it('keeps everything by default, and filters by name over the whole path', () => {
    expect(paths(state())).toHaveLength(5);
    expect(paths(state({ text: ' PNG ' }))).toEqual(['assets/logo.png', 'assets/old.png']);
    expect(paths(state({ text: 'assets/' }))).toEqual(['assets/logo.png', 'assets/old.png']);
  });

  it('filters by type, hiding folders while a type or date filter asks for files', () => {
    expect(paths(state({ types: ['image'] }))).toEqual(['assets/logo.png', 'assets/old.png']);
    expect(paths(state({ types: ['image', 'document'] }))).toHaveLength(3);
    expect(paths(state({ modified: '7d' }))).not.toContain('assets');
  });

  it('filters by modified range from now (today means since local midnight)', () => {
    expect(paths(state({ modified: '7d' }))).toEqual(['assets/logo.png', 'notes.md', 'run.sh']);
    expect(paths(state({ modified: '30d' }))).toEqual(['assets/logo.png', 'notes.md', 'run.sh']);
    expect(paths(state({ modified: 'today' }))).toEqual(['notes.md']);
    expect(applyFilters([item('nodate', { mtime: null })], state({ modified: '7d' }), NOW)).toEqual(
      [],
    );
  });
});

describe('sortItems', () => {
  const list = [
    item('b.txt', { size: 5, mtime: '2026-10-01T00:00:00.000Z' }),
    item('a.png', { size: 50, mtime: '2026-10-03T00:00:00.000Z' }),
    item('sub', { kind: 'dir', size: null }),
    item('c.md', { size: 20, mtime: '2026-10-02T00:00:00.000Z' }),
    item('item10.txt', { size: 1, mtime: '2026-09-01T00:00:00.000Z' }),
    item('item2.txt', { size: 2, mtime: '2026-09-02T00:00:00.000Z' }),
  ];
  const order = (key: Parameters<typeof sortItems>[1], desc: boolean) =>
    sortItems(list, key, desc).map((i) => i.name);

  it('keeps folders first and sorts the rest by the key', () => {
    expect(order('name', false).slice(0, 3)).toEqual(['sub', 'a.png', 'b.txt']);
    expect(order('modified', true)).toEqual([
      'sub',
      'a.png',
      'c.md',
      'b.txt',
      'item2.txt',
      'item10.txt',
    ]);
    expect(order('modified', false)[1]).toBe('item10.txt');
    expect(order('size', true)).toEqual([
      'sub',
      'a.png',
      'c.md',
      'b.txt',
      'item2.txt',
      'item10.txt',
    ]);
    expect(order('size', false)[1]).toBe('item10.txt');
  });

  it('sorts names numerically and by type with the extension first', () => {
    const names = order('name', false);
    expect(names.indexOf('item2.txt')).toBeLessThan(names.indexOf('item10.txt'));
    // By extension (md, png, txt), then by name inside one extension.
    expect(order('type', false)).toEqual([
      'sub',
      'c.md',
      'a.png',
      'b.txt',
      'item2.txt',
      'item10.txt',
    ]);
  });

  it('does not change the list it is given', () => {
    const before = list.map((i) => i.name);
    sortItems(list, 'name', true);
    expect(list.map((i) => i.name)).toEqual(before);
  });
});

describe('changedSince', () => {
  const seen = Date.parse('2026-10-10T00:00:00Z');
  it('marks new and changed files, never folders, and nothing before a first visit', () => {
    expect(changedSince(item('a', { ctime: '2026-10-15T00:00:00Z' }), seen)).toBe('new');
    expect(changedSince(item('a', { mtime: '2026-10-15T00:00:00Z' }), seen)).toBe('changed');
    expect(changedSince(item('a', { mtime: '2026-10-05T00:00:00Z' }), seen)).toBeNull();
    expect(
      changedSince(item('d', { kind: 'dir', mtime: '2026-10-15T00:00:00Z' }), seen),
    ).toBeNull();
    expect(changedSince(item('a', { mtime: '2026-10-15T00:00:00Z' }), null)).toBeNull();
  });
});

describe('the view in the address', () => {
  it('writes only what differs from the default, and reads it back', () => {
    expect(writeViewParams(state(), new URLSearchParams('tab=files&dir=a')).toString()).toBe(
      'tab=files&dir=a',
    );
    const custom = state({
      view: 'list',
      sort: 'name',
      descending: true,
      text: 'logo',
      types: ['image', 'video'],
      modified: '7d',
      recursive: true,
    });
    const params = writeViewParams(custom, new URLSearchParams('tab=files&dir=a'));
    expect(params.get('dir')).toBe('a'); // Other parameters are kept.
    expect(readViewParams(params)).toEqual(custom);
  });

  it('falls back to the default for anything it does not know', () => {
    const read = readViewParams(
      new URLSearchParams('view=cards&sort=colour&types=image,ghost&mod=forever&order=sideways'),
    );
    expect(read).toEqual({ ...DEFAULT_VIEW, types: ['image'] });
  });
});

describe('the last visit', () => {
  afterEach(() => localStorage.clear());
  it('is remembered per project and folder', () => {
    expect(readSeen(1, 'assets')).toBeNull();
    writeSeen(1, 'assets', 1234);
    expect(readSeen(1, 'assets')).toBe(1234);
    expect(readSeen(2, 'assets')).toBeNull();
    expect(readSeen(1, 'other')).toBeNull();
  });
});

describe('the view kept for a folder', () => {
  afterEach(() => localStorage.clear());
  it('remembers the filters per project and folder, and forgets them when cleared', () => {
    expect(readSavedView(1, 'assets')).toBeNull();
    writeSavedView(1, 'assets', state({ types: ['image'], modified: '7d', view: 'list' }));
    expect(readViewParams(readSavedView(1, 'assets')!)).toEqual(
      state({ types: ['image'], modified: '7d', view: 'list' }),
    );
    expect(readSavedView(1, 'other')).toBeNull();
    expect(readSavedView(2, 'assets')).toBeNull();
    // Back to the default: nothing is stored.
    writeSavedView(1, 'assets', state());
    expect(readSavedView(1, 'assets')).toBeNull();
  });

  it('knows whether the address already carries a view', () => {
    expect(hasViewParams(new URLSearchParams('tab=files&dir=a'))).toBe(false);
    expect(hasViewParams(new URLSearchParams('tab=files&dir=a&types=image'))).toBe(true);
    expect(hasViewParams(new URLSearchParams('rec=1'))).toBe(true);
  });
});
