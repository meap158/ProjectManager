// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FolderInfo, FolderItem } from '../../../shared/types';

const item = (path: string, patch: Partial<FolderItem> = {}): FolderItem => ({
  name: path.split('/').pop()!,
  path,
  kind: 'file',
  size: 2048,
  mtime: '2026-10-20T10:00:00.000Z',
  ctime: '2026-10-01T10:00:00.000Z',
  ignored: false,
  symlink: false,
  ...patch,
});
const INFO: FolderInfo = {
  path: 'assets',
  recursive: false,
  folders: 1,
  files: 4,
  totalSize: 8192,
  newest: '2026-10-25T10:00:00.000Z',
  truncated: false,
  items: [
    item('assets/icons', { kind: 'dir', size: null }),
    item('assets/logo.png', { mtime: '2026-10-25T10:00:00.000Z' }),
    item('assets/hero.jpg', { mtime: '2026-10-10T10:00:00.000Z' }),
    item('assets/notes.md', { mtime: '2026-10-24T10:00:00.000Z' }),
    item('assets/run.sh'),
  ],
};
vi.mock('../api', () => ({
  api: {
    folderInfo: vi.fn(async () => INFO),
    projectRawUrl: (id: number, path: string) => `/api/projects/${id}/raw?path=${path}`,
  },
}));
const { FolderView } = await import('./FolderView');
const { api } = await import('../api');

afterEach(() => {
  cleanup();
  localStorage.clear();
});
beforeEach(() => vi.mocked(api.folderInfo).mockClear());

function Where() {
  return <output data-testid="where">{useLocation().search}</output>;
}
const url = () => screen.getByTestId('where').textContent ?? '';
const show = (
  search = '',
  handlers: { file?: (p: string) => void; dir?: (p: string) => void } = {},
) =>
  render(
    <MemoryRouter initialEntries={[`/projects/1?tab=files&dir=assets${search}`]}>
      <Where />
      <FolderView
        projectId={1}
        dir="assets"
        onOpenFile={handlers.file ?? (() => undefined)}
        onOpenDir={handlers.dir ?? (() => undefined)}
        onClose={() => undefined}
      />
    </MemoryRouter>,
  );
const names = () =>
  [...document.querySelectorAll('[data-cell] .fv-name, [data-cell] .truncate')].map(
    (n) => n.textContent,
  );

