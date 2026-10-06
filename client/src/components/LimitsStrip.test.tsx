// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LimitsStrip } from './LimitsStrip';

vi.mock('../api', () => ({
  api: {
    agentLimits: vi.fn(async () => [
      {
        providerId: 'codex',
        asOf: '2026-10-06T13:00:00Z',
        source: 'Codex session log',
        windows: [
          { label: '5-hour', windowMinutes: 300, usedPercent: 24, resetsAt: null },
          { label: 'Weekly', windowMinutes: 10_080, usedPercent: 82, resetsAt: null },
        ],
      },
    ]),
  },
}));

afterEach(cleanup);

describe('LimitsStrip', () => {
  it('shows plan usage once for each CLI in the list that reports it', async () => {
    render(<LimitsStrip providerIds={['claude', 'codex']} />);
    const meters = await screen.findAllByRole('meter');
    expect(meters.map((m) => m.getAttribute('aria-label'))).toEqual([
      'Codex 5-hour limit used',
      'Codex Weekly limit used',
    ]);
    expect(meters[1]!.className).toContain('is-warn');
  });

  it('stays out of the way when no CLI in the list reports limits', async () => {
    const { container } = render(<LimitsStrip providerIds={['claude']} />);
    await Promise.resolve();
    expect(container.innerHTML).toBe('');
  });
});
