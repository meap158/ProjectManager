import { describe, expect, it } from 'vitest';
import { allowanceReset, emptyCodexPrompt } from './continuation.js';

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
