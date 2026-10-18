// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api';
import { budgetChoices, budgetUsageMetrics, CpuBudgetPanel } from './CpuBudgetPanel';

vi.mock('../api', () => ({
  api: {
    getCpuBudget: vi.fn(),
    setCpuBudget: vi.fn(),
    getSensors: vi.fn(),
  },
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe('CPU budget choices and usage metrics', () => {
  it('offers one thread, whole cores and everything', () => {
    expect(budgetChoices(20)).toEqual([1, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20]);
    expect(budgetChoices(5)).toEqual([1, 2, 4, 5]);
    expect(budgetChoices(1)).toEqual([1]);
  });

  it('calculates current usage against target budget and classifies level', () => {
    const cool = budgetUsageMetrics(35, { threads: 14, totalThreads: 20 });
    expect(cool).toEqual({
      clampedPercent: 35,
      targetPercent: 70,
      usedThreads: 7,
      budgetSharePercent: 50,
      level: 'cool',
    });

    const warm = budgetUsageMetrics(60, { threads: 14, totalThreads: 20 });
    expect(warm.level).toBe('warm');
    expect(warm.budgetSharePercent).toBe(86);

    const hot = budgetUsageMetrics(80, { threads: 14, totalThreads: 20 });
    expect(hot.level).toBe('hot');
    expect(hot.usedThreads).toBe(16);
  });

  it('shows the whole machine against the threshold, and what the agents use and may use', async () => {
    vi.mocked(api.getCpuBudget).mockResolvedValue({
      supported: true,
      totalThreads: 20,
      threads: 14,
      defaultThreads: 14,
      usagePercent: 25,
      agentPercent: 14.9,
      allowedThreads: 8,
    });
    vi.mocked(api.getSensors).mockResolvedValue({
      source: 'hwinfo',
      cpuTempC: 58.5,
      cpuTempLabel: 'CPU Package',
      cpuUsagePercent: 35,
      fans: [],
      note: null,
      at: '2026-10-17T12:00:00Z',
    });

    render(<CpuBudgetPanel onError={vi.fn()} />);

    const meter = await screen.findByRole('meter', {
      name: 'Whole machine CPU usage against the threshold',
    });
    // The governor's own machine reading (one sample with the agents' share), not the sensor's.
    expect(meter.getAttribute('aria-valuenow')).toBe('25');
    expect(screen.getByText('25.0%')).toBeDefined();
    expect(screen.getByText(/5\.0 of 20 threads busy/)).toBeDefined();
    expect(screen.getByText(/Threshold: 14 of 20 threads \(70%\)/)).toBeDefined();
    const agents = screen.getByText(/^Agents:/);
    expect(agents.textContent).toContain('14.9% (3.0 threads)');
    expect(agents.textContent).toContain('may use 8 of 14 threads now');
    expect(agents.textContent).toContain('narrowed so the whole machine stays under the threshold');
  });

  it('uses the live sensor reading when the governor is not running', async () => {
    vi.mocked(api.getCpuBudget).mockResolvedValue({
      supported: true,
      totalThreads: 20,
      threads: 14,
      defaultThreads: 14,
      usagePercent: 25,
      agentPercent: null,
      allowedThreads: null,
    });
    vi.mocked(api.getSensors).mockResolvedValue({
      source: 'hwinfo',
      cpuTempC: 58.5,
      cpuTempLabel: 'CPU Package',
      cpuUsagePercent: 35,
      fans: [],
      note: null,
      at: '2026-10-17T12:00:00Z',
    });
    render(<CpuBudgetPanel onError={vi.fn()} />);
    expect(await screen.findByText('35.0%')).toBeDefined();
    expect(screen.queryByText(/^Agents:/)).toBeNull();
  });
});
