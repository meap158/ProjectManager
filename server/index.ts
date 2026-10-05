import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { ALREADY_RUNNING_MARKER, claimInstance, isAlive, releaseInstance } from './instance.js';

/** scripts/launch.mjs watches for this line to retry on the next port. Keep in sync with it. */
const PORT_IN_USE_MARKER = '[server] EADDRINUSE';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The launcher passes its PID: it owns this instance across dev restarts (tsx watch). */
const launcherPid = Number(process.env.PM_LAUNCHER_PID) || null;

async function main() {
  // Must run before the database/supervisor start: a second server would relaunch the same
  // supervised agent sessions as the first.
  const other = await claimInstance(config.dataDir, {
    pid: process.pid,
    owner: launcherPid ?? process.pid,
    url: `http://localhost:${config.port}`,
    startedAt: new Date().toISOString(),
  });
  if (other) {
    console.error(`${ALREADY_RUNNING_MARKER} ${other.url}`);
    console.error(`ProjectManager is already running for this data folder at ${other.url}`);
    process.exit(0);
  }

  const db = openDb(config.dataDir);
  const root = new Hono();
  const api = createApp(db, {
    dataDir: config.dataDir,
    // Sessions live in the session host and survive server restarts (AGENT_HOST=off disables).
    agentHost: process.env.AGENT_HOST !== 'off',
  });
  root.route('/', api);

  const server = createServer();

  if (config.isProduction) {
    // dist/server/index.js -> dist/client
    const clientDir = path.relative(process.cwd(), path.join(here, '..', 'client'));
    root.use('/*', serveStatic({ root: clientDir }));
    root.get('*', serveStatic({ path: path.join(clientDir, 'index.html') }));
    server.on('request', getRequestListener(root.fetch));
  } else {
    // Development: Vite runs inside this process (middleware mode), sharing our port, including
    // its HMR websocket. Imported lazily so production never loads Vite.
    const { createServer: createVite } = await import('vite');
    const vite = await createVite({
      configFile: path.join(here, '..', 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
    });
    const api = getRequestListener(root.fetch);
    server.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.startsWith('/api/') || req.url === '/api') api(req, res);
      else vite.middlewares(req, res);
    });
    server.on('close', () => void vite.close());
  }

  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      releaseInstance(config.dataDir, process.pid);
      console.error(`${PORT_IN_USE_MARKER}: port ${config.port} is already in use.`);
      process.exit(1);
    }
    console.error('Server error:', error);
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    console.log(
      `[server] listening on http://${config.host}:${config.port} (${config.isProduction ? 'production' : 'development'})`,
    );
  });

  // Stop agent processes first: desiredState stays 'running', so the next boot
  // relaunches supervised sessions and runs (reboot-proof by design).
  const shutdown = () => {
    void (async () => {
      try {
        await api.supervisor.shutdown();
      } finally {
        releaseInstance(config.dataDir, process.pid);
        server.close();
        server.closeAllConnections();
        db.close();
        process.exit(0);
      }
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // Watchdog: if the launcher is killed hard (no chance to clean up), don't linger as an orphan.
  // In dev our parent is the tsx watcher, which would otherwise outlive the launcher too.
  if (launcherPid) {
    setInterval(() => {
      if (isAlive(launcherPid)) return;
      // Release first: killing the watcher can cut our stdout pipe mid-shutdown.
      releaseInstance(config.dataDir, process.pid);
      console.log('[server] launcher is gone, shutting down');
      if (process.ppid !== launcherPid && process.ppid > 1) {
        try {
          process.kill(process.ppid); // The tsx watcher.
        } catch {
          // Already gone.
        }
      }
      shutdown();
    }, 3000).unref();
  }
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
