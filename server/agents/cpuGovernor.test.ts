import { describe, expect, it } from 'vitest';
import { nextAllowed, parseStats } from './cpuGovernor.js';

describe('CPU governor (keeps the machine under the threshold)', () => {
  const budget = { threads: 14, total: 20 }; // Threshold: 70% of the machine.

  it('narrows agents at once when other load would take the machine past the threshold', () => {
    // 42.7% busy, agents 14.9%: others hold ~5.6 threads, so agents get 8 (8 + 5.6 ≤ 14).
    expect(nextAllowed(14, budget, 42.7, 14.9)).toBe(8);
    // The user's own apps take the whole machine: agents keep one thread.
    expect(nextAllowed(14, budget, 100, 0)).toBe(1);
  });

  it('never exceeds the budget, and widens one thread at a time with room to spare', () => {
    expect(nextAllowed(14, budget, 5, 5)).toBe(14);
    expect(nextAllowed(8, budget, 10, 9)).toBe(9);
    // Others hold 0.6 of a thread: 13 fit, but not with half a thread to spare, so it holds
    // at 12 rather than re-masking every agent each time small load comes and goes.
    expect(nextAllowed(12, budget, 3, 0)).toBe(12);
    expect(nextAllowed(13, budget, 3, 0)).toBe(13);
  });

  it('reads its measurements', () => {
    expect(parseStats('stats 14.9 42.7 8 255', 1)).toEqual({
      agentPercent: 14.9,
      machinePercent: 42.7,
      allowedThreads: 8,
      processes: 255,
      at: 1,
    });
    expect(parseStats('Add-Type : error')).toBeNull();
  });
});
