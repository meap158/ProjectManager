// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FolderListing, TreeEntry } from '../../../shared/types';

const entry = (path: string, kind: 'dir' | 'file', ignored = false): TreeEntry => ({
  name: path.split('/').pop()!,
  path,
  kind,
  size: kind === 'file' ? 12 : null,
  ignored,
  symlink: false,
});
const FOLDERS: Record<string, FolderListing> = {
  '': {
    path: '',
    truncated: false,
    entries: [entry('docs', 'dir'), entry('dist', 'dir', true), entry('README.md', 'file')],
  },
  docs: { path: 'docs', truncated: false, entries: [entry('docs/guide.ts', 'file')] },
};
vi.mock('../api', () => ({
  api: {
    projectFolder: vi.fn(async (_id: number, path: string) => FOLDERS[path]),
    projectFile: vi.fn(async (_id: number, path: string) => ({
      kind: 'text',
      path,
      size: 12,
      mtime: new Date().toISOString(),
      content: path.endsWith('.md') ? '# Title\n\nSome *text*.' : 'line one\nline two',
    })),
    projectRawUrl: (id: number, path: string) => `/api/projects/${id}/raw?path=${path}`,
    renameProjectFile: vi.fn(async (_id: number, path: string, name: string) => {
      const next = [...path.split('/').slice(0, -1), name].join('/');
      const list = FOLDERS['']!.entries;
      const at = list.findIndex((e) => e.path === path);
      if (at >= 0) list[at] = entry(next, list[at]!.kind);
      return { path: next };
    }),
    openProjectFile: vi.fn(async () => undefined),
  },
}));

const { api } = await import('../api');
const { ProjectFiles, joinPath, foldersTo, absolutePath, remapPath, fileMenuItems } =
  await import('./ProjectFiles');

// Files tab (PM-252): the tree loads folders as they open, works from the keyboard, and opens
// previews; rendered previews can't run scripts.

afterEach(cleanup);

const show = (search = '?tab=files') =>
  render(
    <MemoryRouter initialEntries={[`/projects/1${search}`]}>
      <ProjectFiles projectId={1} projectPath={'S:\\Vibe Coding\\Demo'} />
    </MemoryRouter>,
  );

