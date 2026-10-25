import { lstat, open, opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  FilePreview,
  FolderInfo,
  FolderItem,
  FolderListing,
  TreeEntry,
} from '../shared/types.js';
import { isAvailable, run } from './analysis/exec.js';

// The project page's Files tab (PM-252): a VS Code style tree read one folder at a time, and
// file previews. Read only: nothing here writes inside a tracked project.
//  - Every path is relative to the project and must stay inside it, symlinks included (the real
//    path is checked), so `..` or a link can't reach other folders.
//  - Like VS Code's default file excludes, `.git` is hidden; git-ignored entries are listed but
//    marked, so the tree can grey them out.
//  - Previews are size-capped; binary files are reported, not sent.

export class FileAccessError extends Error {
  constructor(
    public status: 404 | 400 | 409 | 413,
    message: string,
  ) {
    super(message);
  }
}

const HIDDEN = new Set(['.git']);
const MAX_ENTRIES = 5_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_RAW_BYTES = 25 * 1024 * 1024;
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.avif']);

export const RAW_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.css': 'text/css; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

/** The absolute path for a project-relative one, refused when it would leave the project. */
export async function resolveInside(root: string, rel: string): Promise<string> {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').some((part) => part === '..'))
    throw new FileAccessError(400, 'Path is outside the project');
  const realRoot = await realpath(root).catch(() => {
    throw new FileAccessError(404, 'Project folder not found');
  });
  const target = path.resolve(realRoot, clean || '.');
  const real = await realpath(target).catch(() => {
    throw new FileAccessError(404, 'Not found');
  });
  const inside = path.relative(realRoot, real);
  if (inside.startsWith('..') || path.isAbsolute(inside))
    throw new FileAccessError(400, 'Path is outside the project');
  if (clean.split('/').some((part) => HIDDEN.has(part)))
    throw new FileAccessError(404, 'Not found');
  return real;
}

const toRel = (root: string, abs: string) => path.relative(root, abs).split(path.sep).join('/');

