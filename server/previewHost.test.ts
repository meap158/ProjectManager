import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  handlePreviewUpgrade,
  previewHostPort,
  proxyPreviewHost,
  rewriteAppLocation,
  rewriteToApp,
  withFrameAncestors,
} from './previewHost.js';

// The built-in browser's own-origin mode (PM-253): a previewed dev server on p<port>.localhost,
// with every method and its live-reload WebSocket proxied, and nothing that is not loopback.

describe('previewHostPort', () => {
  it('reads the app port from a p<port>.localhost host', () => {
    expect(previewHostPort('p5188.localhost:5180')).toBe(5188);
    expect(previewHostPort('P3000.LOCALHOST')).toBe(3000);
  });
  it.each([
    undefined,
    '',
    'localhost:5180',
    '127.0.0.1:5180',
    'p5188.example.com',
    'evilp5188.localhost',
    'p5188.localhost.evil.com',
    'p80.localhost',
    'p5188.localhost:abc',
    'q5188.localhost',
  ])('ignores %j', (host) => {
    expect(previewHostPort(host)).toBeNull();
  });
});

describe('header helpers', () => {
  it("maps the preview's own origin back to the app's", () => {
    expect(rewriteToApp('http://p5188.localhost:5180/page', 'p5188.localhost:5180', 5188)).toBe(
      'http://localhost:5188/page',
    );
    expect(rewriteToApp('https://example.com/', 'p5188.localhost:5180', 5188)).toBe(
      'https://example.com/',
    );
  });
  it('keeps same-app redirects and refuses the rest', () => {
    expect(rewriteAppLocation('/login', 5188)).toBe('/login');
    expect(rewriteAppLocation('next', 5188)).toBe('next');
    expect(rewriteAppLocation('http://localhost:5188/a?b=1#c', 5188)).toBe('/a?b=1#c');
    expect(rewriteAppLocation('http://localhost:5189/', 5188)).toBeNull();
    expect(rewriteAppLocation('https://evil.example/', 5188)).toBeNull();
    expect(rewriteAppLocation('//evil.example/', 5188)).toBeNull();
  });
  it("keeps the app's CSP but only this app may frame it", () => {
    expect(withFrameAncestors(undefined, 'http://localhost:5180')).toBe(
      'frame-ancestors http://localhost:5180',
    );
    expect(
      withFrameAncestors("default-src 'self'; frame-ancestors 'none'", 'http://localhost:5180'),
    ).toBe("default-src 'self'; frame-ancestors http://localhost:5180");
  });
});