describe('FolderView', () => {
  it('summarises the folder and lists its entries, newest first, folders in front', async () => {
    show();
    expect(await screen.findByText(/4 files · 1 folder/)).toBeTruthy();
    expect(names()).toEqual(['icons', 'logo.png', 'notes.md', 'run.sh', 'hero.jpg']);
    expect(api.folderInfo).toHaveBeenCalledWith(1, 'assets', false);
  });

  it('filters by type and by name, and keeps the view in the address', async () => {
    show();
    await screen.findByText(/4 files/);
    fireEvent.click(screen.getByRole('button', { name: 'Images' }));
    await waitFor(() => expect(names()).toEqual(['logo.png', 'hero.jpg']));
    expect(url()).toContain('types=image');
    fireEvent.change(screen.getByLabelText('Filter by name'), { target: { value: 'hero' } });
    await waitFor(() => expect(names()).toEqual(['hero.jpg']));
    expect(url()).toContain('q=hero');
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(names()).toHaveLength(5));
    expect(url()).not.toContain('types=');
  });

  it('starts from the view in the address, and says when nothing matches', async () => {
    show('&view=list&sort=name&order=asc&types=audio');
    expect(await screen.findByText('Nothing matches these filters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(screen.getByRole('table', { name: 'Entries' })).toBeTruthy());
    expect(names().slice(0, 3)).toEqual(['icons', 'hero.jpg', 'logo.png']); // Name, A to Z.
  });

  it('keeps the filters chosen in a folder, and brings them back on the next visit', async () => {
    show();
    await screen.findByText(/4 files/);
    fireEvent.click(screen.getByRole('button', { name: 'Images' }));
    await waitFor(() => expect(names()).toEqual(['logo.png', 'hero.jpg']));
    expect(localStorage.getItem('pm.folderView.1:assets')).toContain('types=image');
    cleanup();
    // Arriving with no view in the address (a pin, the tree, a breadcrumb) restores it.
    show();
    await waitFor(() => expect(names()).toEqual(['logo.png', 'hero.jpg']));
    expect(url()).toContain('types=image');
    // Another folder has its own.
    expect(localStorage.getItem('pm.folderView.1:other')).toBeNull();
  });

  it('lets the address win over what was saved', async () => {
    localStorage.setItem('pm.folderView.1:assets', 'types=image');
    show('&types=document');
    await waitFor(() => expect(names()).toEqual(['notes.md']));
  });

  it('reads the subfolders too when asked', async () => {
    show();
    await screen.findByText(/4 files/);
    fireEvent.click(screen.getByLabelText('Include subfolders'));
    await waitFor(() => expect(api.folderInfo).toHaveBeenLastCalledWith(1, 'assets', true));
    expect(url()).toContain('rec=1');
  });

  it('marks what is new or changed since the last visit, and clears the marks on request', async () => {
    localStorage.setItem('pm.folderSeen.1:assets', String(Date.parse('2026-10-22T00:00:00Z')));
    show();
    const grid = await screen.findByRole('list');
    // logo.png and notes.md changed after the 22nd; hero.jpg and run.sh did not.
    expect(within(grid).getAllByText('Changed')).toHaveLength(2);
    expect(screen.getByText(/new or changed since you last looked/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark all seen' }));
    await waitFor(() => expect(within(grid).queryAllByText('Changed')).toHaveLength(0));
  });

  it('shows nothing as changed on a first visit', async () => {
    show();
    const grid = await screen.findByRole('list');
    expect(within(grid).queryAllByText(/Changed|New/)).toHaveLength(0);
  });

  it('opens a file, a folder, and a picture in the viewer', async () => {
    const file = vi.fn();
    const dir = vi.fn();
    show('', { file, dir });
    await screen.findByText(/4 files/);
    fireEvent.click(screen.getByText('notes.md'));
    expect(file).toHaveBeenCalledWith('assets/notes.md');
    fireEvent.click(screen.getByText('icons'));
    expect(dir).toHaveBeenCalledWith('assets/icons');
    fireEvent.click(screen.getByText('logo.png'));
    const viewer = await screen.findByRole('dialog', { name: /Image 1 of 2: logo\.png/ });
    fireEvent.keyDown(viewer, { key: 'ArrowRight' });
    expect(await screen.findByRole('dialog', { name: /Image 2 of 2: hero\.jpg/ })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('is a lightbox: the dark around the picture closes it, the picture does not', async () => {
    show();
    await screen.findByText(/4 files/);
    fireEvent.click(screen.getByText('logo.png'));
    const dialog = await screen.findByRole('dialog', { name: /logo\.png/ });
    // A click on the picture itself leaves it open.
    fireEvent.click(within(dialog).getByRole('img', { name: 'logo.png' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    // The backdrop (the dialog element itself) closes it.
    fireEvent.click(dialog);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('pages a long folder instead of rendering every entry', async () => {
    const many: FolderInfo = {
      ...INFO,
      files: 300,
      items: Array.from({ length: 300 }, (_, i) =>
        item(`assets/f${String(i).padStart(3, '0')}.txt`),
      ),
    };
    vi.mocked(api.folderInfo).mockResolvedValueOnce(many);
    show('&sort=name&order=asc');
    await screen.findByText(/300 files/);
    expect(names()).toHaveLength(120);
    fireEvent.click(screen.getByRole('button', { name: /Show 120 more/ }));
    await waitFor(() => expect(names()).toHaveLength(240));
    act(() => undefined);
  });

  it('shows the error from the server', async () => {
    vi.mocked(api.folderInfo).mockRejectedValueOnce(new Error('Not found'));
    show();
    expect(await screen.findByText('Not found')).toBeTruthy();
  });
});
