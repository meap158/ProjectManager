import { createServer, request } from 'node:http';
import os from 'node:os';
import { getRequestListener } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { LAN_HEADER, LanAccess, REMOTE_HEADER, lanAddresses, normaliseCode } from './lan.js';

// LAN access: devices sign in with the short code shown in Settings (device-flow style), then
// carry their own device cookie. Loopback binding in tests: no OS firewall prompt; the gate still
// checks the Host header, so requests present this machine's LAN address.

const ip = lanAddresses()[0];
type Reply = { status: number; headers: Record<string, unknown>; body: string };

const send = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
) =>
  new Promise<Reply>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });

const open: LanAccess[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((l) => l.stop()));
});

async function setup(port: number) {
  const db = openDb(':memory:');
  const seen: { host?: string; lan?: string; remote?: string; url?: string }[] = [];
  let app: ReturnType<typeof createApp> | null = null;
  const lan = new LanAccess(
    db,
    (req, res) => {
      if (app) return getRequestListener(app.fetch)(req, res);
      seen.push({
        host: req.headers.host,
        lan: req.headers[LAN_HEADER] as string,
        remote: req.headers[REMOTE_HEADER] as string | undefined,
        url: req.url,
      });
      res.writeHead(200).end('ok');
    },
    () => 'http://localhost:5180',
    port,
    '127.0.0.1',
  );
  open.push(lan);
  const status = await lan.setEnabled(true);
  const host = `${ip}:${status.port}`;
  const signIn = (code: string, next = '/') =>
    send(
      status.port!,
      'POST',
      '/__pm/sign-in',
      { host, 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ code, next }).toString(),
    );
  return {
    lan,
    seen,
    host,
    port: status.port!,
    signIn,
    useApp: () => (app = createApp(db, { lan })),
  };
}

const cookieOf = (reply: Reply) => String(reply.headers['set-cookie']).split(';')[0]!;

