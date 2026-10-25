import { expect, it } from 'vitest';
import { usageIsFresh, verifiedRemainingQuota } from './accountPolicy.js';
const now = Date.parse('2026-10-25T12:00:00Z');
const reading = () => ({
  status: 'fresh',
  checkedAt: new Date(now).toISOString(),
  limits: {
    providerId: 'fixture',
    source: 'fixture',
    asOf: new Date(now).toISOString(),
    windows: [
      {
        label: '5-hour',
        usedPercent: 20,
        windowMinutes: 300,
        resetsAt: new Date(now + 60000).toISOString(),
      },
      { label: 'Weekly', usedPercent: 75, windowMinutes: 10080, resetsAt: null },
    ],
  },
});
it('uses the limiting quota window and accepts confirmed exhaustion only', () => {
  expect(verifiedRemainingQuota(reading(), now)).toBe(25);
  const r = reading();
  r.limits.windows[0]!.usedPercent = 100;
  expect(verifiedRemainingQuota(r, now)).toBe(0);
  r.limits.windows[0]!.usedPercent = 99;
  expect(verifiedRemainingQuota(r, now)).toBe(1);
});
it('rejects stale, future, unavailable, malformed and reset-due readings', () => {
  for (const age of [-1, 60001]) {
    const r = reading();
    r.checkedAt = new Date(now - age).toISOString();
    expect(verifiedRemainingQuota(r, now)).toBeNull();
  }
  const oldReport = reading();
  oldReport.limits.asOf = new Date(now - 60001).toISOString();
  expect(verifiedRemainingQuota(oldReport, now)).toBeNull();
  for (const used of [NaN, Infinity, -1, 101]) {
    const r = reading();
    r.limits.windows[0]!.usedPercent = used;
    expect(verifiedRemainingQuota(r, now)).toBeNull();
  }
  for (const reset of ['broken', new Date(now).toISOString()]) {
    const r = reading();
    r.limits.windows[0]!.resetsAt = reset;
    expect(verifiedRemainingQuota(r, now)).toBeNull();
  }
  const r = reading();
  r.status = 'unavailable';
  expect(verifiedRemainingQuota(r, now)).toBeNull();
  expect(verifiedRemainingQuota(null, now)).toBeNull();
  expect(usageIsFresh('broken', now)).toBe(false);
});
