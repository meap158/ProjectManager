import { spawn } from 'node:child_process';
import { lstat, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { FileAccessError, resolveInside } from './projectFiles.js';

// The Files tab's context menu (PM-259): rename, open in the system app, reveal in the file
// manager. Unlike the rest of the Files code this writes inside a tracked project, so it is
// deliberately narrow: one entry is renamed in its own folder, never moved, never overwriting, and
// never touching .git; system actions use an argument array (no shell) and refuse files the
// system would run. The routes answer on this computer only.

const HIDDEN = new Set(['.git']);
/** Names Windows reserves (with or without an extension); refused everywhere so projects stay portable. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
// eslint-disable-next-line no-control-regex
const FORBIDDEN_CHARS = /[\\/:*?"<>|\u0000-\u001f]/;

/** The reason a new name is not acceptable as a single file or folder name, or null. */
export function invalidName(name: string): string | null {
  if (!name.trim()) return 'Enter a name';
  if (name !== name.trim()) return 'A name cannot start or end with a space';
  if (name.length > 255) return 'That name is too long';
  if (name === '.' || name === '..') return 'That is not a valid name';
  if (FORBIDDEN_CHARS.test(name))
    return 'A name cannot contain / \\ : * ? " < > | or control characters';
  if (name.endsWith('.')) return 'A name cannot end with a dot';
  if (RESERVED.test(name)) return 'That name is reserved by Windows';
  if (HIDDEN.has(name.toLowerCase())) return 'That name is reserved by git';
  return null;
}

/**
 * Renames one entry inside its own folder and returns its new project-relative path. Refuses the
 * project root, anything in .git, anything that would leave the project (the parent folder's real
 * path is checked, so a link out is refused), and an existing target (no overwrite). A link is
 * renamed as the link, never followed. A change of letter case alone is allowed on
 * case-insensitive disks, where the "existing" target is the entry itself.
 */
export async function renameEntry(root: string, rel: string, newName: string): Promise<string> {
  const clean = rel.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  if (!clean) throw new FileAccessError(400, 'The project folder cannot be renamed here');
  const parts = clean.split('/');
  if (parts.some((p) => HIDDEN.has(p.toLowerCase()))) throw new FileAccessError(404, 'Not found');
  const problem = invalidName(newName);
  if (problem) throw new FileAccessError(400, problem);

  const base = parts.pop()!;
  const parent = await resolveInside(root, parts.join('/')); // inside the project, symlinks resolved
  const from = path.join(parent, base);
  const source = await lstat(from).catch(() => {
    throw new FileAccessError(404, 'Not found');
  });
  const to = path.join(parent, newName);
  if (to === from) return [...parts, newName].join('/');

  const existing = await lstat(to).catch(() => null);
  if (existing) {
    const sameEntry =
      existing.ino !== 0 && existing.ino === source.ino && existing.dev === source.dev;
    if (!sameEntry || base.toLowerCase() !== newName.toLowerCase())
      throw new FileAccessError(409, `"${newName}" already exists in this folder`);
  }
  await rename(from, to).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'EPERM' || error.code === 'EBUSY' || error.code === 'EACCES')
      throw new FileAccessError(409, 'It is in use by another program; close it and try again');
    throw error;
  });
  return [...parts, newName].join('/');
}

/** Files the system would run, not open: never started from here (Reveal still works). */
const RUNNABLE = new Set([
  'exe',
  'com',
  'bat',
  'cmd',
  'msi',
  'msp',
  'scr',
  'pif',
  'lnk',
  'url',
  'reg',
  'ps1',
  'psm1',
  'vbs',
  'vbe',
  'js',
  'jse',
  'wsf',
  'wsh',
  'hta',
  'cpl',
  'jar',
  'dll',
  'sh',
  'bash',
  'command',
  'app',
  'appimage',
  'desktop',
  'run',
  'apk',
  'dmg',
  'pkg',
  'deb',
  'rpm',
]);

export type OpenMode = 'open' | 'reveal';

/** The command for an action, as an argument array (never a shell string). Pure, for tests. */
export function openCommand(
  platform: NodeJS.Platform,
  target: string,
  mode: OpenMode,
  isDir: boolean,
): { command: string; args: string[]; verbatim: boolean } {
  if (platform === 'win32') {
    if (mode === 'reveal')
      // Explorer wants /select,"path" as written, not the whole argument quoted.
      return { command: 'explorer.exe', args: [`/select,"${target}"`], verbatim: true };
    return isDir
      ? { command: 'explorer.exe', args: [target], verbatim: false }
      : { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', target], verbatim: false };
  }
  if (platform === 'darwin')
    return {
      command: 'open',
      args: mode === 'reveal' ? ['-R', target] : [target],
      verbatim: false,
    };
  return {
    command: 'xdg-open',
    args: [mode === 'reveal' && !isDir ? path.dirname(target) : target],
    verbatim: false,
  };
}

/** Opens a project entry in the system's app, or shows it in the file manager. */
export async function openEntry(
  root: string,
  rel: string,
  mode: OpenMode,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  const target = await resolveInside(root, rel); // '' is the project folder itself
  const info = await stat(target);
  const isDir = info.isDirectory();
  if (mode === 'open' && !isDir) {
    const ext = path.extname(target).slice(1).toLowerCase();
    // Extensionless files (LICENSE, Makefile) open as text, unless the file is marked executable.
    const executable = platform !== 'win32' && (info.mode & 0o111) !== 0;
    if (RUNNABLE.has(ext) || executable)
      throw new FileAccessError(
        400,
        'This kind of file would run instead of open; use "Reveal in file manager"',
      );
  }
  const { command, args, verbatim } = openCommand(platform, target, mode, isDir);
  const child = spawn(command, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    windowsVerbatimArguments: verbatim,
  });
  child.on('error', (e) => console.error('[open-entry]', e.message));
  child.unref();
}
