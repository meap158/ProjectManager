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

  it('renders current CPU usage against target settings in CpuBudgetPanel', async () => {
    vi.mocked(api.getCpuBudget).mockResolvedValue({
      supported: true,
      totalThreads: 20,
      threads: 14,
      defaultThreads: 14,
      usagePercent: 25,
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

    const meter = await screen.findByRole('meter', { name: 'CPU usage against target budget' });
    expect(meter.getAttribute('aria-valuenow')).toBe('35');
    expect(screen.getByText('7.0 / 14 threads')).toBeDefined();
    expect(screen.getByText(/35\.0% of CPU · 50% of target/)).toBeDefined();
    expect(screen.getByText(/Target: 14 of 20 threads \(70%\)/)).toBeDefined();
  });
});
