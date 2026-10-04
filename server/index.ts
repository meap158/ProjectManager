import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createApp } from './app.js';
import { config } from './config.js';
import { openDb } from './db.js';

/** scripts/launch.mjs watches for this line to retry on the next port. Keep in sync with it. */
const PORT_IN_USE_MARKER = '[server] EADDRINUSE';

const here = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const db = openDb(config.dataDir);
  const root = new Hono();
  const api = createApp(db, { dataDir: config.dataDir });
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
        server.close();
        server.closeAllConnections();
        db.close();
        process.exit(0);
      }
    })();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
