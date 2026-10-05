// Agent session host: a small background process that owns interactive session processes (PTYs)
// so they survive ProjectManager server restarts — code reloads in dev, crashes, out-of-memory
// kills — like tmux does for a shell. Only a reboot (or deliberately stopping a session) ends them.
//
//  - Started detached by the server when needed (one per data folder), outside the server's
//    process tree so killing the server tree never takes sessions down with it.
//  - Writes each session's output straight to its log file, so nothing is missed while no server
//    is attached; attached servers also get live `data` events with exact byte offsets.
//  - Exits on its own once no session is alive and no server has been attached for a minute.
//
// Usage: node ptyHost.js --data-dir <dir>   (the server launches it; see client.ts)

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  mkdirSync,
  openSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnPty, type AgentProc } from '../proc.js';
import {
  hostSocketPath,
  rendezvousFile,
  type HostMessage,
  type HostRendezvous,
  type HostRequest,
  type HostSessionInfo,
} from './protocol.js';

const IDLE_EXIT_MS = 60_000;

interface HostedSession {
  key: string;
  proc: AgentProc;
  logPath: string;
  fd: number | null;
  logBytes: number;
  maxLogBytes: number;
  alive: boolean;
  exitCode: number | null;
  signal: string | null;
}

const dataDir = path.resolve(process.argv[process.argv.indexOf('--data-dir') + 1] ?? 'data');
const socketPath = hostSocketPath(dataDir);
const token = randomBytes(24).toString('hex');
const sessions = new Map<string, HostedSession>();
const clients = new Set<net.Socket>();
let lastClientAt = Date.now();

function log(message: string): void {
  try {
    writeFileSync(
      path.join(dataDir, 'agent-host.log'),
      `${new Date().toISOString()} ${message}\n`,
      {
        flag: 'a',
      },
    );
  } catch {
    // Diagnostics only.
  }
}

function broadcast(message: HostMessage): void {
  const line = JSON.stringify(message) + '\n';
  for (const client of clients) client.write(line);
}

function appendOutput(session: HostedSession, text: string): void {
  const offset = session.logBytes;
  if (session.fd !== null) {
    let chunk = text;
    if (session.logBytes + Buffer.byteLength(chunk) > session.maxLogBytes) {
      chunk = `\r\n[log size limit reached: ${session.maxLogBytes} bytes; output is no longer recorded]\r\n`;
      try {
        writeSync(session.fd, chunk);
        closeSync(session.fd);
      } catch {
        // Ignore: logging must never take a session down.
      }
      session.fd = null;
      session.logBytes += Buffer.byteLength(chunk);
      broadcast({ ev: 'data', key: session.key, offset, data: chunk });
      return;
    }
    try {
      writeSync(session.fd, chunk);
    } catch {
      // Disk full / file removed: keep the session running regardless.
    }
    session.logBytes += Buffer.byteLength(chunk);
    broadcast({ ev: 'data', key: session.key, offset, data: chunk });
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => undefined);
  } else {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  }
}

function info(s: HostedSession): HostSessionInfo {
  return {
    key: s.key,
    pid: s.proc.pid ?? null,
    alive: s.alive,
    exitCode: s.exitCode,
    signal: s.signal,
    logBytes: s.logBytes,
  };
}

