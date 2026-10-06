import { request } from 'node:http';
import { getRequestListener } from '@hono/node-server';
import os from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { LAN_HEADER, LanAccess, lanAddresses } from './lan.js';

// The LAN listener only serves requests carrying the access key, only for this machine's own
// addresses, and hands authenticated ones to the normal handler as local requests.

const ip = lanAddresses()[0];
const seen: { host?: string; lan?: string; url?: string }[] = [];
const db = openDb(':memory:');
const lan = new LanAccess(
  db,
  (req, res) => {
    seen.push({ host: req.headers.host, lan: req.headers[LAN_HEADER] as string, url: req.url });
    res.writeHead(200).end('ok');
  },
  () => 'http://localhost:5180',
  47_310,
  '127.0.0.1', // Loopback only in tests: no firewall prompt; the gate still checks the Host.
);
afterAll(() => lan.stop());

const get = (port: number, path: string, headers: Record<string, string>) =>
  new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    },
  );

describe.skipIf(!ip)('LAN access', () => {
  it('is off by default and requires the key, then a cookie', async () => {
    expect(lan.status()).toMatchObject({ enabled: false, running: false, urls: [] });
    const on = await lan.setEnabled(true);
    expect(on.running).toBe(true);
    const port = on.port!;
    const key = new URL(on.urls[0]!).searchParams.get('key')!;
    const host = `${ip}:${port}`;

    expect((await get(port, '/', { host })).status).toBe(401); // No key.
    expect((await get(port, '/?key=wrong', { host })).status).toBe(401);
    expect((await get(port, `/?key=${key}`, { host: 'evil.example' })).status).toBe(403);
    // A client-sent LAN marker without a key gets nowhere either.
    expect((await get(port, '/api/lan', { host, [LAN_HEADER]: '0' })).status).toBe(401);

    const signIn = await get(port, `/board?key=${encodeURIComponent(key)}`, { host });
    // A same-origin page (not a redirect), so the Strict cookie is sent on the next navigation.
    expect(signIn.status).toBe(200);
    expect(signIn.body).toContain('location.replace("/board")'); // Key stripped from the URL.
    expect(signIn.body).not.toContain(key);
    const cookie = String(signIn.headers['set-cookie']).split(';')[0]!;
    expect(String(signIn.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);

    expect((await get(port, '/board', { host, cookie })).status).toBe(200);
    expect(seen.at(-1)).toEqual({ host: 'localhost:5180', lan: '1', url: '/board' });

    // A new key signs everyone out.
    lan.regenerateKey();
    expect((await get(port, '/board', { host, cookie })).status).toBe(401);
    expect((await lan.setEnabled(false)).running).toBe(false);
  });

  it('rate-limits wrong keys, checks Origin on writes, accepts the computer name', async () => {
    const guarded = new LanAccess(
      openDb(':memory:'),
      (_req, res) => res.writeHead(200).end('ok'),
      () => 'http://localhost:5180',
      47_330,
      '127.0.0.1',
    );
    try {
      const on = await guarded.setEnabled(true);
      const port = on.port!;
      const key = new URL(on.urls[0]!).searchParams.get('key')!;
      const host = `${ip}:${port}`;
      const signIn = await get(port, `/?key=${encodeURIComponent(key)}`, { host });
      const cookie = String(signIn.headers['set-cookie']).split(';')[0]!;
      expect(signIn.headers['referrer-policy']).toBe('no-referrer');

      // Writes from another origin are refused even with the cookie.
      const post = (origin: string) =>
        new Promise<number>((resolve, reject) => {
          const req = request(
            {
              host: '127.0.0.1',
              port,
              method: 'POST',
              path: '/api/x',
              headers: { host, cookie, origin },
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve(res.statusCode!));
            },
          );
          req.on('error', reject);
          req.end();
        });
      expect(await post('http://evil.example')).toBe(403);
      expect(await post(`http://${host}`)).toBe(200);

      // The computer's own name works as a host too.
      const name = `${os.hostname().toLowerCase()}.local:${port}`;
      expect((await get(port, '/', { host: name, cookie })).status).toBe(200);

      // Ten wrong keys, then the address is refused for a while (even with the right key).
      for (let i = 0; i < 10; i++) {
        expect((await get(port, '/?key=nope', { host })).status).toBe(401);
      }
      expect((await get(port, `/?key=${encodeURIComponent(key)}`, { host })).status).toBe(429);
    } finally {
      await guarded.stop();
    }
  });

  it('through the real app: the API works over the LAN, LAN settings stay local-only', async () => {
    const appDb = openDb(':memory:');
    let app: ReturnType<typeof createApp> | null = null;
    const viaLan = new LanAccess(
      appDb,
      (req, res) => getRequestListener(app!.fetch)(req, res),
      () => 'http://localhost:5180',
      47_350,
      '127.0.0.1',
    );
    app = createApp(appDb, { lan: viaLan });
    try {
      const on = await viaLan.setEnabled(true);
      const port = on.port!;
      const key = new URL(on.urls[0]!).searchParams.get('key')!;
      const host = `${ip}:${port}`;
      const signIn = await get(port, `/?key=${encodeURIComponent(key)}`, { host });
      const cookie = String(signIn.headers['set-cookie']).split(';')[0]!;
      expect((await get(port, '/api/projects', { host, cookie })).status).toBe(200);
      // The marker reaches the API (rawHeaders), so LAN devices can't read the key or re-key.
      expect((await get(port, '/api/lan', { host, cookie })).status).toBe(403);
    } finally {
      await viaLan.stop();
    }
  });

  it('refuses LAN settings requests that arrive through the LAN listener', async () => {
    const app = createApp(openDb(':memory:'), { lan });
    const res = await app.request('/api/lan', {
      headers: { host: 'localhost', [LAN_HEADER]: '1' },
    });
    expect(res.status).toBe(403);
    expect((await app.request('/api/lan', { headers: { host: 'localhost' } })).status).toBe(200);
  });
});
