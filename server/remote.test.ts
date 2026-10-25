import { generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { createServer, request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { AccessVerifier, teamUrl } from './cfAccess.js';
import { openDb } from './db.js';
import { LAN_HEADER } from './lan.js';
import { REMOTE_HEADER, RemoteAccess, viaCloudflare } from './remote.js';
import { base32Decode, totpAt, totpStep } from './totp.js';

// The remote gate: Host, Cloudflare Access token, email allowlist, then the authenticator code and
// a session cookie, every request. The listener is loopback only; tests drive it directly.

const team = 'pm-test';
const aud = 'b'.repeat(64);
const hostname = 'pm.example.com';
const owner = 'owner@example.com';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1' };
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

type Reply = { status: number; headers: Record<string, unknown>; body: string };
const send = (
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body?: string,
) =>
  new Promise<Reply>((resolve, reject) => {
    // No pooled sockets: configure() restarts the listener, which closes them.
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent: false }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    req.end(body);
  });

const open: RemoteAccess[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((r) => r.stop()));
});

async function setup(emails = [owner]) {
  let clock = 1_800_000_000_000;
  const now = () => clock;
  const db = openDb(':memory:');
  const seen: Record<string, string | undefined>[] = [];
  let app: ReturnType<typeof createApp> | null = null;
  const remote = new RemoteAccess(
    db,
    (req, res) => {
      if (app && req.url?.startsWith('/api/')) return getRequestListener(app.fetch)(req, res);
      seen.push({
        host: req.headers.host,
        lan: req.headers[LAN_HEADER] as string | undefined,
        remote: req.headers[REMOTE_HEADER] as string | undefined,
      });
      res.writeHead(200).end('ok');
    },
    () => 'http://localhost:5180',
    // Any free port from here: the tests share one machine.
    20000 + Math.floor(Math.random() * 20000),
    new AccessVerifier(async () => [jwk], now),
    now,
  );
  app = createApp(db, { remote });
  open.push(remote);

  const token = (claims: Record<string, unknown> = {}, header = { alg: 'RS256', kid: 'k1' }) => {
    const payload = {
      aud: [aud],
      iss: teamUrl(team),
      email: owner,
      exp: clock / 1000 + 600,
      nbf: clock / 1000 - 10,
      ...claims,
    };
    const data = `${b64(header)}.${b64(payload)}`;
    return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
  };

  await remote.configure({ team, aud, hostname, emails });
  const pending = remote.beginTotp().pendingTotp!.secret;
  const codeAt = (offsetSteps: number) =>
    totpAt(base32Decode(pending), totpStep(clock) + offsetSteps);
  await remote.confirmTotp(codeAt(0));
  clock += 30_000; // The enrolment code is spent; a login needs a later step.
  const status = await remote.setEnabled(true);
  const port = status.port!;
  const headers = (extra: Record<string, string> = {}) => ({
    host: hostname,
    'cf-access-jwt-assertion': token(),
    ...extra,
  });
  const form = (code: string, extra: Record<string, string> = {}) =>
    send(
      port,
      'POST',
      '/__pm/code',
      { ...headers(), 'content-type': 'application/x-www-form-urlencoded', ...extra },
      new URLSearchParams({ code, next: '/' }).toString(),
    );
  const cookieOf = (reply: Reply) =>
    String((reply.headers['set-cookie'] as string[])[0]).split(';')[0]!;
  const signedIn = async () => cookieOf(await form(codeAt(0)));
  return {
    remote,
    db,
    seen,
    port,
    token,
    headers,
    form,
    codeAt,
    signedIn,
    advance: (ms: number) => (clock += ms),
  };
}

