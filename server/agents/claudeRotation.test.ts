import { describe, expect, it } from 'vitest';
import type { CodexAccountsState } from '../../shared/types.js';
import { claudeLimitOnScreen, nextClaudeAccount, readingExhausted } from './claudeRotation.js';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const later = new Date(NOW + 3_600_000).toISOString();
const earlier = new Date(NOW - 3_600_000).toISOString();

const limits = (five: number, week = 10, resetsAt: string | null = later) => ({
  providerId: 'claude' as const,
  source: 'test',
  asOf: new Date(NOW).toISOString(),
  windows: [
    { label: '5-hour', windowMinutes: 300, usedPercent: five, resetsAt },
    { label: 'Weekly', windowMinutes: 10_080, usedPercent: week, resetsAt: later },
  ],
});

const account = (id: string, lim: ReturnType<typeof limits> | null) =>
  ({ id, name: `Account ${id}`, createdAt: '', limits: lim }) as never;

const state = (
  current: ReturnType<typeof limits> | null,
  saved: [string, ReturnType<typeof limits> | null][],
  activeProfileId: string | null = null,
): CodexAccountsState =>
  ({
    accounts: saved.map(([id, lim]) => account(id, lim)),
    activeProfileId,
    autoSwitch: true,
    defaultAccount: { available: true, limits: current },
  }) as never;

describe('Claude account rotation', () => {
  it('recognises the CLI limit messages', () => {
    expect(claudeLimitOnScreen('Claude usage limit reached. Your limit will reset at 3pm')).toBe(
      true,
    );
    expect(claudeLimitOnScreen('5-hour limit reached ∙ resets 3pm')).toBe(true);
    expect(claudeLimitOnScreen("You've hit your weekly limit")).toBe(true);
    expect(claudeLimitOnScreen('All good, 44% of the 5-hour window used')).toBe(false);
  });

  it('treats 99% used as exhausted and a reset window as unused', () => {
    expect(readingExhausted(limits(99.5), NOW)).toBe(true);
    expect(readingExhausted(limits(60), NOW)).toBe(false);
    expect(readingExhausted(limits(100, 10, earlier), NOW)).toBe(false);
    expect(readingExhausted(null, NOW)).toBeNull();
  });

  it('stays put while the current login has quota and no limit message shows', () => {
    expect(nextClaudeAccount(state(limits(60), [['a', limits(10)]]), [], false, NOW)).toBeNull();
  });

  it('switches on an exhausted reading, to the saved login with the most 5-hour quota', () => {
    const s = state(limits(100), [
      ['a', limits(70)],
      ['b', limits(20)],
      ['c', limits(100)],
    ]);
    expect(nextClaudeAccount(s, [], false, NOW)?.id).toBe('b');
  });

  it('uses the limit message when the meter lags or was never read, but not when it is clear', () => {
    const lagging = state(limits(97), [['a', limits(10)]]);
    expect(nextClaudeAccount(lagging, [], false, NOW)).toBeNull();
    expect(nextClaudeAccount(lagging, [], true, NOW)?.id).toBe('a');
    expect(nextClaudeAccount(state(null, [['a', limits(10)]]), [], true, NOW)?.id).toBe('a');
    expect(nextClaudeAccount(state(limits(40), [['a', limits(10)]]), [], true, NOW)).toBeNull();
  });

  it('skips tried logins, exhausted ones and ranks a never-read login last', () => {
    const s = state(limits(100), [
      ['tried', limits(5)],
      ['out', limits(100)],
      ['unknown', null],
      ['known', limits(90)],
    ]);
    expect(nextClaudeAccount(s, ['tried'], false, NOW)?.id).toBe('known');
    expect(nextClaudeAccount(s, ['tried', 'known'], false, NOW)?.id).toBe('unknown');
    expect(nextClaudeAccount(s, ['tried', 'known', 'unknown'], false, NOW)).toBeNull();
  });

  it('can return to the default login when a saved one is active', () => {
    const s = state(limits(10), [['a', limits(100)]], 'a');
    expect(nextClaudeAccount(s, [], false, NOW)?.id).toBe('default');
  });
});
