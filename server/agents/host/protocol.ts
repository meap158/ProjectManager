// Wire protocol + rendezvous for the agent session host (see ptyHost.ts).
//
// Newline-delimited JSON over a local socket (a named pipe on Windows). A client must send
// `hello` with the token from <dataDir>/agent-host.json before anything else; the token file is
// only readable by the user, so other local users can neither drive nor read sessions.

import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Live session in the host, addressed by the supervisor's unique key (`session:<id>|<log>`). */
export interface HostSessionInfo {
  key: string;
  pid: number | null;
  alive: boolean;
  exitCode: number | null;
  signal: string | null;
  /** Bytes in the log file (what the host has written so far). */
  logBytes: number;
}

export type HostRequest =
  | { op: 'hello'; token: string }
  | {
      op: 'spawn';
      key: string;
      argv: string[];
      cwd: string;
      env: Record<string, string>;
      cols: number;
      rows: number;
      logPath: string;
      maxLogBytes: number;
    }
  | { op: 'write'; key: string; data: string }
  | { op: 'resize'; key: string; cols: number; rows: number }
  | { op: 'kill'; key: string }
  | { op: 'forget'; key: string }
  | { op: 'list' };

export type HostMessage =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string }
  /** Output: `offset` is the log byte offset where `data` starts (for exact resync). */
  | { ev: 'data'; key: string; offset: number; data: string }
  | { ev: 'exit'; key: string; exitCode: number | null; signal: string | null };

export interface HostRendezvous {
  pid: number;
  socket: string;
  token: string;
  startedAt: string;
}

// Generation 2 rotates full logs instead of suppressing PTY output.
export const HOST_GENERATION = 2;

export function hostSocketPath(dataDir: string, generation?: number): string {
  const identity = path.resolve(dataDir).toLowerCase() + (generation ? `:v${generation}` : '');
  const hash = createHash('sha1').update(identity).digest('hex');
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\projectmanager-agent-host-${hash.slice(0, 16)}`
    : path.join(os.tmpdir(), `pm-agent-host-${hash.slice(0, 16)}.sock`);
}

export const rendezvousFile = (dataDir: string, generation?: number) =>
  path.join(dataDir, generation ? `agent-host-v${generation}.json` : 'agent-host.json');
