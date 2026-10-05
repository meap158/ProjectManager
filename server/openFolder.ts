import { spawn } from 'node:child_process';

/**
 * Opens a folder in the OS file manager (Explorer, Finder, or the desktop's default). Argument
 * array, no shell; callers pass a tracked project's stored path, never a path from the request.
 * Detached and unref'd: the file manager outlives this request (and this server).
 */
export function openInFileManager(folder: string, platform = process.platform): void {
  const [command, args] =
    platform === 'win32'
      ? ['explorer.exe', [folder]]
      : platform === 'darwin'
        ? ['open', [folder]]
        : ['xdg-open', [folder]];
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('error', (e) => console.error('[open-folder]', e.message));
  child.unref();
}
