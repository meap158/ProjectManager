import { spawn } from 'node:child_process';
import { createReadStream, rmSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';

// Production client bundle for LAN devices while the server runs in development (PM-203).
// Phones get no hot reload over the LAN, so Vite's dev modules only cost them: ~110 requests in
// an import waterfall (~1.4 s on a 20 Mbit/s, 30 ms link) against ~28 built files (~0.2 s).
//  - Never stale: a page is served from the bundle only when no client file changed since its
//    build started (Vite's watcher bumps a generation). Otherwise the dev modules are served as
//    before and one background build starts.
//  - Builds only when a LAN device asks for a page, in a child process at below-normal priority
//    (other sessions edit client files constantly; the CPU budget matters).
//  - Each build gets its own folder under <dataDir>/lan-client. Older folders stay for a few
//    minutes so a phone still loading an earlier page gets its hashed chunks, then go.

/** A failed build waits this long before the next try (dev modules are served meanwhile). */
const RETRY_MS = 60_000;
/** How long a replaced build keeps serving its files to pages that loaded it. */
const KEEP_OLD_MS = 10 * 60_000;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

export type Builder = (outDir: string) => Promise<void>;

interface Build {
  dir: string;
  generation: number;
  replacedAt?: number;
}

/** `vite build` in a child process at below-normal priority, production React. */
export function viteBuilder(repoRoot: string): Builder {
  return (outDir) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          path.join(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js'),
          'build',
          '--outDir',
          outDir,
          '--emptyOutDir',
          '--logLevel',
          'error',
        ],
        {
          cwd: repoRoot,
          env: { ...process.env, NODE_ENV: 'production' },
          stdio: ['ignore', 'ignore', 'pipe'],
          windowsHide: true,
        },
      );
      try {
        os.setPriority(child.pid!, os.constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        // Already exited or not permitted: the build still runs.
      }
      let errors = '';
      child.stderr!.on('data', (chunk: Buffer) => (errors = (errors + String(chunk)).slice(-2000)));
      child.once('error', reject);
      child.once('close', (code) =>
        code === 0 ? resolve() : reject(new Error(errors.trim() || `vite build exited ${code}`)),
      );
    });
}

export class LanBundle {
  private generation = 0;
  private seq = 0;
  private builds: Build[] = [];
  private building = false;
  private failedAt = 0;

  constructor(
    private root: string,
    private build: Builder,
  ) {
    rmSync(root, { recursive: true, force: true }); // Earlier runs' builds: stale by definition.
  }

  /** A client file changed: the current build no longer matches the source. */
  changed(): void {
    this.generation++;
  }

  /** The newest build, when it matches the current source; otherwise starts one and says null. */
  fresh(): string | null {
    const newest = this.builds[0];
    if (newest && newest.generation === this.generation) return newest.dir;
    this.start();
    return null;
  }

  private start(): void {
    if (this.building || Date.now() - this.failedAt < RETRY_MS) return;
    this.building = true;
    const generation = this.generation;
    const dir = path.join(this.root, String(++this.seq));
    this.build(dir).then(
      () => {
        this.building = false;
        const now = Date.now();
        for (const old of this.builds) old.replacedAt ??= now;
        this.builds.unshift({ dir, generation });
        this.prune();
        // Source changed during the build: it is stale already, the next page request rebuilds.
      },
      (error: Error) => {
        this.building = false;
        this.failedAt = Date.now();
        console.warn('[lan] client build failed; serving dev modules:', error.message);
        rmSync(dir, { recursive: true, force: true });
      },
    );
  }

  private prune(): void {
    const now = Date.now();
    this.builds = this.builds.filter((b, i) => {
      if (i === 0 || now - (b.replacedAt ?? now) < KEEP_OLD_MS) return true;
      rmSync(b.dir, { recursive: true, force: true });
      return false;
    });
  }

  /**
   * Serves a LAN GET from the bundle: a built file (from any kept build: pages that loaded an
   * earlier build still fetch its chunks), or index.html for a page navigation when the newest
   * build is fresh. False: not ours, the caller hands it to Vite.
   */
  async serve(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    this.prune();
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://lan').pathname);
    } catch {
      return false;
    }
    if (pathname !== '/') {
      // Hashed chunks from any kept build; unhashed public files (icons) only when fresh.
      const hashed = pathname.startsWith('/assets/');
      const newest = this.builds[0];
      const candidates = hashed
        ? this.builds
        : newest?.generation === this.generation
          ? [newest]
          : [];
      for (const build of candidates) {
        const file = path.join(build.dir, pathname);
        if (!file.startsWith(build.dir + path.sep)) return false; // No way out of the folder.
        const info = await stat(file).catch(() => null);
        if (info?.isFile()) {
          send(req, res, file, info, hashed);
          return true;
        }
      }
    }
    const navigation = (req.headers.accept ?? '').includes('text/html');
    if (!navigation) return false;
    const dir = this.fresh();
    if (!dir) return false;
    const file = path.join(dir, 'index.html');
    const info = await stat(file).catch(() => null);
    if (!info) return false;
    send(req, res, file, info, false);
    return true;
  }
}

function send(
  req: IncomingMessage,
  res: ServerResponse,
  file: string,
  info: { size: number; mtimeMs: number },
  immutable: boolean,
): void {
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  res.setHeader(
    'content-type',
    TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
  );
  res.setHeader('etag', etag);
  // Hashed chunks never change; the page itself is checked each time (it names the chunks).
  res.setHeader('cache-control', immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
  if (req.headers['if-none-match'] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  res.statusCode = 200;
  res.setHeader('content-length', info.size);
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(file)
    .on('error', () => res.destroy())
    .pipe(res);
}
