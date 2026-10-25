import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { RemoteConfig, RemoteSession, RemoteStatus } from '../shared/types.js';
import { AUD_TAG, AccessVerifier, TEAM_NAME } from './cfAccess.js';
import type { Db } from './db.js';
import { LAN_HEADER } from './lan.js';
import { getSetting, setSetting } from './store.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from './totp.js';

// Opt-in remote access through a Cloudflare Tunnel. cloudflared runs outside this app and
// forwards to this loopback-only listener; nothing here binds a public interface. A request gets
// in only when ALL of these hold, every time:
//  1. Host is exactly the configured public hostname (a tunnel pointed at the wrong place, or a
//     rebinding page, is refused), and writes carry that hostname's own https Origin.
//  2. Cloudflare Access vouches for it: a valid, unexpired RS256 JWT for this team and AUD tag
//     (server/cfAccess.ts). Access is where MFA and the email policy live.
//  3. The JWT's email is on this app's own allowlist (a policy of "Everyone" must not be enough).
//  4. A session cookie from this app's second factor (an authenticator app code, RFC 6238),
//     issued to that same email. Codes work once; failures lock out per email and globally,
//     because every request reaches us from 127.0.0.1 and the socket address says nothing.
// Settings, enrolment and secrets are answered on this computer only: requests through here carry
// the LAN marker (so the API refuses LAN-style settings) and a remote marker of their own.

const SETTINGS_KEY = 'remote_access';
export const REMOTE_HEADER = 'x-pm-remote';
const COOKIE = '__Host-pm_remote';
const TOTP_PATH = '/__pm/code';
const SESSION_TTL_MS = 12 * 3_600_000;
const MAX_SESSIONS = 10;
const FAIL_WINDOW_MS = 10 * 60_000;
const MAX_FAILS_PER_EMAIL = 5;
const MAX_FAILS_TOTAL = 20;
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PORT_RETRIES = 6;
const PORT_RETRY_MS = 500;

interface StoredSession extends RemoteSession {
  tokenHash: string;
}

interface RemoteSettings {
  enabled: boolean;
  config: RemoteConfig;
  totp: { secret: string | null; confirmed: boolean; lastStep: number };
  pending: string | null;
  sessions: StoredSession[];
  port?: number;
}

const EMPTY_CONFIG: RemoteConfig = { team: '', aud: '', hostname: '', emails: [] };
const hash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Cloudflare adds these to every request it forwards. A request carrying one that reaches the main
 * (local) listener has had its Host rewritten, so it must not be treated as this computer.
 */
export function viaCloudflare(headers: IncomingMessage['headers']): boolean {
  return ['cf-ray', 'cf-connecting-ip', 'cf-access-jwt-assertion', 'cf-visitor'].some(
    (name) => headers[name] !== undefined,
  );
}

const HARDENING = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'same-origin',
  'cache-control': 'no-store',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

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
    if (k === name) return v.join('=');
  }
  return null;
}

const sessionCookie = (token: string) =>
  `${COOKIE}=${token}; Secure; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}`;

