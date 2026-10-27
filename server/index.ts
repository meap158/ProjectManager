import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { recentRequests, traceRequests } from './activityTrail.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { ALREADY_RUNNING_MARKER, claimInstance, isAlive, releaseInstance } from './instance.js';
import { LAN_HEADER, LanAccess } from './lan.js';
import { LanBundle, viteBuilder } from './lanBundle.js';
import { handlePreviewUpgrade, previewHostPort, proxyPreviewHost } from './previewHost.js';
import { RemoteAccess, viaCloudflare } from './remote.js';
import { appendFileSync, mkdirSync } from 'node:fs';

/** scripts/launch.mjs watches for this line to retry on the next port. Keep in sync with it. */
const PORT_IN_USE_MARKER = '[server] EADDRINUSE';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The launcher passes its PID: it owns this instance across dev restarts (tsx watch). */
const launcherPid = Number(process.env.PM_LAUNCHER_PID) || null;

// Observe fatal errors without suppressing Node's normal nonzero exit. The launcher also
// watches this marker because tsx watch may stay alive after its server child crashes.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  const detail = `${new Date().toISOString()} [server] FATAL ${origin}: ${error.stack ?? error}\n`;
  try {
    mkdirSync(config.dataDir, { recursive: true });
    appendFileSync(path.join(config.dataDir, 'server-crashes.log'), detail);
  } catch {
    /* stderr remains available if the data disk cannot be written. */
  }
  process.stderr.write(detail);
});

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
  // Opt-in LAN listener (Settings → LAN access): its own port, access key required; it hands
  // authenticated requests to the same handler as the local server (set below).
  let handle: (req: IncomingMessage, res: ServerResponse) => void = (_req, res) =>
    res.writeHead(503).end();
  const lan = new LanAccess(
    db,
    (req, res) => handle(req, res),
    () => `http://localhost:${config.port}`,
    config.port + 100, // Fallback when the app's own port can't be had on the LAN addresses.
    '0.0.0.0',
    config.port,
  );
  // Opt-in Cloudflare Tunnel listener (Settings → Remote access): loopback only, cloudflared
  // forwards to it; Access login, an email allowlist and an authenticator code are all required.
  const remote = new RemoteAccess(
    db,
    (req, res) => handle(req, res),
    () => `http://localhost:${config.port}`,
    config.port + 200,
  );
  const api = createApp(db, {
    lan,
    remote,
    dataDir: config.dataDir,
    // Sessions live in the session host and survive server restarts (AGENT_HOST=off disables).
    agentHost: process.env.AGENT_HOST !== 'off',
    // Agent processes share Settings → CPU budget (affinity + below-normal priority).
    cpuBudget: true,
  });
  root.route('/', api);
  // A p<port>.localhost host is a previewed dev server on its own origin (any method, live-reload
  // sockets): this computer's loopback listener only. The LAN and remote listeners call `handle`
  // directly, so they never route these hosts and keep the read-only path mode.
  const blockedPorts = () => {
    const own = new Set<number>([config.port, config.port + 100]);
    for (const port of [lan.status().port, remote.status().port]) if (port) own.add(port);
    return own;
  };
  const route = (req: IncomingMessage, res: ServerResponse) => {
    // The tunnel may point at this port: the public hostname goes through the remote gate (Access
    // token, email allowlist, authenticator code) and only then reaches the app. Anything else that
    // carries Cloudflare's headers had its Host rewritten and is refused rather than trusted as local.
    if (remote.owns(req.headers.host)) return remote.serve(req, res);
    if (viaCloudflare(req.headers)) {
      res.writeHead(403, { 'content-type': 'text/plain' }).end('Forbidden host');
      return;
    }
    const port = previewHostPort(req.headers.host);
    if (port === null) handle(req, res);
    else proxyPreviewHost(req, res, port, blockedPorts());
  };
  // Boards follow commits on their own: new commits' card refs apply within ~15s, no Refresh.
  api.scanner.watchCommits();
  // Pull requests on GitHub move cards too (open → Review, merged → Done).
  api.scanner.watchPullRequests();
  // Stats stay fresh on their own: the stalest project is rescanned once it is 15+ minutes old.
  api.scanner.refreshPeriodically();
  // Session names follow /rename in the CLIs, and renames here reach the CLIs.
  api.supervisor.syncTitlesPeriodically();
  api.orchestrator.start();

  const server = createServer();
  server.prependListener('upgrade', (req, socket, head) => {
    // WebSockets never come through the tunnel on this port (no live reload for remote visitors).
    if (viaCloudflare(req.headers) || remote.owns(req.headers.host)) return void socket.destroy();
    handlePreviewUpgrade(req, socket, head, blockedPorts());
  });

  if (config.isProduction) {
    // dist/server/index.js -> dist/client
    const clientDir = path.relative(process.cwd(), path.join(here, '..', 'client'));
    // Built assets carry a content hash in their name: browsers (phones on the LAN especially)
    // keep them instead of downloading the bundle again on every visit.
    root.use('/assets/*', async (c, next) => {
      await next();
      if (c.res.status === 200) c.header('cache-control', 'public, max-age=31536000, immutable');
    });
    root.use('/*', serveStatic({ root: clientDir }));
    root.get('*', serveStatic({ path: path.join(clientDir, 'index.html') }));
    handle = getRequestListener(root.fetch);
    server.on('request', route);
  } else {
    // Development: Vite runs inside this process (middleware mode), sharing our port, including
    // its HMR websocket. Imported lazily so production never loads Vite.
    const { createServer: createVite } = await import('vite');
    // LAN devices get a production build of the client once one matches the source (PM-203).
    const lanBundle = new LanBundle(
      path.join(config.dataDir, 'lan-client'),
      viteBuilder(path.join(here, '..')),
    );
    const vite = await createVite({
      configFile: path.join(here, '..', 'vite.config.ts'),
      server: { middlewareMode: true, hmr: { server } },
      appType: 'spa',
      plugins: [
        {
          // A plugin, not vite.watcher: Vite swaps in a new watcher when it restarts itself
          // (config or .env change), and this hook runs again for it.
          name: 'pm-lan-bundle-freshness',
          configureServer(dev) {
            lanBundle.changed();
            dev.watcher.on('all', () => lanBundle.changed());
          },
        },
      ],
    });
    const api = getRequestListener(root.fetch);
    handle = (req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.startsWith('/api/') || req.url === '/api') api(req, res);
      // Remote requests carry the LAN marker too, so they get the production bundle as well.
      else if (req.headers[LAN_HEADER] !== '1') vite.middlewares(req, res);
      else
        void lanBundle.serve(req, res).then(
          (served) => served || vite.middlewares(req, res),
          () => vite.middlewares(req, res),
        );
    };
    server.on('request', route);
    server.on('close', () => void vite.close());
  }

  handle = traceRequests(handle);

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
    void lan.restore();
    void remote.restore();
  });

  // "localhost" resolves to ::1 first in browsers and Node, and Windows lets another app hold
  // this port on 0.0.0.0/:: next to our 127.0.0.1 (it would then answer localhost). Listening on
  // the IPv6 loopback too keeps localhost ours: the more specific address wins.
  const server6 = config.host === '127.0.0.1' ? createServer() : null;
  if (server6) {
    server6.on('request', route);
    server6.on('upgrade', (...args) => server.emit('upgrade', ...args)); // Vite HMR.
    server6.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT') return; // No IPv6.
      console.warn(
        `[server] could not also listen on [::1]:${config.port} (${error.code}); if localhost opens another app, use http://127.0.0.1:${config.port}`,
      );
    });
    server6.listen(config.port, '::1');
  }

  // Stop agent processes first: desiredState stays 'running', so the next boot
  // relaunches supervised sessions and runs (reboot-proof by design).
  const shutdown = () => {
    void (async () => {
      try {
        await api.orchestrator.stop();
        await api.supervisor.shutdown();
      } finally {
        releaseInstance(config.dataDir, process.pid);
        await lan.stop();
        await remote.stop();
        server.close();
        server.closeAllConnections();
        server6?.close();
        server6?.closeAllConnections();
        db.close();
        process.exit(0);
      }
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // A stalled event loop freezes every request and terminal at once. Say so in the log, with
  // when and for how long, so a "the app hangs" report can be matched against what ran then.
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  setInterval(() => {
    const worstMs = Math.round(loopDelay.max / 1e6);
    loopDelay.reset();
    if (worstMs >= 1000) {
      const memory = process.memoryUsage();
      const scanning = api.scanner.scanningProjectIds();
      const around = recentRequests(worstMs + 5000);
      console.warn(
        `${new Date().toISOString()} [perf] event loop was blocked for ${worstMs} ms; rss=${Math.round(memory.rss / 1048576)}MB heap=${Math.round(memory.heapUsed / 1048576)}MB` +
          (scanning.length ? `; scanning projects ${scanning.join(',')}` : '') +
          (around.length ? `; requests around it: ${around.join(' | ')}` : ''),
      );
    }
  }, 5000).unref();

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