describe.skipIf(!ip)('LAN access', () => {
  it('signs a device in with the code, once, and hands it a device cookie', async () => {
    const { lan, seen, host, port, signIn } = await setup(47_410);
    const status = lan.status();
    expect(status.code).toMatch(/^[A-HJKMNP-Z2-9]{4}$/);
    expect(status.urls[0]).toBe(`http://${ip}:${port}/`); // No secrets in the address.

    // Not signed in: pages show the sign-in form, API calls get a plain 401.
    const page = await send(port, 'GET', '/board', { host });
    expect(page.status).toBe(401);
    expect(page.body).toContain('name="code"');
    expect((await send(port, 'GET', '/api/projects', { host })).status).toBe(401);

    // Lowercase and a dash are fine; the code works once and lands where the user was going.
    const typed = `${status.code!.slice(0, 2).toLowerCase()}-${status.code!.slice(2)}`;
    const ok = await signIn(typed, '/board');
    expect(ok.status).toBe(303);
    expect(ok.headers.location).toBe('/board');
    expect(String(ok.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Lax/);
    const cookie = cookieOf(ok);
    expect((await signIn(status.code!)).status).toBe(401); // Single use.
    expect(lan.status().code).not.toBe(status.code); // A fresh code replaced it.

    expect((await send(port, 'GET', '/board', { host, cookie })).status).toBe(200);
    expect(seen.at(-1)).toEqual({ host: 'localhost:5180', lan: '1', url: '/board' });
    // A device can't pass as a remote session (which may run launchers) by sending its marker.
    await send(port, 'GET', '/board', { host, cookie, [REMOTE_HEADER]: '1' });
    expect(seen.at(-1)!.remote).toBeUndefined();
    expect(lan.status().devices).toHaveLength(1);

    // Signing the device out from Settings ends its session.
    lan.signOut(lan.status().devices[0]!.id);
    expect((await send(port, 'GET', '/board', { host, cookie })).status).toBe(401);
  });

  it('retires a code after 5 wrong tries and rate-limits a client after 10', async () => {
    const { lan, signIn } = await setup(47_430);
    const first = lan.status().code!;
    for (let i = 0; i < 5; i++) expect((await signIn('ZZZZ')).status).toBe(401);
    expect(lan.status().code).not.toBe(first); // Retired: guessing it further is pointless.
    for (let i = 0; i < 5; i++) await signIn('ZZZZ');
    expect((await signIn(lan.status().code!)).status).toBe(429); // Even the right code, for now.
  });

  it('guards hosts, origins and the next redirect', async () => {
    const { lan, host, port, signIn } = await setup(47_450);
    const code = lan.status().code!;
    const foreignPair = await send(
      port,
      'POST',
      '/__pm/sign-in',
      {
        host,
        origin: 'https://evil.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      new URLSearchParams({ code }).toString(),
    );
    expect(foreignPair.status).toBe(403);
    expect(lan.status().code).toBe(code);
    expect((await send(port, 'GET', '/', { host: 'evil.example' })).status).toBe(403);
    // An off-site "next" falls back to the app root (no open redirect).
    const ok = await signIn(lan.status().code!, '//evil.example/x');
    expect(ok.headers.location).toBe('/');
    const cookie = cookieOf(ok);
    const post = (origin: string) => send(port, 'POST', '/api/x', { host, cookie, origin });
    expect((await post('http://evil.example')).status).toBe(403);
    expect((await post(`http://${host}`)).status).toBe(200);
    const name = `${os.hostname().toLowerCase()}.local:${port}`;
    expect((await send(port, 'GET', '/', { host: name, cookie })).status).toBe(200);
  });

  it('keeps a device signed in: sliding cookie, one entry per device, name address', async () => {
    const { lan, host, port, signIn } = await setup(47_490);
    const cookie = cookieOf(await signIn(lan.status().code!));
    // Page loads renew the cookie (a year from last use); API calls and assets don't need to.
    const page = await send(port, 'GET', '/board', { host, cookie, accept: 'text/html' });
    expect(cookieOf(page)).toBe(cookie);
    expect(String(page.headers['set-cookie'])).toMatch(/Max-Age=31536000/);
    expect((await send(port, 'GET', '/api/x', { host, cookie })).headers['set-cookie']).toBe(
      undefined,
    );
    // Signing in again on the same device replaces its entry.
    const again = await send(
      port,
      'POST',
      '/__pm/sign-in',
      { host, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      new URLSearchParams({ code: lan.status().code!, next: '/' }).toString(),
    );
    expect(again.status).toBe(303);
    expect(lan.status().devices).toHaveLength(1);
    // The computer's name is offered last: it survives an IP change.
    const name = `${os.hostname().toLowerCase()}.local`;
    if (/^[a-z0-9-]+\.local$/.test(name)) {
      expect(lan.status().urls.at(-1)).toBe(`http://${name}:${port}/`);
    }
  });

  it('reuses its last port after a restart, waiting for the old process to let go', async () => {
    const db = openDb(':memory:');
    const make = (base: number) => {
      const lan = new LanAccess(
        db,
        (_q, r) => r.end(),
        () => 'http://localhost:5180',
        base,
        '127.0.0.1',
      );
      open.push(lan);
      return lan;
    };
    const first = make(47_510);
    expect((await first.setEnabled(true)).port).toBe(47_510);
    const host = `${ip}:47510`;
    const paired = await send(
      47_510,
      'POST',
      '/__pm/sign-in',
      { host },
      new URLSearchParams({ code: first.status().code! }).toString(),
    );
    const cookie = cookieOf(paired);
    await first.stop();
    // The previous server still holds the port for a moment, and the app port moved meanwhile.
    const holder = createServer().listen(47_510, '127.0.0.1');
    setTimeout(() => holder.close(), 700);
    const second = make(47_530);
    await second.restore();
    expect(second.status().port).toBe(47_510); // Same address: saved links keep working.
    expect((await send(47_510, 'GET', '/', { host, cookie })).status).toBe(200);
    expect(second.status().devices).toHaveLength(1);
  });

  it('through the real app: the API works, LAN settings stay local-only', async () => {
    const env = await setup(47_470);
    env.useApp();
    const cookie = cookieOf(await env.signIn(env.lan.status().code!));
    const get = (path: string) => send(env.port, 'GET', path, { host: env.host, cookie });
    expect((await get('/api/projects')).status).toBe(200);
    // The marker reaches the API (rawHeaders): a LAN device can't see the code or sign others out.
    expect((await get('/api/lan')).status).toBe(403);
  });
});

describe('codes', () => {
  it('normalises what people type', () => {
    expect(normaliseCode(' ab-c d ')).toBe('ABCD');
  });
});
