#!/usr/bin/env node
// One-command launcher: checks prerequisites, picks a free port (preferred port first, then the
// next ones), starts the server, waits until it is healthy, prints the URL and opens the browser.
// Ctrl+C stops the whole process tree.
//
//   node scripts/launch.mjs          development (Vite HMR + server auto-restart)
//   node scripts/launch.mjs --prod   production build (run `npm run build` first)
//   --no-open                        don't open a browser (also: BROWSER=none, CI=true)
//
// No dependencies on purpose: this must run before `npm install` has happened.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { childOutcome, recordServerOutput, restartBudget } from './serverRecovery.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = [22, 13];
const MAX_PORT_ATTEMPTS = 50;
const READY_TIMEOUT_MS = 60_000;
/** Line the server prints on EADDRINUSE (see server/index.ts). Works under tsx watch too,
 *  where a crashed server doesn't exit but waits for file changes. */
const PORT_IN_USE_MARKER = '[server] EADDRINUSE';
/** Line the server prints when another instance already serves this data folder (+ URL). */
const ALREADY_RUNNING_MARKER = '[server] ALREADY_RUNNING';

const args = new Set(process.argv.slice(2));
const prod = args.has('--prod');

/** Names this window after the project, "ProjectManager" (the owner's choice: the name alone; the
 * URL with its port is printed below). Terminals that ignore title requests just show the escape's
 * text away; nothing is written to a pipe or a file. */
const setTitle = (text) => {
  if (process.stdout.isTTY) process.stdout.write(`\x1b]0;${text}\x07`);
};

const log = (msg) => console.log(`\x1b[36m[launch]\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m[launch] ${msg}\x1b[0m`);
  process.exit(1);
};

// ---- Prerequisites ------------------------------------------------------------------------------

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  fail(`Node.js ${MIN_NODE.join('.')}+ is required (found ${process.versions.node}).`);
}

if (!existsSync(path.join(ROOT, 'node_modules'))) {
  log('Dependencies missing - running npm install...');
  const result = spawnSync('npm', ['install'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0)
    fail('npm install failed. Fix the error above and run the launcher again.');
}

if (spawnSync('git', ['--version'], { stdio: 'ignore' }).status !== 0) {
  log('\x1b[33mgit not found on PATH - commit stats and heatmaps will be unavailable.\x1b[0m');
}

if (prod && !existsSync(path.join(ROOT, 'dist', 'server', 'index.js'))) {
  fail('No production build found. Run `npm run build` first.');
}

// ---- Configuration ------------------------------------------------------------------------------

loadDotEnv(path.join(ROOT, '.env'));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const host = process.env.HOST || '127.0.0.1';
const preferredPort = Number(process.env.PORT || pkg.config?.port || 5180);
if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
  fail(`Invalid PORT "${process.env.PORT}".`);
}
const shouldOpen = !args.has('--no-open') && process.env.BROWSER !== 'none' && !process.env.CI;

/** Minimal .env reader: KEY=value lines; existing environment variables win. */
function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trimStart().startsWith('#')) continue;
    const [, key, raw] = match;
    if (process.env[key] === undefined) process.env[key] = raw.replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---- Single instance ------------------------------------------------------------------------
// One server per data folder (see server/instance.ts). If one is already running, just open it.

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');
process.on('uncaughtExceptionMonitor', (error, origin) => {
  recordServerOutput(
    dataDir,
    `\n${new Date().toISOString()} [launch] FATAL ${origin}: ${error.stack ?? error}\n`,
  );
});
process.on('exit', (code) => {
  recordServerOutput(dataDir, `\n${new Date().toISOString()} [launch] exit code=${code}\n`);
});

