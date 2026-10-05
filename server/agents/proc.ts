// One interface over the two ways we run agent processes:
//  - PTY (node-pty, optional dependency): a real pseudo-terminal, so interactive CLIs such as
//    `claude`, `codex` or a shell render their full-screen UI and take raw keystrokes.
//    Plain pipes can't do this: interactive `claude` on a pipe waits for EOF and prints nothing.
//  - Pipes: always available, line-based, used for one-shot runs and as the PTY fallback.
// Callers pass an argv already resolved for a shell-free spawn (see resolve.ts).

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import type { AgentTerminal } from '../../shared/types.js';

export interface AgentProc {
  readonly pid: number | undefined;
  readonly terminal: AgentTerminal;
  write(data: string): boolean;
  resize(cols: number, rows: number): void;
  onData(listener: (text: string) => void): void;
  onExit(listener: (code: number | null, signal: string | null) => void): void;
  onError(listener: (error: Error) => void): void;
}

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

type NodePty = typeof import('node-pty');
let ptyModule: NodePty | null | undefined;

/** node-pty when it is installed and loads on this platform, otherwise null (cached). */
export function loadPty(): NodePty | null {
  if (ptyModule !== undefined) return ptyModule;
  if (process.env.AGENT_PTY === 'off') return (ptyModule = null);
  try {
    // createRequire: node-pty is CommonJS with a native addon; a static import would make the
    // whole server fail to start where the optional dependency is missing.
    ptyModule = createRequire(import.meta.url)('node-pty') as NodePty;
  } catch {
    ptyModule = null;
  }
  return ptyModule;
}

export function ptyAvailable(): boolean {
  return loadPty() !== null;
}

export function spawnPty(argv: string[], options: SpawnOptions): AgentProc {
  const pty = loadPty();
  if (!pty) throw new Error('PTY support (node-pty) is not available');
  const proc = pty.spawn(argv[0]!, argv.slice(1), {
    name: 'xterm-256color',
    cols: options.cols ?? 120,
    rows: options.rows ?? 30,
    cwd: options.cwd,
    env: options.env,
  });
  let exited = false;
  return {
    pid: proc.pid,
    terminal: 'pty',
    write: (data) => {
      if (exited) return false;
      proc.write(data);
      return true;
    },
    resize: (cols, rows) => {
      if (!exited) proc.resize(Math.max(20, cols), Math.max(5, rows));
    },
    onData: (listener) => {
      proc.onData(listener);
    },
    onExit: (listener) => {
      proc.onExit(({ exitCode, signal }) => {
        exited = true;
        listener(exitCode, signal ? String(signal) : null);
      });
    },
    // node-pty reports spawn failures by throwing from spawn() or via a non-zero exit.
    onError: () => undefined,
  };
}

export function spawnPipe(argv: string[], options: SpawnOptions & { stdin: boolean }): AgentProc {
  const proc = spawn(argv[0]!, argv.slice(1), {
    cwd: options.cwd,
    env: options.env,
    stdio: [options.stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    detached: true,
    windowsHide: true,
  });
  return {
    pid: proc.pid,
    terminal: 'pipe',
    write: (data) => {
      if (!proc.stdin?.writable || proc.exitCode !== null || proc.killed) return false;
      try {
        proc.stdin.write(data);
        return true;
      } catch {
        return false;
      }
    },
    resize: () => undefined,
    onData: (listener) => {
      proc.stdout!.on('data', (d: Buffer) => listener(d.toString('utf8')));
      proc.stderr!.on('data', (d: Buffer) => listener(d.toString('utf8')));
    },
    onExit: (listener) => {
      proc.on('exit', (code, signal) => listener(code, signal));
    },
    onError: (listener) => {
      proc.on('error', listener);
    },
  };
}

/**
 * Variables that describe the *session that launched ProjectManager* (e.g. when it is started
 * from inside Claude Code). Agents must start as independent top-level sessions: inheriting these
 * makes `claude` act as a nested child (transcripts off, different input handling) and would hand
 * agents the parent's messaging socket/token. User configuration (CLAUDE_CODE_USE_BEDROCK,
 * ANTHROPIC_*, …) is deliberately kept.
 */
const SESSION_MARKERS = new Set([
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_SSE_PORT',
]);
const SESSION_MARKER_PREFIXES = ['CLAUDE_CODE_SESSION', 'CLAUDE_CODE_MESSAGING'];

export function isSessionMarker(name: string): boolean {
  const upper = name.toUpperCase();
  return SESSION_MARKERS.has(upper) || SESSION_MARKER_PREFIXES.some((p) => upper.startsWith(p));
}

/** Env for agent processes: strings only (node-pty rejects undefined), launcher-session markers
    removed, plus explicit overrides. */
export function processEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !isSessionMarker(k)) env[k] = v;
  }
  return { ...env, ...extra };
}