describe('ProjectFiles', () => {
  it('lists the root, greys ignored entries, and opens folders on demand', async () => {
    show();
    const tree = await screen.findByRole('tree', { name: 'Project files' });
    const items = () => [...tree.querySelectorAll('[role=treeitem]')].map((li) => li.textContent);
    expect(items()).toEqual(['docs', 'dist', 'README.md12 B']);
    // Folders carry a caret that turns down when open; files have none. Icons follow the file type.
    const caret = (path: string) => tree.querySelector(`[data-path="${path}"] .files-chevron`);
    expect(caret('docs')?.querySelector('svg')).not.toBeNull();
    expect(caret('docs')?.className).not.toContain('is-open');
    expect(caret('README.md')?.querySelector('svg')).toBeNull();
    expect(
      tree.querySelector('[data-path="README.md"] [data-glyph]')?.getAttribute('data-glyph'),
    ).toBe('markdown');
    expect(tree.querySelector('[data-path="dist"]')?.className).toContain('is-ignored');
    fireEvent.click(screen.getByText('docs'));
    await waitFor(() => expect(items()).toContain('guide.ts12 B'));
    expect(tree.querySelector('[data-path="docs"]')?.getAttribute('aria-expanded')).toBe('true');
  });

  it('opens a folder from its caret, and jumps to a row by typing its first letters', async () => {
    show();
    const tree = await screen.findByRole('tree');
    const caret = tree.querySelector<HTMLElement>('[data-path="docs"] .files-chevron')!;
    fireEvent.click(caret);
    await screen.findByText('guide.ts');
    expect(tree.querySelector('[data-path="docs"] .files-chevron')?.className).toContain('is-open');
    const first = tree.querySelector<HTMLElement>('[data-path="docs"]')!;
    first.focus();
    fireEvent.focusIn(first);
    fireEvent.keyDown(tree, { key: 'r' }); // Type-ahead: README.md is the only name starting with r.
    await waitFor(() =>
      expect(tree.querySelector('[data-path="README.md"]')?.getAttribute('tabindex')).toBe('0'),
    );
  });

  it('moves and opens with the keyboard, then shows the file with line numbers', async () => {
    show();
    const tree = await screen.findByRole('tree');
    const first = tree.querySelector<HTMLElement>('[data-path="docs"]')!;
    first.focus();
    fireEvent.focusIn(first); // React's onFocus listens for focusin, which jsdom's focus() skips.
    fireEvent.keyDown(tree, { key: 'ArrowRight' }); // Opens docs.
    await screen.findByText('guide.ts');
    fireEvent.keyDown(tree, { key: 'ArrowDown' }); // To guide.ts.
    fireEvent.keyDown(tree, { key: 'Enter' });
    expect(await screen.findByText('line two')).toBeTruthy();
    expect(screen.getByLabelText('File contents').textContent).toMatch(/^1line one2line two$/);
  });

  it('renders Markdown in a frame that cannot run scripts, with a Source view', async () => {
    show('?tab=files&file=README.md');
    const frame = (await screen.findByTitle('Preview of README.md')) as HTMLIFrameElement;
    expect(frame.getAttribute('sandbox')).not.toContain('allow-scripts');
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toContain('<h1>Title</h1>');
    expect(frame.getAttribute('srcdoc')).toContain("default-src 'none'");
    fireEvent.click(screen.getByRole('button', { name: 'Source' }));
    expect(await screen.findByText('# Title')).toBeTruthy();
  });

  it('gives a framed page dark scrollbars in the dark theme, and follows a switch', async () => {
    document.documentElement.dataset.theme = 'light';
    show('?tab=files&file=README.md');
    const frame = (await screen.findByTitle('Preview of README.md')) as HTMLIFrameElement;
    expect(frame.getAttribute('srcdoc')).not.toContain('scrollbar-color');
    expect(frame.getAttribute('srcdoc')).toContain('color-scheme:light');
    act(() => {
      document.documentElement.dataset.theme = 'dark';
      window.dispatchEvent(new Event('pm-theme')); // What applyTheme does after switching.
    });
    const doc = () => screen.getByTitle('Preview of README.md').getAttribute('srcdoc');
    await waitFor(() => expect(doc()).toContain('scrollbar-color'));
    expect(doc()).toContain('color-scheme:dark');
    delete document.documentElement.dataset.theme;
  });

  it('opens the folders above a linked file', async () => {
    show('?tab=files&file=docs/guide.ts');
    const tree = await screen.findByRole('tree');
    await waitFor(() =>
      expect(tree.querySelector('[data-path="docs/guide.ts"]')?.getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
  });
});

describe('context menu', () => {
  const rowOf = (tree: HTMLElement, path: string) =>
    tree.querySelector<HTMLElement>(`[data-path="${path}"]`)!;

  it('opens on right click with the actions for that entry, and Escape closes it', async () => {
    show();
    const tree = await screen.findByRole('tree');
    fireEvent.contextMenu(rowOf(tree, 'README.md'), { clientX: 30, clientY: 40 });
    const menu = screen.getByRole('menu', { name: 'Actions for README.md' });
    expect([...menu.querySelectorAll('[role=menuitem]')].map((i) => i.textContent)).toEqual([
      'Open in preview',
      'Open in system app',
      'Reveal in file manager',
      'Copy path',
      'Copy relative path',
      'Rename…',
    ]);
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens from the keyboard with Shift+F10 and the Menu key', async () => {
    show();
    const tree = await screen.findByRole('tree');
    const first = rowOf(tree, 'docs');
    first.focus();
    fireEvent.focusIn(first);
    fireEvent.keyDown(tree, { key: 'F10', shiftKey: true });
    expect(screen.getByRole('menu', { name: 'Actions for docs' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Expand folder' })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.keyDown(tree, { key: 'ContextMenu' });
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('has a touch-friendly actions button on each row', async () => {
    show();
    const tree = await screen.findByRole('tree');
    fireEvent.click(
      within(rowOf(tree, 'README.md')).getByRole('button', { name: 'Actions for README.md' }),
    );
    expect(screen.getByRole('menu', { name: 'Actions for README.md' })).toBeTruthy();
    // The button did not also open the file.
    expect(screen.queryByLabelText('File contents')).toBeNull();
  });

  it('asks the host to open or reveal, and shows its refusal', async () => {
    show();
    const tree = await screen.findByRole('tree');
    fireEvent.contextMenu(rowOf(tree, 'README.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reveal in file manager' }));
    await waitFor(() => expect(api.openProjectFile).toHaveBeenCalledWith(1, 'README.md', 'reveal'));
    vi.mocked(api.openProjectFile).mockRejectedValueOnce(new Error('Only on the host computer'));
    fireEvent.contextMenu(rowOf(tree, 'README.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Open in system app' }));
    expect(await screen.findByText('Only on the host computer')).toBeTruthy();
  });

  it('copies the absolute path in the project style, and the relative path', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    show();
    const tree = await screen.findByRole('tree');
    fireEvent.contextMenu(rowOf(tree, 'README.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy path' }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith('S:\\Vibe Coding\\Demo\\README.md'),
    );
    fireEvent.contextMenu(rowOf(tree, 'README.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy relative path' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('README.md'));
    expect(await screen.findByRole('status')).toBeTruthy();
  });

  it('renames in place only on Enter, and the tree follows', async () => {
    show();
    const tree = await screen.findByRole('tree');
    fireEvent.contextMenu(rowOf(tree, 'README.md'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const field = (await screen.findByLabelText('New name for README.md')) as HTMLInputElement;
    expect(field.value).toBe('README.md');
    // Typing and arrow keys stay in the field.
    fireEvent.change(field, { target: { value: 'GUIDE.md' } });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    expect(api.renameProjectFile).not.toHaveBeenCalled();
    fireEvent.keyDown(field, { key: 'Enter' });
    await waitFor(() =>
      expect(api.renameProjectFile).toHaveBeenCalledWith(1, 'README.md', 'GUIDE.md'),
    );
    await waitFor(() => expect(tree.querySelector('[data-path="GUIDE.md"]')).toBeTruthy());
    expect(tree.querySelector('[data-path="README.md"]')).toBeNull();
  });

  it('cancels on Escape and when the field loses focus, without renaming', async () => {
    vi.mocked(api.renameProjectFile).mockClear();
    show();
    const tree = await screen.findByRole('tree');
    const start = async () => {
      fireEvent.keyDown(tree, { key: 'F2' });
      return (await screen.findByLabelText(/New name for/)) as HTMLInputElement;
    };
    const first = tree.querySelector<HTMLElement>('[data-path]')!;
    first.focus();
    fireEvent.focusIn(first);
    let field = await start();
    fireEvent.change(field, { target: { value: 'other' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByLabelText(/New name for/)).toBeNull();
    field = await start();
    fireEvent.change(field, { target: { value: 'other' } });
    fireEvent.blur(field);
    expect(screen.queryByLabelText(/New name for/)).toBeNull();
    expect(api.renameProjectFile).not.toHaveBeenCalled();
  });

  it('shows the server refusal and keeps the old name', async () => {
    vi.mocked(api.renameProjectFile).mockRejectedValueOnce(
      new Error('"x" already exists in this folder'),
    );
    show();
    const tree = await screen.findByRole('tree');
    fireEvent.contextMenu(rowOf(tree, 'dist'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Rename…' }));
    const field = await screen.findByLabelText('New name for dist');
    fireEvent.change(field, { target: { value: 'x' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(await screen.findByText('"x" already exists in this folder')).toBeTruthy();
    expect(tree.querySelector('[data-path="dist"]')).toBeTruthy();
  });
});

describe('path helpers', () => {
  it('builds absolute paths in the project style and remaps renamed prefixes', () => {
    expect(absolutePath('S:\\a\\b', 'src/x.ts')).toBe('S:\\a\\b\\src\\x.ts');
    expect(absolutePath('S:\\a\\b\\', '')).toBe('S:\\a\\b');
    expect(absolutePath('/home/me/p', 'src/x.ts')).toBe('/home/me/p/src/x.ts');
    expect(remapPath('src/a/b.ts', 'src', 'lib')).toBe('lib/a/b.ts');
    expect(remapPath('src', 'src', 'lib')).toBe('lib');
    expect(remapPath('srcx/a', 'src', 'lib')).toBe('srcx/a');
    expect(fileMenuItems(entry('d', 'dir'), true)[0]!.label).toBe('Collapse folder');
  });
});

describe('paths', () => {
  it('joins relative paths inside the project only', () => {
    expect(joinPath('docs', 'img/a.png')).toBe('docs/img/a.png');
    expect(joinPath('docs/deep', '../a.png')).toBe('docs/a.png');
    expect(joinPath('', './a%20b.png?x=1')).toBe('a b.png');
    expect(joinPath('docs', '../../x')).toBeNull();
    expect(foldersTo('a/b/c.ts')).toEqual(['', 'a', 'a/b']);
    expect(foldersTo(null)).toEqual(['']);
  });
});
