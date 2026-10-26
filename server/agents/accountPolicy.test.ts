import { describe, expect, it } from 'vitest';
import {
  bySwitchQuota,
  switchForecast,
  switchQuota,
  usageIsFresh,
  verifiedRemainingQuota,
} from './accountPolicy.js';
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

it('orders eligible candidates by 5-hour quota, then weekly, then stable saved order', () => {
  const quota = (fiveHour: number, weekly: number) => {
    const r = reading();
    r.limits.windows[0]!.usedPercent = 100 - fiveHour;
    r.limits.windows[1]!.usedPercent = 100 - weekly;
    return switchQuota(r, now);
  };
  // Both windows must have quota, but preference follows the owner's 5-hour-first rule.
  expect(quota(90, 10)).toEqual({ usable: 10, fiveHour: 90, weekly: 10 });
  expect(bySwitchQuota(quota(90, 10)!, quota(70, 80)!)).toBeLessThan(0);
  // Same 5-hour quota: more weekly left wins.
  expect(bySwitchQuota(quota(40, 90)!, quota(40, 60)!)).toBeLessThan(0);
  // Readings that show the same percents tie, leaving the saved list order.
  expect(bySwitchQuota(quota(40.2, 70.4)!, quota(39.8, 69.6)!)).toBe(0);
  // Any exhausted window, or an unverified reading, is never a candidate.
  expect(quota(100, 0)).toBeNull();
  expect(quota(0, 100)).toBeNull();
  expect(switchQuota(null, now)).toBeNull();
  const weeklyOnly = reading();
  weeklyOnly.limits.windows.shift();
  expect(switchQuota(weeklyOnly, now)).toEqual({ usable: 25, fiveHour: 25, weekly: 25 });
});

describe('switchForecast (what auto-switch does next)', () => {
  const now = Date.parse('2026-10-27T17:00:00Z');
  const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
  const limits = (
    fiveHourUsed: number,
    fiveHourReset: number,
    weeklyUsed = 30,
    weeklyReset = 3000,
  ) => ({
    providerId: 'codex',
    asOf: new Date(now).toISOString(),
    source: 'test',
    windows: [
      {
        label: '5-hour',
        windowMinutes: 300,
        usedPercent: fiveHourUsed,
        resetsAt: at(fiveHourReset),
      },
      { label: 'Weekly', windowMinutes: 10080, usedPercent: weeklyUsed, resetsAt: at(weeklyReset) },
    ],
  });

  it('says nothing while the account in use has plenty left', () => {
    expect(switchForecast({ name: 'me', limits: limits(40, 100) }, [], true, now)).toBeNull();
  });

  it('names the next account by 5-hour, then weekly quota left', () => {
    const f = switchForecast(
      { name: 'me', limits: limits(100, 230) },
      [
        { name: 'a', limits: limits(60, 100) },
        { name: 'b', limits: limits(20, 100, 50) },
        { name: 'c', limits: limits(20, 100, 10) },
      ],
      true,
      now,
    );
    expect(f).toEqual({
      kind: 'next',
      name: 'c',
      left: 80,
      fiveHour: 80,
      weekly: 90,
      atLimit: true,
    });
  });

  it('when none has quota, names whichever comes back first, a spent weekly counted', () => {
    const f = switchForecast(
      { name: 'me', limits: limits(100, 230) },
      [
        { name: 'soon', limits: limits(100, 3) },
        { name: 'weekly-spent', limits: limits(100, 1, 100, 900) },
      ],
      true,
      now,
    );
    expect(f).toEqual({ kind: 'wait', name: 'soon', at: at(3), current: false });
    // The account in use wins a tie: staying put is no switch at all.
    expect(
      switchForecast(
        { name: 'me', limits: limits(100, 3) },
        [{ name: 'x', limits: limits(100, 3) }],
        true,
        now,
      ),
    ).toMatchObject({ kind: 'wait', current: true });
  });

  it('says so when switching is off, and ignores accounts without readings', () => {
    expect(switchForecast({ name: 'me', limits: limits(100, 10) }, [], false, now)).toEqual({
      kind: 'off',
    });
    expect(
      switchForecast(
        { name: 'me', limits: limits(95, 10) },
        [{ name: 'n', limits: null }],
        true,
        now,
      ),
    ).toBeNull();
  });
});