function codePage(message: string | null, next: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Verify · ProjectManager</title>
<style>
body{font:16px system-ui,sans-serif;margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f6f4;color:#1b1b1a}
@media (prefers-color-scheme:dark){body{background:#121211;color:#e4e3dd}input{background:#1a1a19;color:#e4e3dd;border-color:#3d3d39}}
main{width:min(22rem,calc(100vw - 2rem))}h1{font-size:20px;margin:0 0 6px}p{margin:0 0 16px;opacity:.75;font-size:14px;line-height:1.45}
input{width:100%;box-sizing:border-box;font:600 28px ui-monospace,monospace;letter-spacing:.3em;text-align:center;padding:12px;border:1px solid #c9c8c1;border-radius:10px}
button{margin-top:12px;width:100%;font:600 15px system-ui;padding:12px;border:0;border-radius:10px;background:#3b6ea8;color:#fff}
.err{color:#c4423b;opacity:1;font-size:14px;margin:0 0 12px}
</style>
<main><h1>Enter your authenticator code</h1>
<p>The 6-digit code from the authenticator app you set up in <b>Settings → Remote access</b>.</p>
${message ? `<p class="err" role="alert">${escapeHtml(message)}</p>` : ''}
<form method="post" action="${TOTP_PATH}">
<input type="hidden" name="next" value="${escapeHtml(next)}">
<input name="code" aria-label="Authenticator code" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" autocomplete="one-time-code" autofocus required>
<button type="submit">Continue</button></form>
</main></html>`;
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

export class RemoteAccess {
  private server: Server | null = null;
  private port: number | null = null;
  private error: string | null = null;
  private fails = new Map<string, { count: number; since: number }>();
  private totalFails = { count: 0, since: Date.now() };

  constructor(
    private db: Db,
    private handler: Handler,
    private localOrigin: () => string,
    private basePort: number,
    private verifier: AccessVerifier = new AccessVerifier(),
    private now: () => number = Date.now,
  ) {}

  private settings(): RemoteSettings {
    const saved = getSetting<Partial<RemoteSettings>>(this.db, SETTINGS_KEY);
    return {
      enabled: saved?.enabled ?? false,
      config: { ...EMPTY_CONFIG, ...(saved?.config ?? {}) },
      totp: { secret: null, confirmed: false, lastStep: -1, ...(saved?.totp ?? {}) },
      pending: saved?.pending ?? null,
      sessions: saved?.sessions ?? [],
      ...(saved?.port ? { port: saved.port } : {}),
    };
  }

  private save(next: RemoteSettings): void {
    setSetting(this.db, SETTINGS_KEY, next);
  }

  /** What still stops access being switched on. */
  private missing(s: RemoteSettings): string[] {
    const out: string[] = [];
    if (!TEAM_NAME.test(s.config.team)) out.push('Cloudflare team name');
    if (!AUD_TAG.test(s.config.aud)) out.push('Access application AUD tag');
    if (!HOSTNAME.test(s.config.hostname)) out.push('public hostname');
    if (s.config.emails.length === 0) out.push('allowed email');
    if (!s.totp.confirmed || !s.totp.secret) out.push('confirmed authenticator code');
    return out;
  }

  status(): RemoteStatus {
    const s = this.settings();
    return {
      enabled: s.enabled,
      running: this.server !== null,
      port: this.port,
      config: s.config,
      totpConfirmed: s.totp.confirmed,
      pendingTotp: s.pending
        ? { secret: s.pending, otpauth: otpauthUrl(s.pending, s.config.hostname || 'remote') }
        : null,
      sessions: s.sessions.map(({ tokenHash: _hash, ...session }) => session),
      missing: this.missing(s),
      error: this.error,
    };
  }

  /**
   * Whether a request for this Host belongs to the remote gate. The main listener asks, so the tunnel
   * can point at the app's own port: the public hostname is then answered ONLY through the gate
   * (Access token, email allowlist, authenticator code), never as a local request.
   */
  owns(hostHeader: string | undefined): boolean {
    const s = this.settings();
    if (!s.enabled || this.missing(s).length > 0) return false;
    return (hostHeader ?? '').replace(/:\d+$/, '').toLowerCase() === s.config.hostname;
  }

  /** Runs one request through the gate; client-sent markers never survive. */
  serve(req: IncomingMessage, res: ServerResponse): void {
    setHeader(req, LAN_HEADER, null);
    setHeader(req, REMOTE_HEADER, null);
    this.gate(req, res).catch((e: Error) => {
      console.error('[remote]', e.message);
      if (!res.headersSent) res.writeHead(500).end();
    });
  }

  /** Saves the Cloudflare details. Any running listener restarts so it never serves stale ones. */
  async configure(input: RemoteConfig): Promise<RemoteStatus> {
    const emails = [...new Set(input.emails.map((e) => e.trim().toLowerCase()).filter(Boolean))];
    const team = input.team.trim().toLowerCase();
    const aud = input.aud.trim().toLowerCase();
    const hostname = input.hostname.trim().toLowerCase();
    if (team && !TEAM_NAME.test(team)) throw new Error('Team name: letters, digits and dashes');
    if (aud && !AUD_TAG.test(aud)) throw new Error('AUD tag: 64 hex characters');
    if (hostname && !HOSTNAME.test(hostname)) throw new Error('Hostname: like pm.example.com');
    if (emails.some((e) => !EMAIL.test(e))) throw new Error('Allowed emails: check the format');
    const s = this.settings();
    // Changed details end every session: they were issued under the old ones.
    this.save({ ...s, config: { team, aud, hostname, emails }, sessions: [] });
    if (this.server) {
      await this.stop();
      await this.start();
    }
    return this.status();
  }

  /** A fresh secret to enrol an authenticator app with. It stays pending until a code confirms it. */
  beginTotp(): RemoteStatus {
    this.save({ ...this.settings(), pending: newTotpSecret() });
    return this.status();
  }

  /** Activates the pending secret once a code from it is typed. Existing sessions end. */
  async confirmTotp(code: string): Promise<RemoteStatus> {
    const s = this.settings();
    if (!s.pending) throw new Error('Start enrolment first');
    const step = verifyTotp(s.pending, code, this.now());
    if (step === null) throw new Error('That code did not match; check the app and the clock');
    this.save({
      ...s,
      pending: null,
      totp: { secret: s.pending, confirmed: true, lastStep: step },
      sessions: [],
    });
    return this.status();
  }

  async setEnabled(enabled: boolean): Promise<RemoteStatus> {
    const s = this.settings();
    if (enabled) {
      const missing = this.missing(s);
      if (missing.length > 0) throw new Error(`Still needed: ${missing.join(', ')}`);
    }
    this.save({ ...s, enabled });
    if (enabled) await this.start();
    else await this.stop();
    return this.status();
  }

  signOut(id?: string): RemoteStatus {
    const s = this.settings();
    this.save({ ...s, sessions: id ? s.sessions.filter((x) => x.id !== id) : [] });
    return this.status();
  }

  async restore(): Promise<void> {
    if (this.settings().enabled) await this.start();
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.port = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private lockedOut(email: string): boolean {
    const now = this.now();
    if (now - this.totalFails.since > FAIL_WINDOW_MS) this.totalFails = { count: 0, since: now };
    const mine = this.fails.get(email);
    if (mine && now - mine.since > FAIL_WINDOW_MS) this.fails.delete(email);
    return (
      this.totalFails.count >= MAX_FAILS_TOTAL ||
      (this.fails.get(email)?.count ?? 0) >= MAX_FAILS_PER_EMAIL
    );
  }

  private recordFailure(email: string): void {
    const mine = this.fails.get(email) ?? { count: 0, since: this.now() };
    mine.count++;
    this.fails.set(email, mine);
    this.totalFails.count++;
  }

  private async readForm(req: IncomingMessage): Promise<URLSearchParams> {
    let body = '';
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > 2048) break;
    }
    return new URLSearchParams(body);
  }

  private deny(res: ServerResponse, status: number, text: string, extra = {}): void {
    res.writeHead(status, { ...HARDENING, 'content-type': 'text/plain', ...extra }).end(text);
  }

  private page(res: ServerResponse, status: number, message: string | null, next: string): void {
    res
      .writeHead(status, { ...HARDENING, 'content-type': 'text/html; charset=utf-8' })
      .end(codePage(message, next));
  }

  /** The whole gate; see the header comment. */
  private gate = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const s = this.settings();
    if (!s.enabled || this.missing(s).length > 0)
      return this.deny(res, 503, 'Remote access is off');
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').toLowerCase();
    if (host !== s.config.hostname) return this.deny(res, 403, 'Forbidden host');
    const origin = req.headers.origin;
    if (
      req.method !== 'GET' &&
      req.method !== 'HEAD' &&
      origin &&
      origin !== `https://${s.config.hostname}`
    ) {
      return this.deny(res, 403, 'Forbidden origin');
    }
    const token = req.headers['cf-access-jwt-assertion'];
    const identity = await this.verifier.verify(typeof token === 'string' ? token : undefined, {
      team: s.config.team,
      aud: s.config.aud,
    });
    if (!identity || !s.config.emails.includes(identity.email)) {
      return this.deny(res, 403, 'Not signed in through Cloudflare Access');
    }
    const url = new URL(req.url ?? '/', 'http://remote');

    if (url.pathname === TOTP_PATH && req.method === 'POST') {
      if (this.lockedOut(identity.email)) {
        return this.deny(res, 429, 'Too many wrong codes; try again later', {
          'retry-after': '600',
        });
      }
      const form = await this.readForm(req);
      const next = form.get('next') ?? '/';
      const safeNext = next.startsWith('/') && !next.startsWith('//') ? next : '/';
      const step = verifyTotp(s.totp.secret!, form.get('code') ?? '', this.now(), s.totp.lastStep);
      if (step === null) {
        this.recordFailure(identity.email);
        return this.page(res, 401, 'That code did not match.', safeNext);
      }
      const sessionToken = randomBytes(32).toString('base64url');
      const stamp = new Date(this.now()).toISOString();
      const session: StoredSession = {
        id: randomBytes(6).toString('hex'),
        email: identity.email,
        signedInAt: stamp,
        lastSeenAt: stamp,
        expiresAt: new Date(this.now() + SESSION_TTL_MS).toISOString(),
        tokenHash: hash(sessionToken),
      };
      // Persisting lastStep keeps a used code dead across restarts.
      this.save({
        ...s,
        totp: { ...s.totp, lastStep: step },
        sessions: [
          ...s.sessions.filter((x) => Date.parse(x.expiresAt) > this.now()),
          session,
        ].slice(-MAX_SESSIONS),
      });
      res
        .writeHead(303, {
          ...HARDENING,
          'set-cookie': sessionCookie(sessionToken),
          location: safeNext,
        })
        .end();
      return;
    }

    const cookie = cookieValue(req, COOKIE);
    const session = cookie
      ? s.sessions.find(
          (x) =>
            x.tokenHash === hash(cookie) &&
            x.email === identity.email &&
            Date.parse(x.expiresAt) > this.now(),
        )
      : undefined;
    if (!session) {
      if (url.pathname.startsWith('/api/')) {
        res.writeHead(401, { ...HARDENING, 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'Enter your authenticator code first' }));
      } else {
        this.page(res, 401, null, url.pathname + url.search);
      }
      return;
    }
    // Sliding expiry, written at most once a minute.
    if (this.now() - Date.parse(session.lastSeenAt) > 60_000) {
      this.save({
        ...s,
        sessions: s.sessions.map((x) =>
          x.id === session.id
            ? {
                ...x,
                lastSeenAt: new Date(this.now()).toISOString(),
                expiresAt: new Date(this.now() + SESSION_TTL_MS).toISOString(),
              }
            : x,
        ),
      });
      if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) {
        res.setHeader('set-cookie', sessionCookie(cookie!));
      }
    }
    res.setHeader('x-frame-options', 'DENY');
    res.setHeader('referrer-policy', 'same-origin');
    setHeader(req, 'host', new URL(this.localOrigin()).host);
    setHeader(req, LAN_HEADER, '1'); // Same restrictions as a LAN device, and the same bundle.
    setHeader(req, REMOTE_HEADER, '1');
    this.handler(req, res);
  };

  private async start(): Promise<void> {
    if (this.server) return;
    this.error = null;
    const saved = this.settings().port;
    const range = Array.from({ length: 10 }, (_, i) => this.basePort + i);
    const candidates = saved ? [saved, ...range.filter((p) => p !== saved)] : range;
    for (const port of candidates) {
      const tries = port === saved ? PORT_RETRIES : 1;
      for (let attempt = 0; attempt < tries; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, PORT_RETRY_MS));
        const server = await this.listen(port);
        if (!server) continue;
        this.server = server;
        this.port = port;
        if (saved !== port) this.save({ ...this.settings(), port });
        console.log(
          `[remote] listening on 127.0.0.1:${port} for the tunnel (Access + code required)`,
        );
        return;
      }
    }
    this.error = `No free port: tried ${candidates.join(', ')}`;
  }

  private async listen(port: number): Promise<Server | null> {
    const server = createServer((req, res) => this.serve(req, res));
    server.headersTimeout = 10_000;
    server.requestTimeout = 60_000;
    server.keepAliveTimeout = 65_000;
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => resolve(true));
    });
    if (ok) return server;
    server.close();
    return null;
  }
}
