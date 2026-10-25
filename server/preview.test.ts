import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDb } from './db.js';
import {
  PreviewError,
  parsePreviewPort,
  proxyPreview,
  rewriteHtml,
  rewriteLocation,
} from './preview.js';

// The built-in browser's proxy (PM-253): loopback only, read only, no credentials either way.

describe('parsePreviewPort', () => {
  const blocked = new Set([5180, 5280]);
  it('accepts an ordinary dev port', () => {
    expect(parsePreviewPort('5173', blocked)).toBe(5173);
  });
  it.each(['', 'abc', '80', '1023', '65536', '-1', '5173.5', '0x1f90'])('refuses %j', (value) => {
    expect(() => parsePreviewPort(value, blocked)).toThrow(PreviewError);
  });
  it("refuses the app's own ports", () => {
    expect(() => parsePreviewPort('5180', blocked)).toThrow(/own/);
  });
});

describe('rewriteLocation', () => {
  it('keeps redirects under the proxy', () => {
    expect(rewriteLocation('/login', 3000)).toBe('/api/preview/3000/login');
    expect(rewriteLocation('next', 3000)).toBe('next');
    expect(rewriteLocation('http://localhost:3000/a?b=1', 3000)).toBe('/api/preview/3000/a?b=1');
  });
  it('refuses any other destination', () => {
    expect(rewriteLocation('https://evil.example/', 3000)).toBeNull();
    expect(rewriteLocation('//evil.example/', 3000)).toBeNull();
    expect(rewriteLocation('http://localhost:4000/', 3000)).toBeNull();
    expect(rewriteLocation('javascript:alert(1)', 3000)).toBeNull();
  });
});

describe('rewriteHtml', () => {
  it('sends root-absolute URLs through the proxy and leaves the rest alone', () => {
    const html =
      '<script src="/a.js"></script><a href=\'/b\'>x</a><img src="//cdn.example/c.png">' +
      '<link href="rel.css"><a href="https://example.com/">y</a>';
    expect(rewriteHtml(html, 3000)).toBe(
      '<script src="/api/preview/3000/a.js"></script><a href=\'/api/preview/3000/b\'>x</a>' +
        '<img src="//cdn.example/c.png"><link href="rel.css"><a href="https://example.com/">y</a>',
    );
  });
});

describe('proxyPreview', () => {
  let server: http.Server;
  let port: number;
  let seenCookie: string | undefined;
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seenCookie = req.headers.cookie;
      if (req.url === '/go') {
        res.writeHead(302, { location: 'https://evil.example/' }).end();
      } else if (req.url === '/in') {
        res.writeHead(302, { location: '/home' }).end();
      } else if (req.url?.startsWith('/page')) {
        res.writeHead(200, {
          'content-type': 'text/html',
          'set-cookie': 'sid=1',
          'x-frame-options': 'DENY',
        });
        res.end('<script src="/app.js"></script>hi');
      } else {
        res.writeHead(404).end('nope');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  const get = (path: string, init?: RequestInit) =>
    proxyPreview(new Request('http://localhost/x', init), port, path, '');

  it('serves a page, rewrites its URLs and strips cookies and framing headers', async () => {
    const res = await get('/page', { headers: { cookie: 'pm_device=secret' } });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`/api/preview/${port}/app.js`);
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-frame-options')).toBeNull();
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    expect(seenCookie).toBeUndefined();
  });

  it('rewrites a same-site redirect and refuses an outside one', async () => {
    const inside = await get('/in');
    expect(inside.status).toBe(302);
    expect(inside.headers.get('location')).toBe(`/api/preview/${port}/home`);
    await expect(get('/go')).rejects.toMatchObject({ status: 403 });
  });

  it('is read only', async () => {
    await expect(get('/page', { method: 'POST', body: '{}' })).rejects.toMatchObject({
      status: 403,
    });
  });

  it('reports a port with nothing on it', async () => {
    await expect(
      proxyPreview(new Request('http://localhost/x'), 1025, '/', ''),
    ).rejects.toMatchObject({ status: 502 });
  });
});

describe('GET /api/preview/:port', () => {
  let dev: http.Server;
  let devPort: number;
  beforeAll(async () => {
    dev = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' }).end('dev ok');
    });
    await new Promise<void>((resolve) => dev.listen(0, '127.0.0.1', resolve));
    devPort = (dev.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => dev.close(() => resolve())));

  const call = (path: string, init: RequestInit = {}) =>
    createApp(openDb(':memory:')).request(`http://localhost:5180/api/preview/${path}`, {
      ...init,
      headers: { host: 'localhost:5180', ...init.headers },
    });

  it('shows a dev server on the loopback', async () => {
    if (devPort < 1024) return;
    const res = await call(`${devPort}/anything`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('dev ok');
  });

  it("refuses the app's own port, low ports and the wrong host", async () => {
    expect((await call('5180/')).status).toBe(403);
    expect((await call('80/')).status).toBe(400);
    expect((await call(`${devPort}/`, { headers: { host: 'evil.example' } })).status).toBe(403);
  });

  it('is read only', async () => {
    const res = await call(`${devPort}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});

describe('quick launches and detected apps', () => {
  const app = createApp(openDb(':memory:'));
  const req = (path: string, init: RequestInit = {}) =>
    app.request(`http://localhost:5180/api/${path}`, {
      ...init,
      headers: { host: 'localhost:5180', 'content-type': 'application/json' },
    });

  it('saves and lists quick launches', async () => {
    expect(await (await req('preview-launches')).json()).toEqual({ launches: [] });
    const body = { launches: [{ name: 'Docs', port: 4321 }] };
    const put = await req('preview-launches', { method: 'PUT', body: JSON.stringify(body) });
    expect(put.status).toBe(200);
    expect(await (await req('preview-launches')).json()).toEqual({
      launches: [{ name: 'Docs', port: 4321, path: '/', projectId: null }],
    });
  });

  it('refuses a launch on a low port or without a name', async () => {
    const bad = (launch: object) =>
      req('preview-launches', { method: 'PUT', body: JSON.stringify({ launches: [launch] }) });
    expect((await bad({ name: 'x', port: 80 })).status).toBe(400);
    expect((await bad({ name: ' ', port: 3000 })).status).toBe(400);
  });

  it("lists detected apps without this app's own port", async () => {
    const res = await req('local-apps');
    expect(res.status).toBe(200);
    const { apps } = (await res.json()) as { apps: { port: number }[] };
    expect(Array.isArray(apps)).toBe(true);
    expect(apps.some((a) => a.port === 5180)).toBe(false);
  });
});
