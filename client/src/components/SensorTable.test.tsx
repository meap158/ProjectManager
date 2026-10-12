// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MachineSensors } from '../../../shared/types';
import { api } from '../api';
import { SensorTable, tempLevel } from './CpuBudgetPanel';

vi.mock('../api', () => ({ api: { getSensors: vi.fn() } }));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const reading = (over: Partial<MachineSensors>): MachineSensors => ({
  source: 'hwinfo',
  cpuTempC: 64.2,
  cpuTempLabel: 'CPU Package',
  fans: [{ label: 'CPU Fan', rpm: 1432 }],
  note: null,
  at: '',
  ...over,
});

describe('SensorTable (PM-113)', () => {
  it('shows current, min and max like HWiNFO, in °C and RPM, coloured by heat', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(api.getSensors)
      .mockResolvedValueOnce(reading({}))
      .mockResolvedValue(reading({ cpuTempC: 78.4, fans: [{ label: 'CPU Fan', rpm: 1810 }] }));
    render(<SensorTable />);
    const row = (name: string) =>
      within(screen.getByRole('rowheader', { name }).closest('tr')!).getAllByRole('cell');
    await waitFor(() => expect(row('CPU Package')[0]!.textContent).toBe('64.2 °C'));
    expect(screen.getByText(/from HWiNFO/)).toBeDefined();
    await vi.advanceTimersByTimeAsync(2_100);
    await waitFor(() => expect(row('CPU Package')[0]!.textContent).toBe('78.4 °C'));
    expect(row('CPU Package').map((c) => c.textContent)).toEqual(['78.4 °C', '64.2 °C', '78.4 °C']);
    expect(row('CPU Package')[0]!.className).toContain('is-warm');
    expect(row('CPU Fan').map((c) => c.textContent)).toEqual([
      '1,810 RPM',
      '1,432 RPM',
      '1,810 RPM',
    ]);
  });

  it("says what the reading is when it isn't the CPU core (ACPI fallback)", async () => {
    vi.mocked(api.getSensors).mockResolvedValue(
      reading({
        source: 'acpi',
        cpuTempC: 27.9,
        cpuTempLabel: 'ACPI thermal zone TZ00',
        fans: [],
        note: 'This is a motherboard thermal zone, not the CPU core.',
      }),
    );
    render(<SensorTable />);
    expect(await screen.findByText(/not the CPU core/)).toBeDefined();
    expect(screen.getByRole('rowheader', { name: 'ACPI thermal zone TZ00' })).toBeDefined();
    expect(screen.getByText(/from Windows \(ACPI\)/)).toBeDefined();
  });

  it('grades temperatures where CPUs warm up and throttle', () => {
    expect([45, 69.9, 70, 84.9, 85, 99].map(tempLevel)).toEqual([
      'cool',
      'cool',
      'warm',
      'warm',
      'hot',
      'hot',
    ]);
  });
});
