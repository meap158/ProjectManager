// Turns an argv into something the OS can execute directly, without a shell.
//
// On Windows, Node can only spawn real executables (.exe/.com) without a shell, but npm-installed
// CLIs (codex, opencode, ...) are `.cmd` shims, and an extensionless sh script sits next to
// each one. Running a .cmd through cmd.exe would expose prompts to cmd's quoting rules (and cmd
// cannot pass newlines at all), so instead we read the npm shim and launch what it points at:
// `node <script.js>` or the bundled `.exe`. Elsewhere, argv is returned as is.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export class ResolveError extends Error {}

/** All PATH matches for a command, in PATH order (`where` on Windows). */
function where(command: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('where', [command], { timeout: 5000, windowsHide: true }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(
        stdout
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean),
      );
    });
  });
}

/**
 * Parses an npm `cmd-shim` file and returns the argv prefix it runs. Handles both shim shapes:
 *   "%_prog%"  "%dp0%\node_modules\pkg\bin\cli.js" %*     (node script)
 *   "%dp0%\node_modules\pkg\bin\tool.exe"   %*            (native binary)
 */
export function parseNpmShim(content: string, shimDir: string): string[] | null {
  const target = content.match(/"%dp0%\\([^"]+)"\s+%\*/);
  if (!target) return null;
  const file = path.join(shimDir, target[1]!);
  if (/\.exe$/i.test(file)) return [file];
  if (/\.[cm]?js$/i.test(file)) {
    // The shim prefers a node.exe next to itself, else node on PATH. Our own runtime is a node
    // binary too and is always present, so use it when the shim has no bundled node.
    return [process.execPath, file];
  }
  return null;
}

/** Resolves argv[0] for a shell-free spawn. Throws ResolveError when it cannot be run safely. */
export async function resolveArgv(argv: string[]): Promise<string[]> {
  if (process.platform !== 'win32' || argv.length === 0) return argv;
  const [command, ...rest] = argv as [string, ...string[]];

  const candidates =
    path.isAbsolute(command) || command.includes('\\') || command.includes('/')
      ? [command]
      : await where(command);
  if (candidates.length === 0) throw new ResolveError(`${command} was not found on PATH`);

  const exe = candidates.find((c) => /\.(exe|com)$/i.test(c));
  if (exe) return [exe, ...rest];

  const shim = candidates.find((c) => /\.(cmd|bat)$/i.test(c));
  if (shim) {
    let prefix: string[] | null;
    try {
      prefix = parseNpmShim(readFileSync(shim, 'utf8'), path.dirname(shim));
    } catch {
      prefix = null;
    }
    if (prefix) return [...prefix, ...rest];
    throw new ResolveError(
      `${path.basename(shim)} is a batch file, which can't be run safely without a shell. ` +
        'Point the command at the underlying executable instead.',
    );
  }
  // Absolute paths to other file types (or extensionless scripts): let the OS decide.
  if (path.isAbsolute(command)) return argv;
  throw new ResolveError(`${command} has no Windows executable on PATH`);
}
