// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PlanUsage } from './PlanUsage';

const NOW = Date.parse('2026-10-06T13:00:00Z');
vi.mock('../api', () => ({
  api: {
    agentLimits: vi.fn(async () => [
      {
        providerId: 'claude',
        asOf: '2026-10-06T12:59:00Z',
        source: 'Claude Code status line',
        windows: [
          {
            label: '5-hour',
            windowMinutes: 300,
            usedPercent: 94,
            resetsAt: '2026-10-06T16:49:00Z',
          },
          {
            label: 'Weekly',
            windowMinutes: 10_080,
            usedPercent: 13,
            resetsAt: '2026-10-12T19:00:00Z',
          },
        ],
      },
      {
        providerId: 'codex',
        asOf: '2026-10-06T12:30:00Z',
        source: 'Codex session log',
        windows: [{ label: '5-hour', windowMinutes: 300, usedPercent: 28, resetsAt: null }],
      },
    ]),
  },
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.useRealTimers();
});

describe('PlanUsage', () => {
  it('lists each CLI with its windows, reset times and bars', async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    render(<PlanUsage />);
    const bars = await screen.findAllByRole('meter');
    expect(bars.map((b) => b.getAttribute('aria-label'))).toEqual([
      'Claude Code 5-hour limit used',
      'Claude Code Weekly limit used',
      'Codex 5-hour limit used',
    ]);
    expect(bars[0]!.className).toContain('is-high');
    expect(screen.getByText('Resets in 3h 49m')).toBeTruthy();
  });

  it('collapses to a one-line summary and remembers it', async () => {
    render(<PlanUsage />);
    fireEvent.click(await screen.findByRole('button', { name: /Plan usage/ }));
    expect(screen.queryAllByRole('meter')).toHaveLength(0);
    expect(screen.getByText('Claude Code 94% · Codex 28%')).toBeTruthy();
    cleanup();
    render(<PlanUsage />);
    expect(await screen.findByText('Claude Code 94% · Codex 28%')).toBeTruthy();
  });
});
