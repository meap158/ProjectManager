import { describe, expect, it } from 'vitest';
import type { NativeAccount, NativeAccountsState } from '../../shared/nativeAccounts.js';
import {
  GROK_SKIP_WITHOUT_RESET_MS,
  grokCurrentExhausted,
  grokLimitOnScreen,
  grokSkipUntil,
  nextGrokAccount,
} from './grokRotation.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();
const reset = iso(NOW + 3 * 24 * 3_600_000);

function account(
  id: string,
  used: number | null,
  {
    status = used === null ? 'expired' : 'fresh',
    asOf = iso(NOW - 10_000),
    resetsAt = reset as string | null,
  }: { status?: NativeAccount['usageStatus']; asOf?: string; resetsAt?: string | null } = {},
): NativeAccount {
  return {
    id,
    name: `Account ${id}`,
    email: `${id}@example.com`,
    active: false,
    plan: null,
    usage: { fiveHour: null, weekly: used, updatedAt: used === null ? null : asOf },
    usageStatus: status,
    limits:
      used === null
        ? null
        : {
            providerId: 'grok',
            source: 'Grok billing service',
            asOf,
            windows: [{ label: 'Weekly', windowMinutes: 10_080, usedPercent: used, resetsAt }],
          },
  };
}

const state = (current: NativeAccount | null, saved: NativeAccount[]): NativeAccountsState => ({
  available: true,
  accounts: current ? [{ ...current, active: true }, ...saved] : saved,
  defaultAccount: current ? { ...current, active: true } : null,
});

describe('Grok limit message', () => {
  it('matches the dialog Grok Build draws when credits run out', () => {
    // As recorded in a real session log: the message sits in a box above a credits choice.
    const screen =
      '\x1b[38;2;200;200;200m┃  You hit your weekly limit.                       ┃\r\n' +
      '\x1b[38;2;108;108;108m(○) Buy more credits  Purchase credits to keep using Grok Build';
    expect(grokLimitOnScreen(screen)).toBe(true);
    expect(grokLimitOnScreen('You hit your free usage limit.')).toBe(true);
    expect(grokLimitOnScreen('out of credits or over your spending limit. Add credits')).toBe(true);
  });

  it('ignores rate limits, which clear by waiting, and old text far up the screen', () => {
    expect(grokLimitOnScreen("You've hit the rate limit for your plan. Rate limited")).toBe(false);
    expect(grokLimitOnScreen('The service is busy. Wait a minute and send again.')).toBe(false);
    expect(grokLimitOnScreen('You hit your weekly limit.' + ' '.repeat(4000))).toBe(false);
  });
});

describe('Grok account rotation', () => {
  it('switches only on a fresh reading of the login in use at 99% or more', () => {
    const saved = [account('b', 20)];
    expect(nextGrokAccount(state(account('a', 99), saved), new Map(), NOW)?.id).toBe('b');
    expect(nextGrokAccount(state(account('a', 98), saved), new Map(), NOW)).toBeNull();
    // Stale (over a minute), failed, or reset since the reading: never authorizes a switch.
    const stale = account('a', 100, { asOf: iso(NOW - 61_000) });
    expect(nextGrokAccount(state(stale, saved), new Map(), NOW)).toBeNull();
    const failed = account('a', 100, { status: 'unavailable' });
    expect(nextGrokAccount(state(failed, saved), new Map(), NOW)).toBeNull();
    const resetDue = account('a', 100, { resetsAt: iso(NOW - 1000) });
    expect(nextGrokAccount(state(resetDue, saved), new Map(), NOW)).toBeNull();
    expect(nextGrokAccount(state(null, saved), new Map(), NOW)).toBeNull();
  });

  it('prefers the least used readable login, then saved order, and tries unknown ones last', () => {
    const current = account('a', 100);
    const pick = (saved: NativeAccount[]) =>
      nextGrokAccount(state(current, saved), new Map(), NOW)?.id;
    expect(pick([account('b', 60), account('c', 10), account('d', 10)])).toBe('c');
    expect(pick([account('u', null, { status: 'not_loaded' }), account('b', 90)])).toBe('b');
    expect(pick([account('u', null, { status: 'not_loaded' }), account('b', 99)])).toBe('u');
    expect(pick([{ ...account('expired', null), renewable: true }])).toBeUndefined();
    // A login that failed to read (or to decrypt) is never a candidate.
    expect(pick([account('x', 10, { status: 'unavailable' })])).toBeUndefined();
  });

  it('never picks a login the owner left out of automatic switching (PM-531)', () => {
    const current = account('a', 100);
    const out = { ...account('c', 5), autoSwitchEligible: false };
    expect(nextGrokAccount(state(current, [out, account('b', 60)]), new Map(), NOW)?.id).toBe('b');
    expect(nextGrokAccount(state(current, [out]), new Map(), NOW)).toBeNull();
  });

  it('skips logins it left until their skip time has passed', () => {
    const s = state(account('a', 100), [account('b', 10), account('c', 50)]);
    expect(nextGrokAccount(s, new Map([['b', NOW + 1]]), NOW)?.id).toBe('c');
    expect(nextGrokAccount(s, new Map([['b', NOW]]), NOW)?.id).toBe('b');
    expect(
      nextGrokAccount(
        s,
        new Map([
          ['b', NOW + 1],
          ['c', NOW + 1],
        ]),
        NOW,
      ),
    ).toBeNull();
  });

  it('skips a left login until its own reset, or a day when the reset is unknown', () => {
    expect(grokSkipUntil(account('a', 100), NOW)).toBe(Date.parse(reset));
    expect(grokSkipUntil(account('a', 100, { resetsAt: null }), NOW)).toBe(
      NOW + GROK_SKIP_WITHOUT_RESET_MS,
    );
    expect(grokSkipUntil(null, NOW)).toBe(NOW + GROK_SKIP_WITHOUT_RESET_MS);
  });

  it('reports verified exhaustion of the login in use', () => {
    expect(grokCurrentExhausted(state(account('a', 100), []), NOW)).toBe(true);
    expect(grokCurrentExhausted(state(account('a', 50), []), NOW)).toBe(false);
  });
});