/** One folder's entries: folders first, then files, by name (case-insensitive, numeric-aware). */
export async function listFolder(root: string, rel: string): Promise<FolderListing> {
  const dir = await resolveInside(root, rel);
  if (!(await stat(dir)).isDirectory()) throw new FileAccessError(400, 'Not a folder');
  const realRoot = await realpath(root);
  const entries: TreeEntry[] = [];
  let truncated = false;
  for await (const dirent of await opendir(dir)) {
    if (HIDDEN.has(dirent.name)) continue;
    if (entries.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const abs = path.join(dir, dirent.name);
    const symlink = dirent.isSymbolicLink();
    // A link counts as what it points to, when that is still inside the project.
    const info = symlink ? await stat(abs).catch(() => null) : null;
    const isDir = symlink ? !!info?.isDirectory() : dirent.isDirectory();
    entries.push({
      name: dirent.name,
      path: toRel(realRoot, abs),
      kind: isDir ? 'dir' : 'file',
      size: null,
      ignored: false,
      symlink,
    });
  }
  await Promise.all(
    entries
      .filter((e) => e.kind === 'file')
      .map(async (e) => {
        e.size = (await lstat(path.join(realRoot, e.path)).catch(() => null))?.size ?? null;
      }),
  );
  // Folders end in "/" so folder-only rules ("node_modules/") match them.
  const asked = entries.map((e) => (e.kind === 'dir' ? `${e.path}/` : e.path));
  for (const ignored of await gitIgnored(realRoot, asked)) {
    const entry = entries.find((e) => e.path === ignored);
    if (entry) entry.ignored = true;
  }
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  entries.sort((a, b) =>
    a.kind === b.kind ? collator.compare(a.name, b.name) : a.kind === 'dir' ? -1 : 1,
  );
  return { path: toRel(realRoot, dir), entries, truncated };
}

/** Folders a recursive listing never enters: huge, generated, and not what asset tracking is for. */
const SKIPPED_WHEN_RECURSIVE = new Set(['node_modules', '.git']);
/** Entries looked at in one recursive walk, however many are returned. */
const MAX_WALK = 20_000;
export const DEFAULT_FOLDER_LIMIT = 2_000;
export const MAX_FOLDER_LIMIT = 5_000;

/**
 * A folder's contents with sizes and times, for the previewer. One level, or the whole tree below
 * it. Read only and bounded: `limit` items are returned (and the walk looks at no more than
 * MAX_WALK entries), `truncated` says more exist. Links are listed as what they are and never
 * followed, so a link cannot lead the walk outside the project; node_modules and .git are not
 * entered.
 */
export async function folderInfo(
  root: string,
  rel: string,
  options: { recursive?: boolean; limit?: number } = {},
): Promise<FolderInfo> {
  const recursive = options.recursive === true;
  const limit = Math.max(1, Math.min(MAX_FOLDER_LIMIT, options.limit ?? DEFAULT_FOLDER_LIMIT));
  const dir = await resolveInside(root, rel);
  if (!(await stat(dir)).isDirectory()) throw new FileAccessError(400, 'Not a folder');
  const realRoot = await realpath(root);
  const items: FolderItem[] = [];
  let truncated = false;
  let walked = 0;
  const queue = [dir];
  while (queue.length > 0 && !truncated) {
    const current = queue.shift()!;
    let handle;
    try {
      handle = await opendir(current);
    } catch {
      continue; // Unreadable folder: skipped, not fatal.
    }
    for await (const dirent of handle) {
      if (HIDDEN.has(dirent.name)) continue;
      if (++walked > MAX_WALK || items.length >= limit) {
        truncated = true;
        break;
      }
      const abs = path.join(current, dirent.name);
      const info = await lstat(abs).catch(() => null);
      if (!info) continue;
      const symlink = info.isSymbolicLink();
      const isDir = !symlink && info.isDirectory();
      items.push({
        name: dirent.name,
        path: toRel(realRoot, abs),
        kind: isDir ? 'dir' : 'file',
        size: isDir ? null : info.size,
        mtime: info.mtime.toISOString(),
        ctime: (info.birthtimeMs > 0 ? info.birthtime : info.ctime).toISOString(),
        ignored: false,
        symlink,
      });
      if (isDir && recursive && !SKIPPED_WHEN_RECURSIVE.has(dirent.name)) queue.push(abs);
    }
  }
  if (!recursive) {
    const asked = items.map((e) => (e.kind === 'dir' ? `${e.path}/` : e.path));
    for (const ignored of await gitIgnored(realRoot, asked)) {
      const item = items.find((e) => e.path === ignored);
      if (item) item.ignored = true;
    }
  }
  const files = items.filter((i) => i.kind === 'file');
  const newest = files.reduce<string | null>(
    (latest, f) => (f.mtime && (!latest || f.mtime > latest) ? f.mtime : latest),
    null,
  );
  return {
    path: toRel(realRoot, dir),
    items,
    recursive,
    folders: items.length - files.length,
    files: files.length,
    totalSize: files.reduce((sum, f) => sum + (f.size ?? 0), 0),
    newest,
    truncated,
  };
}

/** Which of these project-relative paths git ignores (none when it isn't a git repo). */
async function gitIgnored(root: string, paths: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  if (paths.length === 0 || !(await isAvailable('git'))) return out;
  // Batches keep each command line well under Windows' 32K character limit.
  for (let i = 0; i < paths.length; i += 150) {
    const batch = paths.slice(i, i + 150);
    // (-z only works with --stdin, which `run` has no way to feed: one path per line instead.)
    let stdout: string;
    try {
      ({ stdout } = await run('git', ['-c', 'core.quotepath=off', 'check-ignore', '--', ...batch], {
        cwd: root,
        timeoutMs: 15_000,
      }));
    } catch (error) {
      // Exit 1: none of them is ignored. 128: not a repository. Either way, nothing to mark.
      stdout = (error as { stdout?: string }).stdout ?? '';
    }
    for (const line of stdout.split(/\r?\n/)) if (line) out.add(line.replace(/\/$/, ''));
  }
  return out;
}

/** A file's preview: its text (capped), or what kind of file it is. */
export async function previewFile(root: string, rel: string): Promise<FilePreview> {
  const abs = await resolveInside(root, rel);
  const info = await stat(abs);
  if (!info.isFile()) throw new FileAccessError(400, 'Not a file');
  const base = {
    path: toRel(await realpath(root), abs),
    size: info.size,
    mtime: info.mtime.toISOString(),
  };
  if (IMAGE.has(path.extname(abs).toLowerCase())) return { kind: 'image', ...base };
  if (info.size > MAX_TEXT_BYTES) return { kind: 'too-large', ...base };
  const content = await readFile(abs);
  // A NUL byte in the first 8 KB: binary, as git and VS Code decide.
  if (content.subarray(0, 8192).includes(0)) return { kind: 'binary', ...base };
  return { kind: 'text', ...base, content: content.toString('utf8') };
}

/** A file's bytes for previews that need them (images, a page's styles), size-capped. */
export async function readRaw(root: string, rel: string): Promise<{ bytes: Buffer; type: string }> {
  const abs = await resolveInside(root, rel);
  const info = await stat(abs);
  if (!info.isFile()) throw new FileAccessError(400, 'Not a file');
  if (info.size > MAX_RAW_BYTES) throw new FileAccessError(413, 'File is too large to preview');
  const handle = await open(abs, 'r');
  try {
    const bytes = await handle.readFile();
    const type = RAW_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    return { bytes, type };
  } finally {
    await handle.close();
  }
}
