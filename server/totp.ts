import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Time-based one-time codes (RFC 6238, the scheme Google Authenticator and similar apps use):
// HMAC-SHA1 over the 30-second step count, 6 digits. The second factor for remote access
// (server/remote.ts); node:crypto only, no dependency.

const STEP_SECONDS = 30;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new 160-bit secret, base32 (what authenticator apps expect). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const index = BASE32.indexOf(ch);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code for one time step (RFC 4226 dynamic truncation). */
export function totpAt(secret: Buffer, step: number, digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac('sha1', secret).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / STEP_SECONDS);

/**
 * The time step a typed code matches, within one step either side (clock drift), or null. Steps
 * at or before `lastStep` are refused: a code works once.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastStep = -1,
): number | null {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const secret = base32Decode(secretBase32);
  const now = totpStep(nowMs);
  for (const step of [now - 1, now, now + 1]) {
    if (step <= lastStep) continue;
    const expected = Buffer.from(totpAt(secret, step));
    if (timingSafeEqual(expected, Buffer.from(typed))) return step;
  }
  return null;
}

/** The otpauth:// link an authenticator app reads from a QR code. */
export function otpauthUrl(secretBase32: string, account: string): string {
  const label = encodeURIComponent(`ProjectManager:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=ProjectManager&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}
