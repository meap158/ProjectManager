// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  },
}));

const { ProjectFiles, joinPath, foldersTo } = await import('./ProjectFiles');

// Files tab (PM-252): the tree loads folders as they open, works from the keyboard, and opens
// previews; rendered previews can't run scripts.

afterEach(cleanup);

const show = (search = '?tab=files') =>
  render(
    <MemoryRouter initialEntries={[`/projects/1${search}`]}>
      <ProjectFiles projectId={1} />
    </MemoryRouter>,
  );

describe('ProjectFiles', () => {
  it('lists the root, greys ignored entries, and opens folders on demand', async () => {
    show();
    const tree = await screen.findByRole('tree', { name: 'Project files' });
    const items = () => [...tree.querySelectorAll('[role=treeitem]')].map((li) => li.textContent);
    expect(items()).toEqual(['▸docs', '▸dist', 'README.md12 B']);
    expect(tree.querySelector('[data-path="dist"]')?.className).toContain('is-ignored');
    fireEvent.click(screen.getByText('docs'));
    await waitFor(() => expect(items()).toContain('guide.ts12 B'));
    expect(tree.querySelector('[data-path="docs"]')?.getAttribute('aria-expanded')).toBe('true');
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