function handle(request: HostRequest): unknown {
  switch (request.op) {
    case 'spawn': {
      const existing = sessions.get(request.key);
      if (existing?.alive) return info(existing); // Idempotent: never start a session twice.
      mkdirSync(path.dirname(request.logPath), { recursive: true });
      const fd = openSync(request.logPath, 'a');
      // Continue offsets from what is already in the log (earlier runs, server banners).
      const logBytes = statSync(request.logPath, { throwIfNoEntry: false })?.size ?? 0;
      const proc = spawnPty(request.argv, {
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
      });
      const session: HostedSession = {
        key: request.key,
        proc,
        logPath: request.logPath,
        fd,
        logBytes,
        maxLogBytes: request.maxLogBytes,
        alive: true,
        exitCode: null,
        signal: null,
      };
      sessions.set(request.key, session);
      proc.onData((text) => appendOutput(session, text));
      proc.onExit((exitCode, signal) => {
        session.alive = false;
        session.exitCode = exitCode;
        session.signal = signal;
        if (session.fd !== null) {
          try {
            closeSync(session.fd);
          } catch {
            // Ignore.
          }
          session.fd = null;
        }
        broadcast({ ev: 'exit', key: session.key, exitCode, signal });
        log(`exit ${session.key} code=${exitCode}`);
      });
      log(`spawn ${request.key} pid=${proc.pid} ${request.argv[0]}`);
      return info(session);
    }
    case 'write': {
      const s = sessions.get(request.key);
      return s?.alive ? s.proc.write(request.data) : false;
    }
    case 'resize':
      sessions.get(request.key)?.proc.resize(request.cols, request.rows);
      return true;
    case 'kill': {
      const s = sessions.get(request.key);
      if (s?.alive && s.proc.pid) killTree(s.proc.pid);
      return true;
    }
    case 'forget': {
      const s = sessions.get(request.key);
      if (s && !s.alive) sessions.delete(request.key);
      return true;
    }
    case 'list':
      return [...sessions.values()].map(info);
    default:
      throw new Error('Unknown op');
  }
}

const server = net.createServer((socket) => {
  socket.setEncoding('utf8');
  let authed = false;
  let buffer = '';
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      let message: { id: number } & HostRequest;
      try {
        message = JSON.parse(line) as { id: number } & HostRequest;
      } catch {
        socket.destroy();
        return;
      }
      if (!authed) {
        if (message.op === 'hello' && message.token === token) {
          authed = true;
          clients.add(socket);
          socket.write(
            JSON.stringify({ id: message.id, ok: true, result: { pid: process.pid } }) + '\n',
          );
        } else {
          socket.destroy(); // Wrong or missing token: drop without answering.
        }
        continue;
      }
      try {
        const result = handle(message);
        socket.write(JSON.stringify({ id: message.id, ok: true, result }) + '\n');
      } catch (error) {
        socket.write(
          JSON.stringify({ id: message.id, ok: false, error: (error as Error).message }) + '\n',
        );
      }
    }
  });
  const drop = () => {
    clients.delete(socket);
    lastClientAt = Date.now();
  };
  socket.on('close', drop);
  socket.on('error', drop);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  // Another host already owns this data folder: leave it be.
  log(`listen failed: ${error.code ?? error.message}`);
  process.exit(error.code === 'EADDRINUSE' ? 0 : 1);
});

if (process.platform !== 'win32') rmSync(socketPath, { force: true });
server.listen(socketPath, () => {
  const rendezvous: HostRendezvous = {
    pid: process.pid,
    socket: socketPath,
    token,
    startedAt: new Date().toISOString(),
  };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(rendezvousFile(dataDir), JSON.stringify(rendezvous, null, 2), { mode: 0o600 });
  log(`listening pid=${process.pid}`);
});

// Idle exit: nothing alive and nobody attached for a while → no lingering background process.
setInterval(() => {
  const anyAlive = [...sessions.values()].some((s) => s.alive);
  if (anyAlive || clients.size > 0 || Date.now() - lastClientAt < IDLE_EXIT_MS) return;
  log('idle, exiting');
  shutdownHost(0);
}, 10_000).unref();

function shutdownHost(code: number): void {
  try {
    rmSync(rendezvousFile(dataDir), { force: true });
  } catch {
    // Ignore.
  }
  server.close();
  process.exit(code);
}

process.on('SIGTERM', () => shutdownHost(0));
process.on('uncaughtException', (error) => {
  // Stay up: one bad session must not take every other session with it.
  log(`uncaught: ${error.stack ?? error.message}`);
});
