// Connects the server to the agent session host (ptyHost.ts), starting the host when needed.

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { processEnv } from '../proc.js';
import {
  rendezvousFile,
  type HostMessage,
  type HostRendezvous,
  type HostRequest,
  type HostSessionInfo,
} from './protocol.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// ptyHost.ts in development (run through the same tsx loader as us), ptyHost.js when built.
const HOST_SCRIPT = path.join(here, `ptyHost${path.extname(fileURLToPath(import.meta.url))}`);
const CONNECT_TIMEOUT_MS = 2000;
const START_TIMEOUT_MS = 10_000;

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void };

export interface HostClientEvents {
  data: [key: string, offset: number, data: string];
  exit: [key: string, exitCode: number | null, signal: string | null];
  disconnect: [];
}

export class HostClient extends EventEmitter<HostClientEvents> {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private buffer = '';
  connected = true;

  private constructor(
    private socket: net.Socket,
    readonly hostPid: number,
  ) {
    super();
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.onData(chunk));
    const lost = () => {
      if (!this.connected) return;
      this.connected = false;
      for (const p of this.pending.values()) p.reject(new Error('Session host disconnected'));
      this.pending.clear();
      this.emit('disconnect');
    };
    socket.on('close', lost);
    socket.on('error', lost);
  }

  /** Connects to the data folder's host, starting one if none is running. Null if impossible. */
  static async connect(dataDir: string): Promise<HostClient | null> {
    const existing = await HostClient.tryConnect(dataDir);
    if (existing) return existing;
    const before = readRendezvous(dataDir)?.startedAt;
    startHostProcess(dataDir);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      const current = readRendezvous(dataDir);
      if (!current || current.startedAt === before) continue;
      const client = await HostClient.tryConnect(dataDir);
      if (client) return client;
    }
    return null;
  }

  private static async tryConnect(dataDir: string): Promise<HostClient | null> {
    const rendezvous = readRendezvous(dataDir);
    if (!rendezvous) return null;
    const socket = await new Promise<net.Socket | null>((resolve) => {
      const s = net.connect(rendezvous.socket);
      const timer = setTimeout(() => (s.destroy(), resolve(null)), CONNECT_TIMEOUT_MS);
      s.once('connect', () => (clearTimeout(timer), resolve(s)));
      s.once('error', () => (clearTimeout(timer), resolve(null)));
    });
    if (!socket) return null;
    const client = new HostClient(socket, rendezvous.pid);
    try {
      await Promise.race([
        client.request({ op: 'hello', token: rendezvous.token }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT_MS),
        ),
      ]);
      return client;
    } catch {
      socket.destroy();
      return null;
    }
  }

  request(message: HostRequest): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error('Session host disconnected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, ...message }) + '\n');
    });
  }

  list(): Promise<HostSessionInfo[]> {
    return this.request({ op: 'list' }) as Promise<HostSessionInfo[]>;
  }

  /** Detach without affecting any session. */
  close(): void {
    this.connected = false;
    this.socket.end();
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as HostMessage;
      if ('ev' in message) {
        if (message.ev === 'data') this.emit('data', message.key, message.offset, message.data);
        else this.emit('exit', message.key, message.exitCode, message.signal);
      } else {
        const p = this.pending.get(message.id);
        if (!p) continue;
        this.pending.delete(message.id);
        if (message.ok) p.resolve(message.result);
        else p.reject(new Error(message.error));
      }
    }
  }
}

function readRendezvous(dataDir: string): HostRendezvous | null {
  try {
    return JSON.parse(readFileSync(rendezvousFile(dataDir), 'utf8')) as HostRendezvous;
  } catch {
    return null;
  }
}

/**
 * Starts the host detached and *outside our process tree*: a short-lived intermediate process
 * spawns it and exits, so the host's parent is gone. Killing the server's tree (taskkill /T,
 * the launcher's Ctrl+C) therefore never kills sessions.
 */
function startHostProcess(dataDir: string): void {
  // Never inherit our own node flags (under a test runner they are not a TS loader): built code
  // runs as plain JS, the .ts source through tsx explicitly.
  const loader = HOST_SCRIPT.endsWith('.ts')
    ? ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href]
    : [];
  const hostArgv = [
    process.execPath,
    '--disable-warning=ExperimentalWarning',
    ...loader,
    HOST_SCRIPT,
    '--data-dir',
    dataDir,
  ];
  const intermediate = `const [cmd, ...args] = JSON.parse(process.argv[1]);
require('child_process').spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();`;
  const env = processEnv();
  delete env.PM_LAUNCHER_PID; // The host outlives launchers by design.
  spawn(process.execPath, ['-e', intermediate, JSON.stringify(hostArgv)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  }).unref();
}
