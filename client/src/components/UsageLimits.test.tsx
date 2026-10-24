// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UsageLimits } from './UsageLimits';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('UsageLimits', () => {
  it('counts seconds from elapsed wall time and does not invent quota after reset', () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-10-24T00:00:00Z');
    vi.setSystemTime(now);
    render(
      <UsageLimits
        now={now}
        limits={{
          providerId: 'codex',
          asOf: new Date(now).toISOString(),
          source: 'test',
          windows: [
            {
              label: '5-hour',
              windowMinutes: 300,
              usedPercent: 100,
              resetsAt: new Date(now + 3000).toISOString(),
            },
          ],
        }}
      />,
    );
    expect(screen.getByText('resets in 3s')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByText('resets in 2s')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByText('reset due · awaiting refresh')).toBeTruthy();
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('100');
  });
  it('shows each window with a meter, percentage and time to reset', () => {
    const now = Date.parse('2026-10-06T13:00:00Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    render(
      <UsageLimits
        now={now}
        limits={{
          providerId: 'codex',
          asOf: '2026-10-06T12:58:00Z',
          source: 'Codex session log',
          windows: [
            {
              label: '5-hour',
              windowMinutes: 300,
              usedPercent: 24,
              resetsAt: '2026-10-06T17:05:00Z',
            },
            {
              label: 'Weekly',
              windowMinutes: 10_080,
              usedPercent: 92,
              resetsAt: null,
              resetSinceReport: true,
            },
          ],
        }}
      />,
    );
    const meters = screen.getAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-valuenow'))).toEqual(['24', '92']);
    expect(meters[1]!.className).toContain('is-high');
    expect(screen.getByText('resets in 4h 5m')).toBeTruthy();
    expect(screen.getByText('reset since')).toBeTruthy();
  });
});
