import { createHash, randomBytes, randomInt } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import type { LanDevice, LanStatus } from '../shared/types.js';
import type { Db } from './db.js';
import { getSetting, setSetting } from './store.js';

// Opt-in LAN access. ProjectManager can read any folder and run agent CLIs, so the loopback
// server stays exactly as it is and LAN access is a *separate* listener that only serves signed-in
// devices. Sign-in follows the device-flow pattern (GitHub, TV apps): the device opens the plain
// address and types the short code shown in Settings on this computer.
//  - Off by default; Settings turns it on (persisted, restarted on boot).
//  - Pairing code: 4 characters from an unambiguous alphabet, single use, valid 10 minutes, and
//    retired after 5 wrong tries, so a guesser gets at most 5 tries out of ~920,000 per code (the
//    code is only ever shown on this computer). Wrong tries are also rate-limited per client.
//  - A successful sign-in gives the device its own long random token (stored hashed) in an
//    HttpOnly, SameSite=Lax cookie; Settings lists devices and can sign each (or all) out.
//  - Signed-in devices stay signed in (PM-37): devices live in the settings table, the cookie is
//    renewed on every page load (a year from last use, not from sign-in), the listener reuses
//    its last port across restarts so saved links and home-screen icons keep working, and the
//    computer's name (<name>.local) is offered as an address that survives an IP change.
//  - Only this machine's own LAN addresses/name are accepted as Host (DNS-rebinding guard).
//  - LAN requests are marked (x-pm-lan) so the API refuses LAN-settings requests from them.
// After the gate, requests are handled like local ones (Host rewritten in req.headers and
// rawHeaders, so the API's Host allowlist and Vite's host check keep working unchanged).

const SETTINGS_KEY = 'lan_access';
const COOKIE = 'pm_lan';
const PAIR_PATH = '/__pm/sign-in';
export const LAN_HEADER = 'x-pm-lan';

/** No 0/O, 1/I/L: easy to read aloud and type on a phone. */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 4;
const CODE_TTL_MS = 10 * 60_000;
const CODE_MAX_FAILURES = 5;
const MAX_DEVICES = 20;

interface StoredDevice extends LanDevice {
  tokenHash: string;
}

interface LanSettings {
  enabled: boolean;
  devices: StoredDevice[];
  /** The last port the listener used: tried first so a device's saved address keeps working. */
  port?: number;
}

/** Virtual adapters that are not "the network" (after AdRelay's lan-access.mjs). */
const VIRTUAL =
  /hyper-v|vethernet|wsl|docker|virtualbox|vmware|vpn|tailscale|zerotier|loopback|utun|tun\d|tap/i;
const PRIVATE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * This machine's IPv4 addresses on real local networks: private (RFC 1918) ranges only, virtual
 * adapters (Hyper-V, WSL, Docker, VPNs) skipped, home networks (192.168.x) first.
 */
export function lanAddresses(): string[] {
  const rank = (ip: string) => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : 2);
  return Object.entries(os.networkInterfaces())
    .filter(([name]) => !VIRTUAL.test(name))
    .flatMap(([, list]) => list ?? [])
    .filter((a) => a.family === 'IPv4' && !a.internal && PRIVATE.test(a.address))
    .map((a) => a.address)
    .sort((a, b) => rank(a) - rank(b));
}

/** This computer's mDNS name (`<hostname>.local`), when the hostname is a valid DNS label. */
function localName(): string | null {
  const name = os.hostname().toLowerCase();
  return /^[a-z0-9-]{1,63}$/.test(name) ? `${name}.local` : null;
}

/** Host names a LAN device may use for this machine (DNS-rebinding guard). */
function allowedHosts(): Set<string> {
  const name = os.hostname().toLowerCase();
  return new Set([...lanAddresses(), name, `${name}.local`]);
}

/** Response headers on everything the LAN listener sends itself. */
const HARDENING = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

/** Failed sign-in attempts per client address: 10 per 10 minutes, then refused for the window. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
/** The device cookie, valid a year from now (re-sent on page loads, so a year from last use). */
const deviceCookie = (token: string) =>
  `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`;
/** EADDRINUSE retries for the remembered port: a restarting server may still be releasing it. */
const PORT_RETRIES = 6;
const PORT_RETRY_MS = 500;
const newCode = () =>
  Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
/** What a person typed, normalised: case, spaces and dashes don't matter. */
export const normaliseCode = (typed: string) => typed.toUpperCase().replace(/[\s-]/g, '');

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/**
 * Sets (or with null, removes) a request header in both views Node keeps: req.headers and
 * req.rawHeaders. The Hono adapter builds its Request from rawHeaders, so changing only
 * req.headers would not reach the API.
 */
