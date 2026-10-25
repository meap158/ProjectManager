// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FilePin, FolderListing, TreeEntry } from '../../../shared/types';

const entry = (path: string, kind: 'dir' | 'file', ignored = false): TreeEntry => ({
  name: path.split('/').pop()!,
  path,
  kind,
  size: kind === 'file' ? 12 : null,
  ignored,
  symlink: false,
});
const PINS: FilePin[] = [];
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
    folderInfo: vi.fn(async (_id: number, path: string) => ({
      path,
      recursive: false,
      folders: 0,
      files: 1,
      totalSize: 12,
      newest: new Date().toISOString(),
      truncated: false,
      items: [
        {
          name: 'guide.ts',
          path: `${path}/guide.ts`,
          kind: 'file',
          size: 12,
          mtime: new Date().toISOString(),
          ctime: new Date().toISOString(),
          ignored: false,
          symlink: false,
        },
      ],
    })),
    filePins: vi.fn(async () => ({ pins: PINS })),
    pinFile: vi.fn(async () => ({ id: 9 })),
    unpinFile: vi.fn(async () => undefined),
    moveFilePin: vi.fn(async () => undefined),
  },
}));

const { api } = await import('../api');
const {
  ProjectFiles,
  joinPath,
  foldersTo,
  absolutePath,
  remapPath,
  fileMenuItems,
  projectLinkHref,
  rewriteRelative,
  buildFrameDocument,
} = await import('./ProjectFiles');

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

  it('renders Markdown in a sandboxed frame that only runs its own click handler, with a Source view', async () => {
    show('?tab=files&file=README.md');
    const frame = (await screen.findByTitle('Preview of README.md')) as HTMLIFrameElement;
    // Scripts are allowed only so the one nonce'd click script can run; the CSP blocks any other.
    expect(frame.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(frame.getAttribute('srcdoc')).toMatch(/script-src 'nonce-[a-z0-9]+'/);
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
    // The new page loads in the frame behind the visible one and takes over when it has loaded, so
    // look at every frame for it.
    const doc = () =>
      [...document.querySelectorAll('iframe.files-frame')]
        .map((f) => f.getAttribute('srcdoc'))
        .find((d) => d?.includes('color-scheme:dark')) ?? '';
    await waitFor(() => expect(doc()).toContain('scrollbar-color'), { timeout: 4000 });
    expect(doc()).toContain('color-scheme:dark');
    delete document.documentElement.dataset.theme;
  });

  it('switches to another file when the frame asks, without a page load', async () => {
    show('?tab=files&file=README.md');
    const frame = (await screen.findByTitle('Preview of README.md')) as HTMLIFrameElement;
    // A message from some other window is ignored.
    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: { pmFile: 'docs/guide.ts' } }));
    });
    expect(screen.queryByTitle('Preview of docs/guide.ts')).toBeNull();
    // From the frame itself it opens that file, and the tree opens docs and marks the row. The
    // listener is attached in an effect, so the message is sent until it has been picked up.
    await waitFor(() => {
      act(() => {
        window.dispatchEvent(
          new MessageEvent('message', {
            data: { pmFile: 'docs/guide.ts' },
            source: frame.contentWindow,
          }),
        );
      });
      expect(screen.getByText('line two')).toBeTruthy();
    });
    const tree = screen.getByRole('tree');
    await waitFor(() =>
      expect(tree.querySelector('[data-path="docs/guide.ts"]')?.getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    // A path that leaves the project, or is not a string, does nothing.
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { pmFile: '../../etc/x' },
          source: frame.contentWindow,
        }),
      );
    });
    expect(screen.queryByText('../../etc/x')).toBeNull();
  });

  it("shows a selected folder's contents in the right pane, and a file from it keeps the way back", async () => {
    show();
    const tree = await screen.findByRole('tree');
    await waitFor(() => expect(tree.querySelector('[data-path="docs"]')).not.toBeNull());
    fireEvent.click(screen.getByText('docs'));
    // The folder previewer replaces the pane, instead of leaving the last file up.
    expect(await screen.findByRole('navigation', { name: 'Folder path' })).toBeTruthy();
    expect(await screen.findByText(/1 file · 0 folders/)).toBeTruthy();
    expect(tree.querySelector('[data-path="docs"]')?.getAttribute('aria-selected')).toBe('true');
    // Opening a file from it shows the file; "Files" goes back to the folder, not to nothing.
    fireEvent.click(await screen.findByText('guide.ts', { selector: '.fv-name' }));
    expect(await screen.findByText('line two')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '← Files' }));
    expect(await screen.findByRole('navigation', { name: 'Folder path' })).toBeTruthy();
  });

  it('a pinned folder opens like the folder in the tree: its contents on the right, the tree following', async () => {
    PINS.length = 0;
    PINS.push({ id: 5, path: 'docs', scope: 'project', kind: 'dir' });
    try {
      show();
      const section = await screen.findByRole('region', { name: 'Pinned' });
      fireEvent.click(within(section).getByTitle('docs'));
      expect(await screen.findByRole('navigation', { name: 'Folder path' })).toBeTruthy();
      const tree = screen.getByRole('tree');
      await waitFor(() =>
        expect(tree.querySelector('[data-path="docs"]')?.getAttribute('aria-selected')).toBe(
          'true',
        ),
      );
    } finally {
      PINS.length = 0;
    }
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
      'Pin to this project',
      'Pin to all projects (this path)',
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

describe('pinned items', () => {
  const pinned = (
    id: number,
    path: string,
    scope: 'project' | 'all',
    kind: 'file' | 'dir' | null,
  ) => ({ id, path, scope, kind }) as FilePin;

  it('offers pin and unpin per scope in the menu', () => {
    const e = entry('docs', 'dir');
    const labels = (state?: { project: boolean; all: boolean }) =>
      fileMenuItems(e, false, state).map((i) => `${i.command}:${i.label}`);
    expect(labels()).toContain('pin-project:Pin to this project');
    expect(labels()).toContain('pin-all:Pin to all projects (this path)');
    const both = labels({ project: true, all: true });
    expect(both).toContain('unpin-project:Unpin from this project');
    expect(both).toContain('unpin-all:Unpin from all projects');
  });

  it('lists pins above the tree, opens one, and marks a missing one', async () => {
    PINS.length = 0;
    PINS.push(pinned(1, 'README.md', 'project', 'file'), pinned(2, 'ROADMAP.md', 'all', null));
    try {
      show();
      const section = await screen.findByRole('region', { name: 'Pinned' });
      expect(within(section).getByText('README.md')).toBeTruthy();
      expect(within(section).getByText('All')).toBeTruthy(); // The all-projects badge.
      expect(within(section).getByText('missing')).toBeTruthy();
      fireEvent.click(within(section).getByTitle('README.md'));
      expect(await screen.findByTitle('Preview of README.md')).toBeTruthy();
    } finally {
      PINS.length = 0;
    }
  });

  it('pins the focused row with Alt+P (this project) and Alt+Shift+P (all projects)', async () => {
    PINS.length = 0;
    show();
    const tree = await screen.findByRole('tree');
    await waitFor(() => expect(tree.querySelector('[data-path="docs"]')).not.toBeNull());
    const row = tree.querySelector<HTMLElement>('[data-path="docs"]')!;
    row.focus();
    fireEvent.focusIn(row);
    fireEvent.keyDown(tree, { key: 'p', altKey: true });
    await waitFor(() => expect(api.pinFile).toHaveBeenCalledWith(1, 'docs', 'project'));
    fireEvent.keyDown(tree, { key: 'P', altKey: true, shiftKey: true });
    await waitFor(() => expect(api.pinFile).toHaveBeenCalledWith(1, 'docs', 'all'));
  });
});

describe('the preview frame document', () => {
  const head =
    '<meta http-equiv="Content-Security-Policy" content="script-src nonce-abc"><base target="_blank">';
  const hostile =
    '<script>alert(1)</script><html><head><title>t</title></head><body onload="x()">' +
    '<a href="javascript:alert(2)" onclick="y()">bad</a><img src=a.png onerror="z()">' +
    '<a href="x.md" data-pm-file="x.md">ok</a><script src="//evil.test/s.js"></script></body></html>';

  it('strips scripts, handlers and javascript: addresses, then puts the policy first', () => {
    const out = buildFrameDocument(hostile, head, 'abc');
    const parsed = new DOMParser().parseFromString(out, 'text/html');
    // Only our script remains, and it carries the nonce.
    const scripts = [...parsed.querySelectorAll('script')];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]!.getAttribute('nonce')).toBe('abc');
    expect(out).not.toMatch(/alert\(/);
    expect(out).not.toMatch(/\sonload=|\sonclick=|\sonerror=/i);
    expect(out).not.toContain('javascript:');
    expect(out).not.toContain('evil.test');
    // The policy is the first thing in the head, ahead of the page's own head content.
    expect(parsed.head.firstElementChild?.getAttribute('http-equiv')).toBe(
      'Content-Security-Policy',
    );
    expect(out.startsWith('<!doctype html>')).toBe(true);
    // The page's own markup is kept.
    expect(parsed.querySelector('a[data-pm-file="x.md"]')?.textContent).toBe('ok');
    expect(parsed.title).toBe('t');
  });

  it('copes with a fragment that has no head or body', () => {
    const out = buildFrameDocument('<p>hello</p><script>boom()</script>', head, 'n1');
    expect(out).toContain('<p>hello</p>');
    expect(out).not.toContain('boom()');
    expect(out).toContain('nonce="n1"');
  });
});

describe('links inside a previewed page', () => {
  const base = 'http://localhost:5180/projects/17';
  it("turns a relative link into this app's address for that file", () => {
    expect(projectLinkHref('owner-desk.html', 'References/owner-pages', base)).toBe(
      `${base}?tab=files&file=${encodeURIComponent('References/owner-pages/owner-desk.html')}`,
    );
    expect(projectLinkHref('../notes/a b.md?x=1#top', 'docs/deep', base)).toBe(
      `${base}?tab=files&file=${encodeURIComponent('docs/notes/a b.md')}`,
    );
  });

  it('reads a leading slash as the project root, like GitHub does', () => {
    expect(projectLinkHref('/docs/guide.md', 'a/b', base)).toBe(
      `${base}?tab=files&file=${encodeURIComponent('docs/guide.md')}`,
    );
  });

  it('opens the Files tab for a folder, and neutralises a path that leaves the project', () => {
    expect(projectLinkHref('src/', '', base)).toBe(`${base}?tab=files`);
    expect(projectLinkHref('/', 'x', base)).toBe(`${base}?tab=files`);
    expect(projectLinkHref('../../outside.md', 'docs', base)).toBe('#');
  });

  it('leaves web addresses, mail links, in-page anchors and empty links alone', () => {
    for (const url of [
      'https://example.com/a',
      'mailto:x@y.z',
      '#section',
      '//cdn.example/x',
      '',
      'javascript:alert(1)',
    ])
      expect(projectLinkHref(url, 'docs', base)).toBeNull();
  });

  it('rewrites only anchors, and still maps assets to the raw route', () => {
    const html =
      '<a href="owner-desk.html">desk</a> <a href="https://x.test/">web</a> <img src="a.png"> <link href="s.css">';
    const out = rewriteRelative(html, '/raw?path=', 'References/owner-pages', base);
    expect(out).toContain(
      `href="${base}?tab=files&file=${encodeURIComponent('References/owner-pages/owner-desk.html')}"`,
    );
    expect(out).toContain('href="https://x.test/"');
    // Project links go to the top window (this tab); a web link keeps the page's own target.
    expect(out).toMatch(
      /<a href="[^"]*owner-desk\.html" target="_top" data-pm-file="References\/owner-pages\/owner-desk\.html">desk<\/a>/,
    );
    expect(out).toContain('<a href="https://x.test/">web</a>');
    expect(
      rewriteRelative('<a target="_blank" href="../x.md">x</a>', '/r?p=', 'a/b', base),
    ).toMatch(/<a href="[^"]*" target="_top" data-pm-file="a\/x\.md">x<\/a>/);
    expect(rewriteRelative('<a href="../../../x">x</a>', '/r?p=', 'a', base)).toContain(
      '<a href="#" target="_self">',
    );
    expect(out).toContain(`src="/raw?path=${encodeURIComponent('References/owner-pages/a.png')}"`);
    expect(out).toContain(`href="/raw?path=${encodeURIComponent('References/owner-pages/s.css')}"`);
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
