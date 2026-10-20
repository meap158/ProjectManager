import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LanBundle } from './lanBundle.js';

// The LAN bundle: pages come from a build only when it matches the source; anything else falls
// through to the dev modules, and a stale or missing build starts exactly one background build.

type Reply = { status: number; headers: Record<string, unknown>; body: string };
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-lan-bundle-'));
  const builds: { dir: string; done: () => void; fail: (e: Error) => void }[] = [];
  const bundle = new LanBundle(root, (dir) => {
    mkdirSync(path.join(dir, 'assets'), { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), `<p>build ${builds.length + 1}</p>`);
    writeFileSync(path.join(dir, 'assets', `chunk-${builds.length + 1}.js`), 'export {}');
    writeFileSync(path.join(dir, 'icon.svg'), '<svg/>');
    return new Promise<void>((done, fail) => builds.push({ dir, done, fail }));
  });
  const server: Server = createServer((req, res) => {
    void bundle.serve(req, res).then((served) => served || res.writeHead(200).end('dev'));
  });
  cleanup.push(() => {
    server.close();
    rmSync(root, { recursive: true, force: true });
  });
  const ready = new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const get = async (
    pathname: string,
    accept = 'text/html',
    extra: Record<string, string> = {},
  ) => {
    await ready;
    const port = (server.address() as { port: number }).port;
    return new Promise<Reply>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port, path: pathname, headers: { accept, ...extra } },
        (res) => {
          let body = '';
          res.on('data', (c: Buffer) => (body += String(c)));
          res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  };
  const settle = () => new Promise((r) => setTimeout(r, 10));
  return { bundle, builds, get, settle };
}

describe('LanBundle', () => {
  it('serves dev modules until a build is ready, starting only one build', async () => {
    const { builds, get, settle } = setup();
    const replies = await Promise.all([get('/'), get('/board'), get('/')]);
    expect(replies.map((r) => r.body)).toEqual(['dev', 'dev', 'dev']);
    expect(builds).toHaveLength(1);
    builds[0]!.done();
    await settle();
    const page = await get('/projects/3');
    expect(page.body).toBe('<p>build 1</p>');
    expect(page.headers['cache-control']).toBe('no-cache');
    const chunk = await get('/assets/chunk-1.js', '*/*');
    expect(chunk.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(chunk.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect((await get('/src/main.tsx', '*/*')).body).toBe('dev');
    expect(builds).toHaveLength(1);
  });

  it('never serves a page from a build the source has moved past', async () => {
    const { bundle, builds, get, settle } = setup();
    await get('/');
    bundle.changed(); // A file changes while the first build runs.
    builds[0]!.done();
    await settle();
    expect((await get('/')).body).toBe('dev');
    expect((await get('/icon.svg', '*/*')).body).toBe('dev'); // Unhashed: only when fresh.
    // Pages that loaded the earlier build still get its hashed chunks.
    expect((await get('/assets/chunk-1.js', '*/*')).body).toBe('export {}');
    expect(builds).toHaveLength(2);
    builds[1]!.done();
    await settle();
    expect((await get('/')).body).toBe('<p>build 2</p>');
    expect((await get('/assets/chunk-1.js', '*/*')).status).toBe(200); // Kept for a while.
  });

  it('stays on dev modules after a failed build, and waits before trying again', async () => {
    const { builds, get, settle } = setup();
    await get('/');
    const warn = console.warn;
    console.warn = () => {};
    builds[0]!.fail(new Error('syntax error'));
    await settle();
    console.warn = warn;
    expect((await get('/')).body).toBe('dev');
    expect(builds).toHaveLength(1);
  });

  it('keeps requests inside the build folder and answers revalidations with 304', async () => {
    const { builds, get, settle } = setup();
    await get('/');
    builds[0]!.done();
    await settle();
    expect((await get('/../../etc/passwd', '*/*')).body).toBe('dev');
    expect((await get('/%2e%2e/%2e%2e/secret', '*/*')).body).toBe('dev');
    const first = await get('/assets/chunk-1.js', '*/*');
    const etag = String(first.headers.etag);
    const again = await get('/assets/chunk-1.js', '*/*', { 'if-none-match': etag });
    expect(again.status).toBe(304);
    expect(again.body).toBe('');
  });
});
