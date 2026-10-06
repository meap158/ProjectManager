import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import os from 'node:os';
import type { LanStatus } from '../shared/types.js';
import type { Db } from './db.js';
import { getSetting, setSetting } from './store.js';

// Opt-in LAN access. ProjectManager can read any folder and run agent CLIs, so the loopback
// server stays exactly as it is and LAN access is a *separate* listener that only ever serves
// requests carrying the access key:
//  - off by default; Settings turns it on (persisted, restarted on boot);
//  - every request needs the key: once as ?key=… (sets an HttpOnly, SameSite=Strict cookie and
//    redirects to the same URL without it), then via that cookie; compared in constant time;
//  - only this machine's own LAN addresses are accepted as Host (DNS-rebinding guard);
//  - regenerating the key signs every LAN device out;
//  - LAN requests are marked (x-pm-lan) so the API can refuse LAN-settings changes from them.
// After the gate, requests are handled like local ones (Host rewritten to the loopback origin, so
// the API's own Host allowlist and Vite's host check keep working unchanged).

const SETTINGS_KEY = 'lan_access';
const COOKIE = 'pm_lan';
export const LAN_HEADER = 'x-pm-lan';

interface LanSettings {
  enabled: boolean;
  key: string;
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

/** Failed key attempts per client address: 10 per 10 minutes, then refused for the window. */
const MAX_FAILURES = 10;
const FAILURE_WINDOW_MS = 10 * 60_000;

const newKey = () => randomBytes(24).toString('base64url');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
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

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

function cookieValue(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

const DENIED_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>ProjectManager</title><body style="font:15px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem">
<h1 style="font-size:20px">Access key needed</h1>
<p>Open the LAN link shown in <b>ProjectManager → Settings → LAN access</b> on the computer
running ProjectManager. The link signs this device in.</p></body>`;

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export class LanAccess {
  private server: Server | null = null;
  private port: number | null = null;
  private error: string | null = null;
  private failures = new Map<string, { count: number; since: number }>();

  constructor(
    private db: Db,
    private handler: Handler,
    private localOrigin: () => string,
    private basePort: number,
    /** All interfaces in production; tests pass loopback (no OS firewall prompt). */
    private bindHost = '0.0.0.0',
  ) {}

  private settings(): LanSettings {
    const saved = getSetting<LanSettings>(this.db, SETTINGS_KEY);
    if (saved?.key) return saved;
    const fresh = { enabled: false, key: newKey() };
    setSetting(this.db, SETTINGS_KEY, fresh);
    return fresh;
  }

  status(): LanStatus {
    const { enabled, key } = this.settings();
    const urls =
      this.server && this.port
        ? lanAddresses().map((ip) => `http://${ip}:${this.port}/?key=${encodeURIComponent(key)}`)
        : [];
    return { enabled, running: !!this.server, port: this.port, urls, error: this.error };
  }

  /** Starts the listener when enabled in settings (boot). */
  async restore(): Promise<void> {
    if (this.settings().enabled) await this.start();
  }

  async setEnabled(enabled: boolean): Promise<LanStatus> {
    setSetting(this.db, SETTINGS_KEY, { ...this.settings(), enabled });
    if (enabled) await this.start();
    else await this.stop();
    return this.status();
  }

  /** A new key: every LAN device must open the new link. */
  regenerateKey(): LanStatus {
    setSetting(this.db, SETTINGS_KEY, { ...this.settings(), key: newKey() });
    return this.status();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The gate: key check, host check, then the normal handler as a local request. */
  private gate: Handler = (req, res) => {
    const rawHost = req.headers.host ?? '';
    const host = rawHost.replace(/:\d+$/, '').toLowerCase();
    if (!allowedHosts().has(host)) {
      res.writeHead(403, { ...HARDENING, 'content-type': 'text/plain' }).end('Forbidden host');
      return;
    }
    const client = req.socket.remoteAddress ?? 'unknown';
    const record = this.failures.get(client);
    if (record && Date.now() - record.since > FAILURE_WINDOW_MS) this.failures.delete(client);
    if ((this.failures.get(client)?.count ?? 0) >= MAX_FAILURES) {
      res
        .writeHead(429, { ...HARDENING, 'content-type': 'text/plain', 'retry-after': '600' })
        .end('Too many wrong keys; try again later');
      return;
    }
    const deny = () => {
      const r = this.failures.get(client) ?? { count: 0, since: Date.now() };
      r.count++;
      this.failures.set(client, r);
      res
        .writeHead(401, { ...HARDENING, 'content-type': 'text/html; charset=utf-8' })
        .end(DENIED_PAGE);
    };
    const { key } = this.settings();
    const url = new URL(req.url ?? '/', 'http://lan');
    const offered = url.searchParams.get('key');
    if (offered !== null) {
      if (!safeEqual(offered, key)) return deny();
      url.searchParams.delete('key');
      // Not a 303: a SameSite=Strict cookie is withheld on navigations that started on another
      // site (a link in chat or mail), redirect hops included. This page comes from our own
      // origin, so the navigation it makes is same-site and the cookie is sent. The target is a
      // same-origin path; it is HTML-escaped and JSON-encoded where it is used.
      const target = url.pathname + url.search;
      const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="0;url=${escapeHtml(target)}"><title>ProjectManager</title>
<p style="font:15px system-ui;margin:15vh auto;max-width:32rem;padding:0 1rem">Signed in. Opening ProjectManager…</p>
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')})</script>`;
      res
        .writeHead(200, {
          ...HARDENING,
          'content-type': 'text/html; charset=utf-8',
          'set-cookie': `${COOKIE}=${encodeURIComponent(key)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        })
        .end(html);
      return;
    }
    const cookie = cookieValue(req, COOKIE);
    if (!cookie || !safeEqual(cookie, key)) return deny();
    // Writes must come from this app's own LAN origin (on top of SameSite and JSON-only writes).
    const origin = req.headers.origin;
    if (req.method !== 'GET' && req.method !== 'HEAD' && origin && origin !== `http://${rawHost}`) {
      res.writeHead(403, { ...HARDENING, 'content-type': 'text/plain' }).end('Forbidden origin');
      return;
    }
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'no-referrer');
    // Authenticated: handle like a local request, but marked as coming from the LAN.
    setHeader(req, 'host', new URL(this.localOrigin()).host);
    setHeader(req, LAN_HEADER, '1');
    this.handler(req, res);
  };

  private async start(): Promise<void> {
    if (this.server) return;
    this.error = null;
    for (let port = this.basePort; port < this.basePort + 10; port++) {
      const server = createServer((req, res) => {
        setHeader(req, LAN_HEADER, null); // Never trust a client-sent marker.
        this.gate(req, res);
      });
      server.headersTimeout = 10_000; // Slow-header clients don't hold sockets open.
      server.requestTimeout = 60_000; // Request bodies only; live output streams are unaffected.
      const ok = await new Promise<boolean>((resolve) => {
        server.once('error', () => resolve(false));
        server.listen(port, this.bindHost, () => resolve(true));
      });
      if (ok) {
        this.server = server;
        this.port = port;
        console.log(`[lan] listening on port ${port} (access key required)`);
        return;
      }
      server.close();
    }
    this.error = `No free port between ${this.basePort} and ${this.basePort + 9}`;
  }
}