describe('the proxy, against a stand-in dev server', () => {
  let app: http.Server;
  let front: http.Server;
  let appPort: number;
  let frontPort: number;
  let seen: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string };
  let upgradeHeaders: http.IncomingHttpHeaders = {};
  const sockets = new Set<net.Socket>();
  const track = (server: http.Server) =>
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });

  beforeAll(async () => {
    app = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        seen = {
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString(),
        };
        if (req.url === '/out') {
          res.writeHead(302, { location: 'https://evil.example/' }).end();
        } else if (req.url === '/in') {
          res.writeHead(302, { location: `http://localhost:${appPort}/home` }).end();
        } else {
          res.writeHead(200, {
            'content-type': 'text/html',
            'x-frame-options': 'DENY',
            'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
            'set-cookie': 'sid=1; Path=/',
          });
          res.end('<script type="module" src="/src/main.tsx"></script>');
        }
      });
    });
    // A socket endpoint: accepts the upgrade, then echoes raw bytes (the proxy is frame-agnostic).
    app.on('upgrade', (req, socket) => {
      upgradeHeaders = req.headers;
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Protocol: ${req.headers['sec-websocket-protocol'] ?? 'none'}\r\n\r\n`,
      );
      socket.on('data', (data) => socket.write(data));
    });
    track(app);
    await new Promise<void>((resolve) => app.listen(0, '127.0.0.1', resolve));
    appPort = (app.address() as AddressInfo).port;

    front = http.createServer((req, res) => {
      const port = previewHostPort(req.headers.host);
      if (port === null) res.writeHead(404).end();
      else proxyPreviewHost(req, res, port, new Set());
    });
    front.on('upgrade', (req, socket, head) => {
      if (!handlePreviewUpgrade(req, socket, head, new Set())) socket.destroy();
    });
    track(front);
    await new Promise<void>((resolve) => front.listen(0, '127.0.0.1', resolve));
    frontPort = (front.address() as AddressInfo).port;
  });
  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise((resolve) => front.close(resolve)),
      new Promise((resolve) => app.close(resolve)),
    ]);
  });

  const host = () => `p${appPort}.localhost:${frontPort}`;
  const call = (path: string, init: { method?: string; body?: string; headers?: object } = {}) =>
    new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port: frontPort,
            path,
            method: init.method ?? 'GET',
            headers: { host: host(), ...init.headers },
          },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            );
          },
        );
        req.on('error', reject);
        req.end(init.body);
      },
    );

  it('serves the app untouched, so root-absolute URLs resolve on its own origin', async () => {
    const res = await call('/');
    expect(res.status).toBe(200);
    expect(res.body).toBe('<script type="module" src="/src/main.tsx"></script>');
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy']).toBe(
      `default-src 'self'; frame-ancestors http://localhost:${frontPort} http://127.0.0.1:${frontPort} http://[::1]:${frontPort}`,
    );
    expect(res.headers['set-cookie']).toEqual(['sid=1; Path=/']);
  });

  it('forwards every method with its body, and shows the app its own address', async () => {
    const res = await call('/api/login?next=1', {
      method: 'POST',
      body: '{"user":"a"}',
      headers: {
        'content-type': 'application/json',
        origin: `http://${host()}`,
        referer: `http://${host()}/login`,
        cookie: 'sid=1',
        'x-pm-lan': '1',
      },
    });
    expect(res.status).toBe(200);
    expect(seen.method).toBe('POST');
    expect(seen.url).toBe('/api/login?next=1');
    expect(seen.body).toBe('{"user":"a"}');
    expect(seen.headers.host).toBe(`localhost:${appPort}`);
    expect(seen.headers.origin).toBe(`http://localhost:${appPort}`);
    expect(seen.headers.referer).toBe(`http://localhost:${appPort}/login`);
    expect(seen.headers.cookie).toBe('sid=1');
    expect(seen.headers['x-pm-lan']).toBeUndefined();
  });

  it('rewrites a redirect back to the app and refuses one that leaves it', async () => {
    const inside = await call('/in');
    expect(inside.status).toBe(302);
    expect(inside.headers.location).toBe('/home');
    expect((await call('/out')).status).toBe(403);
  });

  it("refuses this app's own ports and reports a port with nothing on it", async () => {
    const blockedReq = await new Promise<number>((resolve) => {
      const s = http.createServer((req, res) =>
        proxyPreviewHost(req, res, appPort, new Set([appPort])),
      );
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as AddressInfo).port;
        http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          res.resume();
          s.closeAllConnections();
          s.close(() => resolve(res.statusCode ?? 0));
        });
      });
    });
    expect(blockedReq).toBe(403);
    const dead = await new Promise<number>((resolve) => {
      const s = http.createServer((req, res) => proxyPreviewHost(req, res, 1025, new Set()));
      s.listen(0, '127.0.0.1', () => {
        const port = (s.address() as AddressInfo).port;
        http.get({ host: '127.0.0.1', port, path: '/' }, (res) => {
          res.resume();
          s.closeAllConnections();
          s.close(() => resolve(res.statusCode ?? 0));
        });
      });
    });
    expect(dead).toBe(502);
  });

  /** Opens a raw socket to the front, sends an upgrade, and returns what came back. */
  const upgrade = (headers: Record<string, string>, after?: string) =>
    new Promise<{ head: string; echoed: string }>((resolve, reject) => {
      const socket = net.connect(frontPort, '127.0.0.1');
      let received = '';
      let sent = false;
      socket.on('error', reject);
      socket.on('data', (chunk) => {
        received += chunk.toString();
        const split = received.indexOf('\r\n\r\n');
        if (split < 0) return;
        if (after && !sent) {
          sent = true;
          socket.write(after);
          return;
        }
        if (!after || received.length > split + 4) {
          socket.destroy();
          resolve({ head: received.slice(0, split), echoed: received.slice(split + 4) });
        }
      });
      socket.on('close', () => {
        const split = received.indexOf('\r\n\r\n');
        resolve({ head: split < 0 ? received : received.slice(0, split), echoed: '' });
      });
      const lines = [
        'GET /?token=abc HTTP/1.1',
        ...Object.entries({
          Host: host(),
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Version': '13',
          'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
          ...headers,
        }).map(([k, v]) => `${k}: ${v}`),
        '',
        '',
      ];
      socket.write(lines.join('\r\n'));
    });

  it('proxies a live-reload WebSocket both ways, subprotocol included', async () => {
    const res = await upgrade(
      { Origin: `http://${host()}`, 'Sec-WebSocket-Protocol': 'vite-hmr' },
      'ping-through-the-proxy',
    );
    expect(res.head).toMatch(/^HTTP\/1\.1 101/);
    expect(res.head.toLowerCase()).toContain('sec-websocket-protocol: vite-hmr');
    expect(res.echoed).toBe('ping-through-the-proxy');
    expect(upgradeHeaders.host).toBe(`localhost:${appPort}`);
    expect(upgradeHeaders.origin).toBe(`http://localhost:${appPort}`);
  });

  it("refuses a socket opened by another website's page", async () => {
    const res = await upgrade({ Origin: 'https://evil.example' });
    expect(res.head).toMatch(/^HTTP\/1\.1 403/);
  });
});
