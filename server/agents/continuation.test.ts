import { describe, expect, it } from 'vitest';
import { allowanceReset, emptyCodexPrompt, usageLimitShown } from './continuation.js';

describe('allowance continuation', () => {
  const windows = [
    { label: '5-hour', windowMinutes: 300, usedPercent: 100, resetsAt: '2026-10-10T12:00:00Z' },
  ];
  const now = Date.parse('2026-10-10T11:00:00Z');
  it('requires a real limit error and waits for all exhausted windows', () => {
    expect(allowanceReset('99% used', windows, now)).toBeNull();
    expect(
      allowanceReset("You've hit your usage limit", [{ ...windows[0]!, usedPercent: 99 }], now),
    ).toBe('2026-10-10T12:00:30.000Z');
    expect(
      allowanceReset(
        "You've hit your usage limit",
        [...windows, { ...windows[0]!, resetsAt: '2026-10-11T12:00:00Z' }],
        now,
      ),
    ).toBe('2026-10-11T12:00:30.000Z');
    expect(
      allowanceReset("You've hit your usage limit", [{ ...windows[0]!, resetsAt: null }], now),
    ).toBeNull();
  });
  it('rejects stale errors, expired resets, and invalid timestamps', () => {
    expect(
      allowanceReset("You've hit your usage limit" + 'x'.repeat(2100), windows, now),
    ).toBeNull();
    expect(allowanceReset("You've hit your usage limit", windows, now + 86400000)).toBeNull();
    expect(
      allowanceReset("You've hit your usage limit", [{ ...windows[0]!, resetsAt: 'unknown' }], now),
    ).toBeNull();
  });
  it('never submits over a typed draft even when an old empty prompt exists', () => {
    expect(emptyCodexPrompt('› Ask Codex to do anything\nstatus')).toBe(true);
    expect(emptyCodexPrompt('› Ask Codex to do anything\n› my unfinished draft\nstatus')).toBe(
      false,
    );
    expect(emptyCodexPrompt('permission required')).toBe(false);
  });
});

describe('usage limit notice (PM-58)', () => {
  const windows = [
    { label: '5-hour', windowMinutes: 300, usedPercent: 100, resetsAt: '2026-10-10T12:00:00Z' },
    { label: 'Weekly', windowMinutes: 10080, usedPercent: 40, resetsAt: '2026-10-15T00:00:00Z' },
  ];
  const now = Date.parse('2026-10-10T11:00:00Z');
  const screen = '■ You’ve hit your usage limit. Upgrade to Pro…';
  it('shows while the screen shows the limit, with when the exhausted window resets', () => {
    expect(usageLimitShown(screen, windows, now)).toEqual({ resetsAt: '2026-10-10T12:00:00.000Z' });
    expect(usageLimitShown('› Ask Codex to do anything', windows, now)).toBeUndefined();
  });
  it('has an unknown reset without usage numbers, and ends once the reset passes', () => {
    expect(usageLimitShown(screen, [], now)).toEqual({ resetsAt: null });
    expect(usageLimitShown(screen, windows, Date.parse('2026-10-10T12:01:00Z'))).toBeUndefined();
  });
});

describe('a /goal footer after the limit message scrolled away', () => {
  const footer =
    '› Ask Codex to do anything\n  GPT-6.1-Sol low · S:\\TiemNet   Goal hit usage limits (/goal resume)';
  const exhausted = [
    {
      label: '5-hour',
      windowMinutes: 300,
      usedPercent: 100,
      resetsAt: new Date(Date.now() + 3600_000).toISOString(),
    },
  ] as never;
  it('counts as the limit while the login is exhausted', () => {
    expect(usageLimitShown(footer, exhausted, Date.now())).toBeDefined();
  });
  it('does not once the login has quota again', () => {
    expect(usageLimitShown(footer, [], Date.now())).toBeUndefined();
  });
});
