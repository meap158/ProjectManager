import { lstat, open, opendir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  FilePreview,
  FolderInfo,
  FolderItem,
  GitMark,
  FolderListing,
  TreeEntry,
} from '../shared/types.js';
import { isAvailable, run } from './analysis/exec.js';
import { HEADER_BYTES, hasImageSize, readImageSize } from './imageSize.js';

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
        width: null,
        height: null,
        git: null,
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
  // Sizes of pictures and git state, read after the listing so a failure of either costs only its badge.
  await Promise.all([addImageSizes(realRoot, items), addGitMarks(realRoot, dir, items)]);
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

/** Pictures looked at per listing (the header of each is read: a few KB). */
const MAX_SIZED = 400;

/** The size of each picture, read from the start of its file, a few at a time. */
async function addImageSizes(realRoot: string, items: FolderItem[]): Promise<void> {
  const targets = items
    .filter((i) => i.kind === 'file' && !i.symlink && hasImageSize(path.extname(i.name).slice(1)))
    .slice(0, MAX_SIZED);
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      const item = targets[next++]!;
      let handle;
      try {
        handle = await open(path.join(realRoot, item.path), 'r');
        const buffer = Buffer.alloc(HEADER_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
        const size = readImageSize(buffer.subarray(0, bytesRead), path.extname(item.name).slice(1));
        if (size) {
          item.width = size.width;
          item.height = size.height;
        }
      } catch {
        // Unreadable: no size shown.
      } finally {
        await handle?.close().catch(() => undefined);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(16, targets.length) }, worker));
}

/** How git reports one status line: two letters, X (staged) and Y (working tree). */
export function gitMarkOf(code: string): GitMark {
  const [x, y] = [code[0] ?? ' ', code[1] ?? ' '];
  if (x === '?' && y === '?') return 'untracked';
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D'))
    return 'conflict';
  if (x === 'A') return 'added';
  return 'modified';
}

/**
 * Marks entries that differ from the last commit, with one `git status` for the whole listing (never
 * one per file). A folder is marked when something inside it is. Read only; not a repository, no git,
 * or a slow answer just means no marks.
 */
async function addGitMarks(realRoot: string, dir: string, items: FolderItem[]): Promise<void> {
  if (items.length === 0 || !(await isAvailable('git'))) return;
  try {
    const prefix = (
      await run('git', ['rev-parse', '--show-prefix'], { cwd: realRoot, timeoutMs: 5_000 })
    ).stdout.trim();
    const rel = toRel(realRoot, dir) || '.';
    const { stdout } = await run(
      'git',
      ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=normal', '--', rel],
      { cwd: realRoot, timeoutMs: 8_000 },
    );
    const changes: { path: string; mark: GitMark }[] = [];
    for (const line of stdout.split('\0')) {
      if (line.length < 4) continue;
      let changed = line.slice(3).replace(/\/$/, '');
      if (prefix) {
        if (!changed.startsWith(prefix)) continue;
        changed = changed.slice(prefix.length);
      }
      changes.push({ path: changed, mark: gitMarkOf(line.slice(0, 2)) });
    }
    for (const item of items) {
      if (item.kind === 'file') {
        item.git = changes.find((c) => c.path === item.path)?.mark ?? null;
      } else {
        const inside = changes.filter(
          (c) => c.path === item.path || c.path.startsWith(`${item.path}/`),
        );
        if (inside.some((c) => c.mark === 'conflict')) item.git = 'conflict';
        else if (inside.some((c) => c.mark !== 'untracked')) item.git = 'modified';
        else if (inside.length > 0) item.git = 'untracked';
      }
    }
  } catch {
    // No marks.
  }
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
/** What a raw read needs to know before sending any bytes: whether it is allowed, and a validator. */
export async function rawMeta(
  root: string,
  rel: string,
): Promise<{ abs: string; size: number; mtimeMs: number; type: string }> {
  const abs = await resolveInside(root, rel);
  const info = await stat(abs);
  if (!info.isFile()) throw new FileAccessError(400, 'Not a file');
  if (info.size > MAX_RAW_BYTES) throw new FileAccessError(413, 'File is too large to preview');
  return {
    abs,
    size: info.size,
    mtimeMs: info.mtimeMs,
    type: RAW_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream',
  };
}

/** A validator that changes when the file does (size and modified time), so a browser can ask
 * "has it changed?" and get an empty 304 instead of the bytes again (thumbnails over LAN or tunnel). */
export const rawEtag = (meta: { size: number; mtimeMs: number }): string =>
  `W/"${meta.size.toString(16)}-${Math.round(meta.mtimeMs).toString(16)}"`;

export async function readRaw(root: string, rel: string): Promise<{ bytes: Buffer; type: string }> {
  const { abs } = await rawMeta(root, rel);
  const handle = await open(abs, 'r');
  try {
    const bytes = await handle.readFile();
    const type = RAW_TYPES[path.extname(abs).toLowerCase()] ?? 'application/octet-stream';
    return { bytes, type };
  } finally {
    await handle.close();
  }
}