async function runningInstanceUrl() {
  try {
    const info = JSON.parse(readFileSync(path.join(dataDir, 'server.json'), 'utf8'));
    process.kill(info.pid, 0);
    const res = await fetch(`${info.url.replace('localhost', '127.0.0.1')}/api/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return res.ok ? info.url : null;
  } catch {
    return null;
  }
}

function handOver(url) {
  console.log(`\n  \x1b[1mProjectManager is already running:\x1b[0m  \x1b[1m${url}\x1b[0m\n`);
  if (shouldOpen) openBrowser(url);
  process.exit(0);
}

// ---- Port selection -----------------------------------------------------------------------------

/** True if something accepts connections on host:port. */
function accepting(port, at) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: at });
    socket.setTimeout(400);
    socket.once('connect', () => (socket.destroy(), resolve(true)));
    socket.once('timeout', () => (socket.destroy(), resolve(false)));
    socket.once('error', () => resolve(false));
  });
}

/** Binds host:port briefly: 'ok', 'busy', or 'unavailable' (no such address, e.g. no IPv6). */
function bindable(port, at) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', (e) =>
      resolve(['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes(e.code) ? 'unavailable' : 'busy'),
    );
    server.listen({ port, host: at, exclusive: true }, () => server.close(() => resolve('ok')));
  });
}

/**
 * A port is free if nothing accepts connections on it and we can bind it ourselves. On loopback,
 * both 127.0.0.1 and ::1 count: browsers and Node try "localhost" as ::1 first, and Windows lets
 * another app hold the same port on 0.0.0.0/:: alongside our 127.0.0.1 (that app would then
 * answer localhost). The server listens on both loopbacks (server/index.ts).
 */
async function isPortFree(port) {
  const hosts = host === '127.0.0.1' ? ['127.0.0.1', '::1'] : [host];
  for (const at of hosts) if (await accepting(port, at)) return false;
  for (const at of hosts) {
    const result = await bindable(port, at);
    if (result === 'busy' || (result === 'unavailable' && at === host)) return false;
  }
  return true;
}

async function findFreePort(start, exclude) {
  for (let port = start; port < start + MAX_PORT_ATTEMPTS && port <= 65535; port++) {
    if (exclude.has(port)) continue;
    if (await isPortFree(port)) return port;
    log(`Port ${port} is busy, trying ${port + 1}...`);
  }
  return null;
}

// ---- Child process management -------------------------------------------------------------------

let child = null;
let shuttingDown = false;

function killTree(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  if (process.platform === 'win32') {
    // Kills the watcher and the server it spawned; plain kill() would orphan the grandchild.
    spawnSync('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-proc.pid, 'SIGTERM'); // Whole process group (spawned with detached: true).
    } catch {
      proc.kill('SIGTERM');
    }
  }
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  killTree(child);
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
process.on('SIGHUP', () => shutdown(0));
process.on('exit', () => killTree(child));

function startServer(port) {
  const env = { ...process.env, PORT: String(port), HOST: host };
  let argv;
  if (prod) {
    env.NODE_ENV = 'production';
    argv = ['--disable-warning=ExperimentalWarning', 'dist/server/index.js'];
  } else {
    env.NODE_ENV = 'development';
    // tsx watch restarts the server when server/ or shared/ files change; Vite handles client HMR.
    const tsxCli = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --disable-warning=ExperimentalWarning`.trim();
    argv = [tsxCli, 'watch', '--clear-screen=false', 'server/index.ts'];
  }
  env.FORCE_COLOR ??= '1';
  env.PM_LAUNCHER_PID = String(process.pid);
  const proc = spawn(process.execPath, argv, {
    cwd: ROOT,
    env,
    stdio: ['inherit', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  // Forward output and flag a port collision so the caller can retry on another port.
  proc.portInUse = false;
  for (const [stream, target] of [
    [proc.stdout, process.stdout],
    [proc.stderr, process.stderr],
  ]) {
    stream.on('data', (chunk) => {
      const text = chunk.toString();
      recordServerOutput(dataDir, text);
      if (text.includes(PORT_IN_USE_MARKER)) proc.portInUse = true;
      const at = text.indexOf(ALREADY_RUNNING_MARKER);
      if (at !== -1) {
        proc.alreadyRunning = text
          .slice(at + ALREADY_RUNNING_MARKER.length)
          .trim()
          .split(/\s/)[0];
      }
      target.write(chunk);
    });
  }
  return proc;
}

async function waitUntilReady(port, proc) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null || proc.recoveryFailed || proc.portInUse || proc.alreadyRunning)
      return false;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (res.ok) return true;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

function openBrowser(url) {
  const [cmd, cmdArgs] =
    process.platform === 'win32'
      ? ['explorer.exe', [url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]];
  const proc = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
  proc.on('error', () => log(`Could not open a browser automatically. Open ${url} manually.`));
  proc.unref();
}

// ---- Main ---------------------------------------------------------------------------------------

const existingUrl = await runningInstanceUrl();
if (existingUrl) handOver(existingUrl);

const triedPorts = new Set();
const mayRestart = restartBudget();
for (let attempt = 0; attempt < 5; attempt++) {
  const port = await findFreePort(preferredPort, triedPorts);
  if (port === null) {
    fail(
      `No free port found in ${preferredPort}-${preferredPort + MAX_PORT_ATTEMPTS - 1}. ` +
        'Set PORT in .env to a different range.',
    );
  }
  triedPorts.add(port);

  log(`Starting ${prod ? 'production' : 'development'} server on port ${port}...`);
  child = startServer(port);
  let exited = childOutcome(child);
  const ready = await waitUntilReady(port, child);

  if (ready) {
    setTitle('ProjectManager');
    const url = `http://localhost:${port}`;
    const note = port === preferredPort ? '' : ` (preferred port ${preferredPort} was busy)`;
    console.log(
      `\n  \x1b[1m\x1b[32mProjectManager is running:\x1b[0m  \x1b[1m${url}\x1b[0m${note}\n`,
    );
    console.log('  Press Ctrl+C to stop.\n');
    if (shouldOpen) openBrowser(url);
    while (!shuttingDown) {
      const outcome = await exited;
      if (shuttingDown) break;
      killTree(child);
      const detail = `code=${outcome.code} signal=${outcome.signal ?? 'none'}${outcome.error ? ` error=${outcome.error}` : ''}`;
      recordServerOutput(
        dataDir,
        `\n${new Date().toISOString()} [launch] server stopped (${detail})\n`,
      );
      if (!mayRestart())
        fail(`Server repeatedly crashed; see ${path.join(dataDir, 'server-output.log')}.`);
      log(
        `Server stopped (${detail}); restarting in 1s. Diagnostics: ${path.join(dataDir, 'server-output.log')}`,
      );
      await new Promise((resolve) => setTimeout(resolve, 1000));
      if (shuttingDown) break;
      child = startServer(port);
      exited = childOutcome(child);
      // A failed restart also goes through the bounded recovery loop.
      if (await waitUntilReady(port, child)) log(`Server recovered at ${url}`);
      else if (child.exitCode === null) killTree(child);
    }
    break;
  }

  if (child.alreadyRunning) {
    killTree(child);
    handOver(child.alreadyRunning);
  }
  if (child.portInUse) {
    killTree(child);
    log(`Port ${port} was taken just before startup, trying another...`);
    continue;
  }
  const code = child.exitCode;
  killTree(child);
  fail(
    code === null
      ? `Server did not become ready within ${READY_TIMEOUT_MS / 1000}s.`
      : `Server failed to start (exit code ${code}). See the error above.`,
  );
}
