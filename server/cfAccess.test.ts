import { createHmac, generateKeyPairSync, sign, type JsonWebKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AccessVerifier, teamUrl } from './cfAccess.js';

// Cloudflare Access JWT checks: only RS256 tokens signed by the team's published key, for this
// application, from this team, within their validity window, carrying an email, get through.

const team = 'pm-test';
const aud = 'a'.repeat(64);
const config = { team, aud };
const now = 1_800_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...(publicKey.export({ format: 'jwk' }) as JsonWebKey), kid: 'k1' };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
function token(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = { alg: 'RS256', kid: 'k1' },
) {
  const payload = {
    aud: [aud],
    iss: teamUrl(team),
    email: 'Owner@Example.com',
    exp: now / 1000 + 600,
    nbf: now / 1000 - 10,
    ...claims,
  };
  const data = `${b64(header)}.${b64(payload)}`;
  return `${data}.${sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url')}`;
}

function verifier(keys: JsonWebKey[] = [jwk]) {
  const fetched: string[] = [];
  let clock = now;
  const v = new AccessVerifier(
    async (url) => {
      fetched.push(url);
      return keys;
    },
    () => clock,
  );
  return { v, fetched, tick: (ms: number) => (clock += ms) };
}

describe('AccessVerifier', () => {
  it('accepts a valid token and fetches the team keys once', async () => {
    const { v, fetched } = verifier();
    expect(await v.verify(token(), config)).toEqual({ email: 'owner@example.com' });
    expect(await v.verify(token({ aud: aud }), config)).toEqual({ email: 'owner@example.com' });
    expect(fetched).toEqual(['https://pm-test.cloudflareaccess.com/cdn-cgi/access/certs']);
  });

  it('refuses wrong audience, issuer, expired, not yet valid and email-less tokens', async () => {
    const { v } = verifier();
    expect(await v.verify(token({ aud: ['b'.repeat(64)] }), config)).toBeNull();
    expect(await v.verify(token({ iss: 'https://evil.cloudflareaccess.com' }), config)).toBeNull();
    expect(await v.verify(token({ exp: now / 1000 - 120 }), config)).toBeNull();
    expect(await v.verify(token({ nbf: now / 1000 + 600 }), config)).toBeNull();
    expect(await v.verify(token({ email: undefined, common_name: 'svc' }), config)).toBeNull();
  });

  it('refuses other algorithms, bad signatures and missing or malformed tokens', async () => {
    const { v } = verifier();
    const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64({ aud: [aud] })}.`;
    expect(await v.verify(none, config)).toBeNull();
    const data = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64({ aud: [aud], iss: teamUrl(team) })}`;
    const hs = `${data}.${createHmac('sha256', 'secret').update(data).digest('base64url')}`;
    expect(await v.verify(hs, config)).toBeNull();
    const good = token();
    const tampered = good.replace(/\.[^.]+\./, `.${b64({ aud: [aud], email: 'x@y.z' })}.`);
    expect(await v.verify(tampered, config)).toBeNull();
    expect(await v.verify(undefined, config)).toBeNull();
    expect(await v.verify('a.b', config)).toBeNull();
    expect(await v.verify(good, { team: 'bad team/..', aud })).toBeNull();
    expect(await v.verify(good, { team, aud: 'short' })).toBeNull();
  });

  it('refetches keys for an unknown kid at most once a minute, and fails closed', async () => {
    const { v, fetched, tick } = verifier();
    const other = token({}, { alg: 'RS256', kid: 'k2' });
    expect(await v.verify(other, config)).toBeNull();
    expect(await v.verify(other, config)).toBeNull();
    expect(fetched).toHaveLength(1);
    tick(61_000);
    expect(await v.verify(other, config)).toBeNull();
    expect(fetched).toHaveLength(2);

    const warn = console.warn;
    console.warn = () => {};
    const down = new AccessVerifier(
      () => Promise.reject(new Error('offline')),
      () => now,
    );
    expect(await down.verify(token(), config)).toBeNull();
    console.warn = warn;
  });
});
