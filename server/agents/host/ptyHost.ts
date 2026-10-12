// Agent session host: a small background process that owns interactive session processes (PTYs)
// so they survive quick ProjectManager server restarts (code reloads in dev), like tmux does for a
// shell. Closing ProjectManager ends them: see ORPHAN_MS.
//
//  - Started detached by the server when needed (one per data folder/generation), outside the server's
//    process tree so killing the server tree never takes sessions down with it.
//  - Writes each session's output straight to its log file, so nothing is missed while no server
//    is attached; attached servers also get live `data` events with exact byte offsets.
//  - Once no server has been attached for ORPHAN_MS (ProjectManager closed, killed or crashed),
//    ends every session's process tree, then exits. Wanted sessions relaunch on the next start.
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
import { compactLog, LOG_KEEP_BYTES, logBase } from '../logFile.js';
import { spawnPty, type AgentProc } from '../proc.js';
import { OutputDelivery } from './outputDelivery.js';
import {
  HOST_GENERATION,
  hostSocketPath,
  rendezvousFile,
  type HostMessage,
  type HostRendezvous,
  type HostRequest,
  type HostSessionInfo,
} from './protocol.js';

/**
 * No server attached for this long means ProjectManager is gone, however it ended: every session
 * is ended rather than left running unseen (each is an agent CLI using CPU and memory). Long
 * enough to ride out a dev restart (tsx watch), which reconnects within a few seconds.
 */
const ORPHAN_MS = Number(process.env.PM_HOST_ORPHAN_MS) || 20_000; // Env override for tests.
const CHECK_MS = Math.min(5_000, ORPHAN_MS / 2);

interface HostedSession {
  key: string;
  proc: AgentProc | null;
  pid: number | null;
  logPath: string;
  fd: number | null;
  /** Logical offset of the next byte (never shrinks; see logFile.ts). */
  logBytes: number;
  /** Physical size of the log file, bounded by maxLogBytes through compaction. */
  fileBytes: number;
  maxLogBytes: number;
  alive: boolean;
  exitCode: number | null;
  signal: string | null;
}

const dataDir = path.resolve(process.argv[process.argv.indexOf('--data-dir') + 1] ?? 'data');
const generation = process.argv.includes('--generation') ? HOST_GENERATION : undefined;
const socketPath = hostSocketPath(dataDir, generation);
const token = randomBytes(24).toString('hex');
const sessions = new Map<string, HostedSession>();
const clients = new Map<net.Socket, OutputDelivery>();
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

function broadcast(message: HostMessage, persisted = false): void {
  for (const delivery of clients.values()) delivery.send(message, persisted);
}

/** A full log is compacted to its recent tail (offsets keep growing); output never stops. */
function compactIfFull(session: HostedSession, incoming: number): void {
  if (session.fd === null || session.fileBytes + incoming <= session.maxLogBytes) return;
  try {
    closeSync(session.fd);
    session.fd = null;
    const keep = Math.min(LOG_KEEP_BYTES, Math.floor(session.maxLogBytes / 4));
    session.fileBytes = compactLog(session.logPath, keep);
    session.fd = openSync(session.logPath, 'a');
  } catch (error) {
    // Stop recording (fd stays null) but keep streaming live output to attached viewers.
    log(`compact ${session.key} failed: ${(error as Error).message}`);
  }
}

function appendOutput(session: HostedSession, text: string): void {
  const offset = session.logBytes;
  const bytes = Buffer.byteLength(text);
  compactIfFull(session, bytes);
  let persisted = false;
  if (session.fd !== null) {
    try {
      const written = writeSync(session.fd, text);
      session.fileBytes += written;
      persisted = written === bytes;
    } catch {
      // Disk full / file removed: keep the session running regardless.
    }
  }
  session.logBytes += bytes;
  broadcast({ ev: 'data', key: session.key, offset, data: text }, persisted);
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
    pid: s.pid,
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
      const fileBytes = statSync(request.logPath, { throwIfNoEntry: false })?.size ?? 0;
      const logBytes = logBase(request.logPath) + fileBytes;
      const proc = spawnPty(request.argv, {
        cwd: request.cwd,
        env: request.env,
        cols: request.cols,
        rows: request.rows,
      });
      const session: HostedSession = {
        key: request.key,
        proc,
        pid: proc.pid ?? null,
        logPath: request.logPath,
        fd,
        logBytes,
        fileBytes,
        maxLogBytes: request.maxLogBytes,
        alive: true,
        exitCode: null,
        signal: null,
      };
      sessions.set(request.key, session);
      appendOutput(session, `\x1b]777;pm-size;${request.cols};${request.rows}\x07`);
      proc.onData((text) => appendOutput(session, text));
      proc.onExit((exitCode, signal) => {
        session.alive = false;
        session.exitCode = exitCode;
        session.signal = signal;
        // Retain reconnect metadata, not the exited native PTY and its callbacks.
        session.proc = null;
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
      return s?.alive ? (s.proc?.write(request.data) ?? false) : false;
    }
    case 'resize': {
      const session = sessions.get(request.key);
      if (session?.alive) {
        // The host remains the sole log writer, keeping SSE byte offsets exact.
        appendOutput(session, `\x1b]777;pm-size;${request.cols};${request.rows}\x07`);
        session.proc?.resize(request.cols, request.rows);
      }
      return true;
    }
    case 'kill': {
      const s = sessions.get(request.key);
      if (s?.alive && s.pid) killTree(s.pid);
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
          const delivery = new OutputDelivery(socket);
          clients.set(socket, delivery);
          socket.on('drain', () => delivery.flush());
          socket.write(
            JSON.stringify({
              id: message.id,
              ok: true,
              result: { pid: process.pid, generation: HOST_GENERATION },
            }) + '\n',
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
  writeFileSync(rendezvousFile(dataDir, generation), JSON.stringify(rendezvous, null, 2), {
    mode: 0o600,
  });
  log(`listening pid=${process.pid}`);
});

// Orphaned: end every session (retried each check until they are gone), then exit.
let orphanLogged = false;
setInterval(() => {
  if (clients.size > 0 || Date.now() - lastClientAt < ORPHAN_MS) {
    orphanLogged = false;
    return;
  }
  const alive = [...sessions.values()].filter((s) => s.alive);
  if (alive.length === 0) {
    log('no server attached and no sessions, exiting');
    shutdownHost(0);
    return;
  }
  if (!orphanLogged)
    log(`no server attached for ${ORPHAN_MS / 1000}s, ending ${alive.length} sessions`);
  orphanLogged = true;
  for (const s of alive) if (s.pid) killTree(s.pid);
}, CHECK_MS).unref();

function shutdownHost(code: number): void {
  try {
    rmSync(rendezvousFile(dataDir, generation), { force: true });
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
