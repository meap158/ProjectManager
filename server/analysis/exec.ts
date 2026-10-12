import { execFile } from 'node:child_process';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/**
 * Runs an executable without a shell (arguments are never interpolated into a command line).
 * Rejects on a non-zero exit code.
 */
export function run(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs ?? 120_000,
        maxBuffer: 512 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });
}

const availability = new Map<string, Promise<boolean>>();

/** Checks (once per process) whether a command can be executed, e.g. `git --version`. */
export function isAvailable(command: string, versionArg = '--version'): Promise<boolean> {
  let cached = availability.get(command);
  if (!cached) {
    cached = run(command, [versionArg], { timeoutMs: 10_000 }).then(
      () => true,
      () => false,
    );
    availability.set(command, cached);
  }
  return cached;
}
