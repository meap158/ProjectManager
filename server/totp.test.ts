import { describe, expect, it } from 'vitest';
import {
  base32Decode,
  base32Encode,
  newTotpSecret,
  otpauthUrl,
  totpAt,
  totpStep,
  verifyTotp,
} from './totp.js';

// RFC 6238 Appendix B (SHA1 seed "12345678901234567890", 8 digits) plus the 6-digit form apps use.

const seed = Buffer.from('12345678901234567890');

describe('totp', () => {
  it('matches the RFC 6238 test vectors', () => {
    const vectors: [number, string][] = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors)
      expect(totpAt(seed, totpStep(seconds * 1000), 8)).toBe(code);
  });

  it('round-trips base32 and makes 160-bit secrets', () => {
    expect(base32Encode(seed)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv-gy3t qojq gezd gnbv gy3t qojq')).toEqual(seed);
    expect(base32Decode(newTotpSecret())).toHaveLength(20);
    expect(() => base32Decode('not base32!')).toThrow();
  });

  it('accepts the current code and one step of drift, once', () => {
    const secret = base32Encode(seed);
    const now = 1_700_000_000_000;
    const step = totpStep(now);
    const code = totpAt(seed, step);
    expect(verifyTotp(secret, code, now)).toBe(step);
    expect(verifyTotp(secret, code.slice(0, 3) + ' ' + code.slice(3), now)).toBe(step);
    expect(verifyTotp(secret, totpAt(seed, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpAt(seed, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpAt(seed, step - 2), now)).toBeNull();
    // Replay: a step already used (or older) never works again.
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
  });

  it('builds the authenticator link', () => {
    expect(otpauthUrl('ABC', 'pm.example.com')).toBe(
      'otpauth://totp/ProjectManager%3Apm.example.com?secret=ABC&issuer=ProjectManager&algorithm=SHA1&digits=6&period=30',
    );
  });
});
