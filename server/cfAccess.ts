import { createPublicKey, verify, type JsonWebKey, type KeyObject } from 'node:crypto';

// Cloudflare Access token checks for the remote listener (server/remote.ts). Cloudflare puts a
// signed JWT on every request it lets through (`Cf-Access-Jwt-Assertion`); verifying it here
// means a request that did not pass the Access login (MFA policy) never reaches the app, even
// if the tunnel or the Access application is misconfigured.
//  - RS256 only (no `none`, no HMAC), key chosen by `kid` from the team's published keys.
//  - `iss` must be the team's own URL, `aud` must include the application's AUD tag, and the
//    token must be within its validity window (60 s clock leeway).
//  - Keys are cached; an unknown `kid` refetches at most once a minute. No keys, no entry.

const LEEWAY_SECONDS = 60;
const REFETCH_MS = 60_000;
export const TEAM_NAME = /^[a-z0-9-]{1,63}$/;
/** Cloudflare's AUD tags are 64 hex characters. */
export const AUD_TAG = /^[a-f0-9]{64}$/;

export interface AccessConfig {
  /** The team name: `<team>.cloudflareaccess.com`. */
  team: string;
  /** The Access application's Application Audience (AUD) tag. */
  aud: string;
}

export interface AccessIdentity {
  email: string;
}

export type KeyFetcher = (url: string) => Promise<JsonWebKey[]>;

export const teamUrl = (team: string) => `https://${team}.cloudflareaccess.com`;

const fetchKeys: KeyFetcher = async (url) => {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
  if (!res.ok) throw new Error(`Access keys: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: JsonWebKey[] };
  return Array.isArray(body.keys) ? body.keys : [];
};

function decodePart(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export class AccessVerifier {
  private keys = new Map<string, KeyObject>();
  private keysTeam: string | null = null;
  private fetchedAt = 0;

  constructor(
    private fetcher: KeyFetcher = fetchKeys,
    private now: () => number = Date.now,
  ) {}

  /** The verified identity, or null for anything missing, malformed, unsigned or out of date. */
  async verify(token: string | undefined, config: AccessConfig): Promise<AccessIdentity | null> {
    if (!token || !TEAM_NAME.test(config.team) || !AUD_TAG.test(config.aud)) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [rawHeader, rawPayload, rawSignature] = parts as [string, string, string];
    const header = decodePart(rawHeader);
    const payload = decodePart(rawPayload);
    if (!header || !payload || header.alg !== 'RS256' || typeof header.kid !== 'string')
      return null;
    const key = await this.key(config.team, header.kid);
    if (!key) return null;
    const signed = verify(
      'RSA-SHA256',
      Buffer.from(`${rawHeader}.${rawPayload}`),
      key,
      Buffer.from(rawSignature, 'base64url'),
    );
    if (!signed) return null;
    const nowSeconds = this.now() / 1000;
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(config.aud)) return null;
    if (payload.iss !== teamUrl(config.team)) return null;
    if (typeof payload.exp !== 'number' || payload.exp + LEEWAY_SECONDS < nowSeconds) return null;
    if (typeof payload.nbf === 'number' && payload.nbf - LEEWAY_SECONDS > nowSeconds) return null;
    // Service tokens carry no email: remote access is for people who signed in.
    if (typeof payload.email !== 'string' || !payload.email.includes('@')) return null;
    return { email: payload.email.toLowerCase() };
  }

  private async key(team: string, kid: string): Promise<KeyObject | null> {
    if (this.keysTeam !== team) {
      this.keys.clear();
      this.keysTeam = team;
      this.fetchedAt = 0;
    }
    const known = this.keys.get(kid);
    if (known) return known;
    if (this.now() - this.fetchedAt < REFETCH_MS) return null;
    this.fetchedAt = this.now();
    try {
      const list = await this.fetcher(`${teamUrl(team)}/cdn-cgi/access/certs`);
      const next = new Map<string, KeyObject>();
      for (const jwk of list) {
        if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string') continue;
        next.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      }
      this.keys = next;
    } catch (error) {
      console.warn('[remote] could not fetch Cloudflare Access keys:', (error as Error).message);
      return null;
    }
    return this.keys.get(kid) ?? null;
  }
}