describe('remote access gate', () => {
  it('will not switch on until every detail and a confirmed code exist', async () => {
    const db = openDb(':memory:');
    const remote = new RemoteAccess(
      db,
      () => undefined,
      () => 'http://localhost:5180',
      31000,
    );
    open.push(remote);
    await expect(remote.setEnabled(true)).rejects.toThrow(/Still needed/);
    expect(remote.status().missing).toContain('allowed email');
    await expect(
      remote.configure({ team: 'x', aud: 'not-hex', hostname, emails: [owner] }),
    ).rejects.toThrow(/AUD/);
  });

  it('refuses the wrong Host, even with a perfect token', async () => {
    const t = await setup();
    const r = await send(t.port, 'GET', '/', { ...t.headers(), host: 'localhost' });
    expect(r.status).toBe(403);
    expect(t.seen).toHaveLength(0);
  });

  it('refuses missing, forged, expired or off-list identities', async () => {
    const t = await setup();
    const base = { host: hostname };
    expect((await send(t.port, 'GET', '/', base)).status).toBe(403);
    // Tamper with the start of the signature: the last base64 character carries unused bits.
    const parts = t.token().split('.');
    parts[2] = (parts[2]![0] === 'A' ? 'B' : 'A') + parts[2]!.slice(1);
    const forged = parts.join('.');
    expect(
      (await send(t.port, 'GET', '/', { ...base, 'cf-access-jwt-assertion': forged })).status,
    ).toBe(403);
    const expired = t.token({ exp: 1_000 });
    expect(
      (await send(t.port, 'GET', '/', { ...base, 'cf-access-jwt-assertion': expired })).status,
    ).toBe(403);
    // A valid Access login for someone who is not on our own allowlist.
    const stranger = t.token({ email: 'someone@else.com' });
    expect(
      (await send(t.port, 'GET', '/', { ...base, 'cf-access-jwt-assertion': stranger })).status,
    ).toBe(403);
    expect(t.seen).toHaveLength(0);
  });

  it('shows the code page to pages and a 401 to the API when there is no session', async () => {
    const t = await setup();
    const page = await send(t.port, 'GET', '/projects', t.headers());
    expect(page.status).toBe(401);
    expect(page.body).toContain('authenticator code');
    const api = await send(t.port, 'GET', '/api/projects', t.headers());
    expect(api.status).toBe(401);
    expect(t.seen).toHaveLength(0);
  });

  it('issues a hardened session cookie for a right code and lets the request through marked', async () => {
    const t = await setup();
    const reply = await t.form(t.codeAt(0));
    expect(reply.status).toBe(303);
    const cookie = String((reply.headers['set-cookie'] as string[])[0]);
    expect(cookie).toMatch(/^__Host-pm_remote=/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    const ok = await send(t.port, 'GET', '/', t.headers({ cookie: cookie.split(';')[0]! }));
    expect(ok.status).toBe(200);
    expect(t.seen[0]).toEqual({ host: 'localhost:5180', lan: '1', remote: '1' });
  });

  it('refuses a replayed code and locks out after five wrong ones', async () => {
    const t = await setup();
    const code = t.codeAt(0);
    expect((await t.form(code)).status).toBe(303);
    expect((await t.form(code)).status).toBe(401); // Same code, same step: spent.
    for (let i = 0; i < 4; i++) expect((await t.form('000000')).status).toBe(401);
    expect((await t.form('000001')).status).toBe(429);
    // Locked out even for the next valid code.
    t.advance(30_000);
    expect((await t.form(t.codeAt(1))).status).toBe(429);
  });

  it('ties the session to the Access identity that earned it', async () => {
    const t = await setup([owner, 'second@example.com']);
    const cookie = await t.signedIn();
    const other = t.token({ email: 'second@example.com' });
    const r = await send(t.port, 'GET', '/', {
      host: hostname,
      'cf-access-jwt-assertion': other,
      cookie,
    });
    expect(r.status).toBe(401);
    expect(t.seen).toHaveLength(0);
  });

  it('ends sessions on sign-out and when the Cloudflare details change', async () => {
    const t = await setup();
    const cookie = await t.signedIn();
    t.remote.signOut();
    expect((await send(t.port, 'GET', '/', t.headers({ cookie }))).status).toBe(401);
    t.advance(30_000); // The first code is spent; the next login needs the next step.
    const again = await t.signedIn();
    expect((await send(t.port, 'GET', '/', t.headers({ cookie: again }))).status).toBe(200);
    await t.remote.configure({ ...t.remote.status().config, emails: [owner] });
    expect(t.remote.status().sessions).toHaveLength(0);
    expect((await send(t.port, 'GET', '/', t.headers({ cookie: again }))).status).toBe(401);
  });

  it('writes need this hostname as their Origin; client markers never survive', async () => {
    const t = await setup();
    const cookie = await t.signedIn();
    const bad = await send(
      t.port,
      'POST',
      '/api/x',
      t.headers({ cookie, origin: 'https://evil.example' }),
      '{}',
    );
    expect(bad.status).toBe(403);
    await send(t.port, 'GET', '/', t.headers({ cookie, [LAN_HEADER]: '0', [REMOTE_HEADER]: '0' }));
    expect(t.seen.at(-1)).toMatchObject({ lan: '1', remote: '1' });
  });

  it('answers settings only on this computer, never through the tunnel', async () => {
    const t = await setup();
    const cookie = await t.signedIn();
    const through = await send(t.port, 'GET', '/api/remote', t.headers({ cookie }));
    expect(through.status).toBe(403);
    expect(through.body).not.toMatch(/secret|otpauth/i);
    const secrets = await send(
      t.port,
      'POST',
      '/api/remote/totp',
      t.headers({ cookie, 'content-type': 'application/json' }),
      '{}',
    );
    expect(secrets.status).toBe(403);
  });

  it('claims only the exact public hostname, and only while switched on', async () => {
    const t = await setup();
    expect(t.remote.owns(hostname)).toBe(true);
    expect(t.remote.owns(`${hostname}:5180`)).toBe(true);
    expect(t.remote.owns(hostname.toUpperCase())).toBe(true);
    for (const other of [
      'localhost',
      '127.0.0.1:5180',
      `x.${hostname}`,
      `${hostname}.evil.test`,
      '',
    ]) {
      expect(t.remote.owns(other)).toBe(false);
    }
    expect(t.remote.owns(undefined)).toBe(false);
    await t.remote.setEnabled(false);
    expect(t.remote.owns(hostname)).toBe(false);
  });

  it('serves a request handed over by the main port through the same gate', async () => {
    const t = await setup();
    // Reached over the main port: no cookie, so the code page; with Access missing, a refusal.
    const server = createServer((req, res) => t.remote.serve(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const mainPort = (server.address() as AddressInfo).port;
    try {
      const noAccess = await send(mainPort, 'GET', '/', { host: hostname });
      expect(noAccess.status).toBe(403);
      const noCode = await send(mainPort, 'GET', '/', t.headers());
      expect(noCode.status).toBe(401);
      const api = await send(mainPort, 'GET', '/api/projects', t.headers());
      expect(api.status).toBe(401);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('recognises requests that came through Cloudflare', () => {
    expect(viaCloudflare({ 'cf-ray': 'abc-AMS' })).toBe(true);
    expect(viaCloudflare({ 'cf-connecting-ip': '203.0.113.9' })).toBe(true);
    expect(viaCloudflare({ 'cf-access-jwt-assertion': 'x' })).toBe(true);
    expect(viaCloudflare({ host: 'localhost:5180', accept: '*/*' })).toBe(false);
  });

  it('sends the origin on its own form posts (same-origin policy) and still refuses a "null" one', async () => {
    const t = await setup();
    // A browser omits the Origin only under "no-referrer"; "same-origin" keeps it for the code form.
    const page = await send(t.port, 'GET', '/', t.headers());
    expect(page.headers['referrer-policy']).toBe('same-origin');
    const ok = await t.form(t.codeAt(0), { origin: `https://${hostname}` });
    expect(ok.status).toBe(303);
    const sent = await t.form(t.codeAt(1), { origin: 'null' });
    expect(sent.status).toBe(403);
  });
});
