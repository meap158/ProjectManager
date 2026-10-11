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
  HOST_GENERATION,
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
  private generation = 0;
  private legacy: HostClient | null = null;
  private legacyKeys = new Set<string>();

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
      this.legacy?.close();
      this.emit('disconnect');
    };
    socket.on('close', lost);
    socket.on('error', lost);
  }

  /** Connects to the data folder's host, starting one if none is running. Null if impossible. */
  static async connect(dataDir: string): Promise<HostClient | null> {
    // A detached host outlives code reloads. Keep its active PTYs, but route new/restarted
    // sessions to the generation with rotating logs rather than killing every user's session.
    const legacy = await HostClient.tryConnect(dataDir);
    if (legacy?.generation === HOST_GENERATION) return legacy;
    const current = await HostClient.connectCurrent(dataDir);
    if (!current) return legacy;
    if (legacy) {
      current.legacy = legacy;
      await current.list();
      legacy.on('data', (key, offset, data) => {
        if (current.legacyKeys.has(key)) current.emit('data', key, offset, data);
      });
      legacy.on('exit', (key, code, signal) => {
        if (current.legacyKeys.has(key)) current.emit('exit', key, code, signal);
      });
      legacy.on('disconnect', () => {
        for (const key of current.legacyKeys) current.emit('exit', key, null, 'legacy host exited');
        current.legacyKeys.clear();
        current.legacy = null;
      });
    }
    return current;
  }

  private static async connectCurrent(dataDir: string): Promise<HostClient | null> {
    const existing = await HostClient.tryConnect(dataDir, HOST_GENERATION);
    if (existing) return existing;
    startHostProcess(dataDir);
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150));
      const client = await HostClient.tryConnect(dataDir, HOST_GENERATION);
      if (client) return client;
    }
    return null;
  }

  private static async tryConnect(
    dataDir: string,
    generation?: number,
  ): Promise<HostClient | null> {
    const rendezvous = readRendezvous(dataDir, generation);
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
      const hello = (await Promise.race([
        client.request({ op: 'hello', token: rendezvous.token }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('timeout')), CONNECT_TIMEOUT_MS),
        ),
      ])) as { generation?: number };
      client.generation = hello?.generation ?? 0;
      return client;
    } catch {
      socket.destroy();
      return null;
    }
  }

  async request(message: HostRequest): Promise<unknown> {
    if ('key' in message && this.legacyKeys.has(message.key) && this.legacy) {
      if (message.op === 'spawn') {
        const session = (await this.legacy.list()).find((s) => s.key === message.key);
        if (session?.alive) return session; // Never duplicate a still-running process.
        this.legacyKeys.delete(message.key);
      } else {
        return this.legacy.request(message);
      }
    }
    return this.requestLocal(message);
  }

  private requestLocal(message: HostRequest): Promise<unknown> {
    if (!this.connected) return Promise.reject(new Error('Session host disconnected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.write(JSON.stringify({ id, ...message }) + '\n');
    });
  }

  async list(): Promise<HostSessionInfo[]> {
    const current = (await this.requestLocal({ op: 'list' })) as HostSessionInfo[];
    if (!this.legacy?.connected) return current;
    const previous = await this.legacy.list();
    const keys = new Set(current.map((s) => s.key));
    const retained = previous.filter((s) => !keys.has(s.key));
    this.legacyKeys = new Set(retained.map((s) => s.key));
    return [...current, ...retained];
  }

  /** Detach without affecting any session. */
  close(): void {
    this.connected = false;
    this.socket.end();
    this.legacy?.close();
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

function readRendezvous(dataDir: string, generation?: number): HostRendezvous | null {
  try {
    return JSON.parse(readFileSync(rendezvousFile(dataDir, generation), 'utf8')) as HostRendezvous;
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
    '--generation',
    String(HOST_GENERATION),
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