function setHeader(req: IncomingMessage, name: string, value: string | null): void {
  const lower = name.toLowerCase();
  const raw: string[] = [];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i]!.toLowerCase() !== lower)
      raw.push(req.rawHeaders[i]!, req.rawHeaders[i + 1]!);
  }
  if (value === null) delete req.headers[lower];
  else {
    req.headers[lower] = value;
    raw.push(name, value);
  }
  req.rawHeaders.splice(0, req.rawHeaders.length, ...raw);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** A short, human label for a device from its browser's user agent. */
function deviceLabel(ua: string): string {
  const system = /iPhone|iPad|Android|Windows|Mac OS|Linux|CrOS/.exec(ua)?.[0] ?? 'Device';
  const browser = /Edg|Firefox|Chrome|Safari/.exec(ua)?.[0] ?? 'browser';
  const names: Record<string, string> = { 'Mac OS': 'Mac', CrOS: 'ChromeOS', Edg: 'Edge' };
  return `${names[system] ?? system} · ${names[browser] ?? browser}`;
}

/** The sign-in page: one code field, big enough for a phone keyboard. */
function signInPage(message: string | null, next: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sign in · ProjectManager</title>
<style>
body{font:16px system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f4;color:#1b1b1a}
@media (prefers-color-scheme:dark){body{background:#121211;color:#e4e3dd}input{background:#1a1a19;color:#e4e3dd;border-color:#3d3d39}}
main{width:min(22rem,calc(100vw - 2rem))}h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;opacity:.75;font-size:14px;line-height:1.45}
input{width:100%;box-sizing:border-box;font:600 28px ui-monospace,monospace;letter-spacing:.4em;text-align:center;text-transform:uppercase;padding:12px;border:1px solid #c9c8c1;border-radius:10px}
button{margin-top:12px;width:100%;font:600 15px system-ui;padding:12px;border:0;border-radius:10px;background:#3b6ea8;color:#fff}
.err{color:#c4423b;opacity:1;font-size:14px;margin:0 0 12px}
</style>
<main><h1>Sign in to ProjectManager</h1>
<p>Type the code shown in <b>Settings → LAN access</b> on the computer running ProjectManager.</p>
${message ? `<p class="err" role="alert">${escapeHtml(message)}</p>` : ''}
<form method="post" action="${PAIR_PATH}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<input name="code" aria-label="Sign-in code" maxlength="9" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" autofocus required>
<button type="submit">Sign in</button></form>
<p style="margin-top:12px">This browser stays signed in. Save this address and use the same browser next time.</p>
</main><script>
const pairing = new URLSearchParams(location.hash.slice(1)).get('pair');
if (pairing) {
  history.replaceState(null, '', location.pathname + location.search);
  if (/^[A-HJKMNP-Z2-9]{4}$/.test(pairing)) document.querySelector('input[name="code"]').value = pairing;
}
</script></html>`;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** How often the bound LAN addresses are compared with the machine's current ones. */
const ADDRESS_CHECK_MS = 30_000;

export class LanAccess {
  /** One server per LAN address on the app's own port, or one on all interfaces (fallback). */
  private servers: Server[] = [];
  /** The LAN addresses bound individually (empty in the all-interfaces fallback). */
  private boundIps: string[] = [];
  private addressWatch: ReturnType<typeof setInterval> | null = null;
  private port: number | null = null;
  private error: string | null = null;
  private failures = new Map<string, { count: number; since: number }>();
  private pairing: { code: string; expiresAt: number; failures: number } | null = null;

  constructor(
    private db: Db,
    private handler: Handler,
    private localOrigin: () => string,
    private basePort: number,
    /** All interfaces in production; tests pass loopback (no OS firewall prompt). */
    private bindHost = '0.0.0.0',
    /**
     * The app's own port (PM-49): tried first on each of this machine's LAN addresses, so a
     * phone uses the same port as this computer. Specific addresses never clash with the app's
     * loopback listeners on any OS (all interfaces would on Linux/macOS).
     */
    private appPort: number | null = null,
  ) {}

  private settings(): LanSettings {
    const saved = getSetting<Partial<LanSettings>>(this.db, SETTINGS_KEY);
    return {
      enabled: saved?.enabled ?? false,
      devices: saved?.devices ?? [],
      ...(saved?.port ? { port: saved.port } : {}),
    };
  }

  private save(next: LanSettings): void {
    setSetting(this.db, SETTINGS_KEY, next);
  }

  /** The current pairing code, made fresh when missing or expired. */
  private code() {
    if (!this.pairing || Date.now() > this.pairing.expiresAt) {
      this.pairing = { code: newCode(), expiresAt: Date.now() + CODE_TTL_MS, failures: 0 };
    }
    return this.pairing;
  }

  status(): LanStatus {
    const { enabled, devices } = this.settings();
    const running = this.servers.length > 0;
    const pairing = running ? this.code() : null;
    const ips = lanAddresses();
    const name = localName();
    // IP addresses first (always work); the name last (survives IP changes where .local resolves).
    const hosts = ips.length > 0 && name ? [...ips, name] : ips;
    return {
      enabled,
      running,
      port: this.port,
      urls: running && this.port ? hosts.map((host) => `http://${host}:${this.port}/`) : [],
      code: pairing?.code ?? null,
      codeExpiresAt: pairing ? new Date(pairing.expiresAt).toISOString() : null,
      devices: devices.map((d) => ({
        id: d.id,
        label: d.label,
        address: d.address,
        signedInAt: d.signedInAt,
        lastSeenAt: d.lastSeenAt,
      })),
      error: this.error,
    };
  }

  /** Starts the listener when enabled in settings (boot). */
  async restore(): Promise<void> {
    if (this.settings().enabled) await this.start();
  }

  async setEnabled(enabled: boolean): Promise<LanStatus> {
    this.save({ ...this.settings(), enabled });
    if (enabled) await this.start();
    else await this.stop();
    return this.status();
  }

  /** Replaces the pairing code (the old one stops working at once). */
  newCode(): LanStatus {
    this.pairing = null;
    return this.status();
  }

  /** Signs one device out, or every device when id is omitted. */
  signOut(id?: string): LanStatus {
    const settings = this.settings();
    this.save({ ...settings, devices: id ? settings.devices.filter((d) => d.id !== id) : [] });
    return this.status();
  }

  async stop(): Promise<void> {
    const servers = this.servers;
    this.servers = [];
    this.boundIps = [];
    this.port = null;
    this.pairing = null;
    if (this.addressWatch) clearInterval(this.addressWatch);
    this.addressWatch = null;
    await Promise.all(
      servers.map((server) => {
        server.closeAllConnections();
        return new Promise<void>((resolve) => server.close(() => resolve()));
      }),
    );
  }

  private signedInDevice(req: IncomingMessage): StoredDevice | null {
    const token = cookieValue(req, COOKIE);
    if (!token) return null;
    const tokenHash = hash(token); // Hash first: lookups never compare raw secrets.
    return this.settings().devices.find((d) => d.tokenHash === tokenHash) ?? null;
  }

  /** Marks a device as seen (at most once a minute, to keep writes rare). */
  private touch(device: StoredDevice): void {
    if (Date.now() - Date.parse(device.lastSeenAt) < 60_000) return;
    const settings = this.settings();
    this.save({
      ...settings,
      devices: settings.devices.map((d) =>
        d.id === device.id ? { ...d, lastSeenAt: new Date().toISOString() } : d,
      ),
    });
  }

  private async readForm(req: IncomingMessage): Promise<URLSearchParams> {
    let body = '';
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > 2048) break; // A code and a path: never more than this.
    }
    return new URLSearchParams(body);
  }

  private page(res: ServerResponse, status: number, message: string | null, next: string): void {
    res
      .writeHead(status, { ...HARDENING, 'content-type': 'text/html; charset=utf-8' })
      .end(signInPage(message, next));
  }

  /** The gate: host check, sign-in, then the normal handler as a local request. */
  private gate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const rawHost = req.headers.host ?? '';
    const host = rawHost.replace(/:\d+$/, '').toLowerCase();
    if (!allowedHosts().has(host)) {
      res.writeHead(403, { ...HARDENING, 'content-type': 'text/plain' }).end('Forbidden host');
      return;
    }
    const url = new URL(req.url ?? '/', 'http://lan');
    const client = req.socket.remoteAddress ?? 'unknown';
    // Guard all writes, including pairing, before inspecting or consuming credentials.
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin && origin !== `http://${rawHost}`) {
      res.writeHead(403, { ...HARDENING, 'content-type': 'text/plain' }).end('Forbidden origin');
      return;
    }

    if (url.pathname === PAIR_PATH && req.method === 'POST') {
      const record = this.failures.get(client);
      if (record && Date.now() - record.since > FAILURE_WINDOW_MS) this.failures.delete(client);
      if ((this.failures.get(client)?.count ?? 0) >= MAX_FAILURES) {
        res
          .writeHead(429, { ...HARDENING, 'content-type': 'text/plain', 'retry-after': '600' })
          .end('Too many wrong codes; try again later');
        return;
      }
      const form = await this.readForm(req);
      const next = form.get('next') ?? '/';
      const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
      const pairing = this.code();
      if (normaliseCode(form.get('code') ?? '') !== pairing.code) {
        const r = this.failures.get(client) ?? { count: 0, since: Date.now() };
        r.count++;
        this.failures.set(client, r);
        // Too many wrong tries on this code: retire it (a fresh one shows in Settings).
        if (++pairing.failures >= CODE_MAX_FAILURES) this.pairing = null;
        this.page(res, 401, 'That code didn’t match. Check Settings on the computer.', safeNext);
        return;
      }
      this.pairing = null; // Single use.
      const token = randomBytes(32).toString('base64url');
      const now = new Date().toISOString();
      const settings = this.settings();
      // Signing in again on a device that still has a cookie replaces its entry, not adds one.
      const previous = this.signedInDevice(req);
      const device: StoredDevice = {
        id: randomBytes(6).toString('hex'),
        label: deviceLabel(req.headers['user-agent'] ?? ''),
        address: client.replace(/^::ffff:/, ''),
        signedInAt: now,
        lastSeenAt: now,
        tokenHash: hash(token),
      };
      const others = settings.devices.filter((d) => d.id !== previous?.id);
      this.save({ ...settings, devices: [...others, device].slice(-MAX_DEVICES) });
      // Lax also sends the cookie when returning via a bookmark, link, or QR scanner.
      res
        .writeHead(303, {
          ...HARDENING,
          'set-cookie': deviceCookie(token),
          location: safeNext,
        })
        .end();
      return;
    }

    const device = this.signedInDevice(req);
    if (!device) {
      // API calls get a plain 401; pages get the sign-in form (returning here after).
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(401, { ...HARDENING, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Sign in on this device first' }));
      } else {
        this.page(res, 401, null, url.pathname + url.search);
      }
      return;
    }
    // Writes must come from this app's own LAN origin (on top of SameSite and JSON-only writes).
    this.touch(device);
    // Sliding expiry: page loads renew the cookie, so a device in use never reaches the end.
    if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
      res.setHeader('set-cookie', deviceCookie(cookieValue(req, COOKIE)!));
    }
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    // Signed in: handle like a local request, but marked as coming from the LAN.
    setHeader(req, 'host', new URL(this.localOrigin()).host);
    setHeader(req, LAN_HEADER, '1');
    this.handler(req, res);
  };

  private async start(): Promise<void> {
    if (this.servers.length > 0) return;
    this.error = null;
    if (this.appPort && this.bindHost === '0.0.0.0' && (await this.startOnAppPort(this.appPort))) {
      return;
    }
    const saved = this.settings().port;
    const range = Array.from({ length: 10 }, (_, i) => this.basePort + i);
    const candidates = saved ? [saved, ...range.filter((p) => p !== saved)] : range;
    for (const port of candidates) {
      // The remembered port gets a few retries: after a restart the old process may still hold it.
      const tries = port === saved ? PORT_RETRIES : 1;
      for (let attempt = 0; attempt < tries; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, PORT_RETRY_MS));
        const server = await this.listen(port, this.bindHost);
        if (!server) continue;
        this.servers = [server];
        this.port = port;
        if (saved !== port) this.save({ ...this.settings(), port });
        console.log(`[lan] listening on port ${port} (sign-in required)`);
        return;
      }
    }
    this.error = `No free port: tried ${candidates.join(', ')}`;
  }

  /**
   * The same port as the app, on each of this machine's LAN addresses. All of them or none: a
   * half-bound set would leave some addresses unreachable. Re-binds when the addresses change
   * (new Wi-Fi, new DHCP lease), checked every 30 seconds.
   */
  private async startOnAppPort(port: number): Promise<boolean> {
    const ips = lanAddresses();
    if (ips.length === 0) return false;
    const servers: Server[] = [];
    for (const ip of ips) {
      const server = await this.listen(port, ip);
      if (server) servers.push(server);
    }
    if (servers.length !== ips.length) {
      for (const server of servers) server.close();
      return false;
    }
    this.servers = servers;
    this.boundIps = ips;
    this.port = port;
    console.log(
      `[lan] listening on ${ips.join(', ')} port ${port}, as this computer (sign-in required)`,
    );
    this.addressWatch = setInterval(() => {
      if (lanAddresses().join() === this.boundIps.join()) return;
      console.log('[lan] network addresses changed; listening again');
      void this.stop().then(() => this.start());
    }, ADDRESS_CHECK_MS);
    this.addressWatch.unref();
    return true;
  }

  /** One listen attempt: the server on success, null when the port is taken. */
  private async listen(port: number, host: string): Promise<Server | null> {
    const server = createServer((req, res) => {
      setHeader(req, LAN_HEADER, null); // Never trust a client-sent marker.
      this.gate(req, res).catch((e: Error) => {
        console.error('[lan]', e.message);
        if (!res.headersSent) res.writeHead(500).end();
      });
    });
    server.headersTimeout = 10_000; // Slow-header clients don't hold sockets open.
    server.requestTimeout = 60_000; // Request bodies only; live output streams are unaffected.
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, host, () => resolve(true));
    });
    if (ok) return server;
    server.close();
    return null;
  }
}
