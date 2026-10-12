import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { fromHwinfo, fromHwmon, fromLhm, fromThermalZones } from './sensors.js';

describe('machine sensors (PM-113)', () => {
  it('reads HWiNFO gadget values: CPU package temperature and the CPU fan first', () => {
    const reading = fromHwinfo([
      { sensor: 'GPU [#0]', label: 'GPU Temperature', value: '51 °C', raw: '51' },
      { sensor: 'CPU [#0]', label: 'CPU Package', value: '68 °C', raw: '68.25' },
      { sensor: 'CPU [#0]', label: 'Core Max', value: '72 °C', raw: '72' },
      { sensor: 'Nuvoton', label: 'Chassis1', value: '812 RPM', raw: '812' },
      { sensor: 'Nuvoton', label: 'CPU Fan', value: '1,432 RPM', raw: '1432' },
      { sensor: 'CPU [#0]', label: 'CPU Package Power', value: '88 W', raw: '88' },
    ]);
    expect(reading).toMatchObject({
      source: 'hwinfo',
      cpuTempC: 68.3,
      cpuTempLabel: 'CPU Package',
      fans: [
        { label: 'CPU Fan', rpm: 1432 },
        { label: 'Chassis1', rpm: 812 },
      ],
      note: null,
    });
    expect(fromHwinfo([])).toBeNull();
  });

  it('reads LibreHardwareMonitor CPU temperatures (not the motherboard or GPU) and fans', () => {
    const reading = fromLhm([
      { type: 'Temperature', name: 'Motherboard', parent: '/lpc/nct6798d/0', value: 40 },
      { type: 'Temperature', name: 'Core (Tctl/Tdie)', parent: '/amdcpu/0', value: 61.5 },
      { type: 'Temperature', name: 'CCD1 (Tdie)', parent: '/amdcpu/0', value: 58 },
      { type: 'Fan', name: 'Fan #2', parent: '/lpc/nct6798d/0', value: 1210.4 },
    ]);
    expect(reading).toMatchObject({
      source: 'librehardwaremonitor',
      cpuTempC: 61.5,
      cpuTempLabel: 'Core (Tctl/Tdie)',
      fans: [{ label: 'Fan #2', rpm: 1210 }],
    });
  });

  it('falls back to the ACPI thermal zone, labelled as not the CPU core', () => {
    const reading = fromThermalZones([{ name: '\\_TZ.TZ00', tenthsKelvin: 3010 }]);
    expect(reading).toMatchObject({
      source: 'acpi',
      cpuTempC: 27.9,
      cpuTempLabel: 'ACPI thermal zone TZ00',
      fans: [],
    });
    expect(reading!.note).toMatch(/not the CPU core.*HWiNFO/);
    expect(fromThermalZones([{ name: 'x', tenthsKelvin: 0 }])).toBeNull();
  });

  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-hwmon-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  it('reads Linux hwmon: the CPU driver temperature and spinning fans', async () => {
    const write = (dir: string, files: Record<string, string>) => {
      mkdirSync(path.join(root, dir), { recursive: true });
      for (const [name, text] of Object.entries(files))
        writeFileSync(path.join(root, dir, name), `${text}\n`);
    };
    write('hwmon0', { name: 'nvme', temp1_input: '45000' }); // Not a CPU sensor.
    write('hwmon1', {
      name: 'coretemp',
      temp1_input: '64000',
      temp1_label: 'Package id 0',
      temp2_input: '61000',
      temp2_label: 'Core 0',
    });
    write('hwmon2', { name: 'nct6775', fan1_input: '980', fan2_input: '0', fan2_label: 'Off' });
    expect(await fromHwmon(root)).toMatchObject({
      source: 'hwmon',
      cpuTempC: 64,
      cpuTempLabel: 'Package id 0',
      fans: [{ label: 'Fan 1', rpm: 980 }],
    });
    expect(await fromHwmon(path.join(root, 'missing'))).toBeNull();
  });
});
