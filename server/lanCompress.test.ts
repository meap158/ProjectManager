import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request, type RequestListener, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { getRequestListener } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { gzipResponse, withoutInlineMap } from './lanCompress.js';

// LAN gzip: whole compressible bodies are gzipped however the handler writes them; streams,
// 304s, small bodies and clients without gzip pass through untouched.

type Reply = { status: number; headers: Record<string, unknown>; body: Buffer; firstMs: number };
const servers: Server[] = [];
afterEach(() => servers.splice(0).forEach((s) => s.close()));

async function serve(handler: RequestListener) {
  const server = createServer((req, res) => {
    gzipResponse(req, res);
    handler(req, res);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return (
    headers: Record<string, string> = { 'accept-encoding': 'gzip, deflate' },
    path = '/x.js',
  ) =>
    new Promise<Reply>((resolve, reject) => {
      const start = Date.now();
      let firstMs = -1;
      const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => {
          if (firstMs < 0) firstMs = Date.now() - start;
          chunks.push(c);
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: Buffer.concat(chunks),
            firstMs,
          }),
        );
      });
      req.on('error', reject);
      req.end();
    });
}

const script = 'export const value = "' + 'abc'.repeat(2000) + '";\n';

describe('gzipResponse', () => {
  it('gzips a body sent with setHeader + end (how Vite sends modules)', async () => {
    const get = await serve((_req, res) => {
      res.setHeader('content-type', 'text/javascript');
      res.setHeader('content-length', Buffer.byteLength(script));
      res.setHeader('etag', 'W/"1"');
      res.setHeader('vary', 'Origin');
      res.end(script);
    });
    for (let i = 0; i < 2; i++) {
      // The second reply comes from the cache (same URL and ETag).
      const reply = await get();
      expect(reply.headers['content-encoding']).toBe('gzip');
      expect(reply.headers.vary).toBe('Origin, Accept-Encoding');
      expect(Number(reply.headers['content-length'])).toBe(reply.body.length);
      expect(reply.body.length).toBeLessThan(script.length / 10);
      expect(gunzipSync(reply.body).toString()).toBe(script);
    }
  });

  it('gzips a body written in pieces after writeHead with headers', async () => {
    const get = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/css; charset=utf-8' });
      res.write(script.slice(0, 100));
      res.end(Buffer.from(script.slice(100)));
    });
    const reply = await get();
    expect(reply.headers['content-encoding']).toBe('gzip');
    expect(reply.headers['content-type']).toBe('text/css; charset=utf-8');
    expect(gunzipSync(reply.body).toString()).toBe(script);
  });

  it('streams event streams at once, uncompressed', async () => {
    const get = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: first\n\n');
      setTimeout(() => res.end('data: last\n\n'), 300);
    });
    const reply = await get();
    expect(reply.headers['content-encoding']).toBeUndefined();
    expect(reply.firstMs).toBeLessThan(250);
    expect(reply.body.toString()).toBe('data: first\n\ndata: last\n\n');
  });

  it('leaves 304s, small bodies, images and clients without gzip alone', async () => {
    let mode = '304';
    const get = await serve((_req, res) => {
      if (mode === '304') {
        res.statusCode = 304;
        res.end();
      } else if (mode === 'small') {
        res.setHeader('content-type', 'text/javascript');
        res.end('export default 1');
      } else {
        res.setHeader('content-type', mode === 'image' ? 'image/png' : 'text/javascript');
        res.end(script);
      }
    });
    expect((await get()).status).toBe(304);
    mode = 'small';
    const small = await get();
    expect(small.headers['content-encoding']).toBeUndefined();
    expect(small.body.toString()).toBe('export default 1');
    mode = 'image';
    expect((await get()).headers['content-encoding']).toBeUndefined();
    mode = 'plain';
    const plain = await get({});
    expect(plain.headers['content-encoding']).toBeUndefined();
    expect(plain.body.toString()).toBe(script);
  });
});

describe('withoutInlineMap', () => {
  it('drops only a trailing inline source map comment', () => {
    const code = 'export const a = 1;\n';
    const map = '//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozfQ==\n';
    expect(withoutInlineMap(Buffer.from(code + map)).toString()).toBe(code);
    const external = code + '//# sourceMappingURL=a.js.map\n';
    expect(withoutInlineMap(Buffer.from(external)).toString()).toBe(external);
    const notLast = code + map + 'export const b = 2;\n';
    expect(withoutInlineMap(Buffer.from(notLast)).toString()).toBe(notLast);
  });
});

describe('gzipResponse with the production static server', () => {
  it('gzips files served by serveStatic, byte for byte', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-gzip-'));
    try {
      writeFileSync(path.join(dir, 'app.js'), script);
      const app = new Hono();
      app.use('/*', serveStatic({ root: path.relative(process.cwd(), dir) }));
      const get = await serve(getRequestListener(app.fetch));
      const reply = await get({ 'accept-encoding': 'gzip, deflate' }, '/app.js');
      expect(reply.status).toBe(200);
      expect(reply.headers['content-encoding']).toBe('gzip');
      expect(gunzipSync(reply.body).toString()).toBe(script);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
