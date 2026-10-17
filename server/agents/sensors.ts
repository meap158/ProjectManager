// CPU temperature and fan speeds for Settings → CPU budget (PM-113), read without native modules.
//
// Windows only exposes real CPU core temperature and fan RPM through a kernel driver, which is
// what HWiNFO and LibreHardwareMonitor install. So the best available source wins:
//  1. HWiNFO's "Report value in Gadget" export (HKCU\Software\HWiNFO64\VSB: LabelN / ValueN /
//     ValueRawN per reported sensor),
//  2. LibreHardwareMonitor's (or OpenHardwareMonitor's) WMI namespace,
//  3. Linux hwmon (/sys/class/hwmon: coretemp, k10temp, zenpower; fan*_input),
//  4. the ACPI thermal zone Windows reports without admin rights: a motherboard zone, not the
//     CPU core, so its label names it as such.
// Readings are cached briefly: the panel polls while open, and one PowerShell start per poll
// would cost more than the reading.

import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { MachineSensors, SensorFan } from '../../shared/types.js';
import { sampleCpuUsage } from './cpuBudget.js';

const CACHE_MS = 2_500;
const MAX_FANS = 8;

export interface HwinfoEntry {
  sensor?: string | null;
  label: string;
  value?: string | null;
  raw?: string | number | null;
}
export interface LhmSensor {
  type: string; // Temperature | Fan
  name: string;
  parent?: string | null; // e.g. /amdcpu/0, /lpc/nct6798d/0
  value: number | null;
}

const number = (v: unknown): number | null => {
  const n =
    typeof v === 'number'
      ? v
      : Number(
          String(v ?? '')
            .replace(/,/g, '')
            .trim(),
        );
  return Number.isFinite(n) ? n : null;
};
const plausibleTemp = (c: number | null): c is number => c !== null && c > 0 && c < 125;
const plausibleRpm = (r: number | null): r is number => r !== null && r >= 0 && r < 20_000;

/** The CPU's overall temperature first (package / Tctl / Tdie / hottest core), then any CPU one. */
const CPU_TEMP_PREFERENCE = [
  /cpu\s*package|package\s*(temp|id)/i,
  /tctl|tdie/i,
  /core\s*max|cpu\s*\(tctl/i,
  /^cpu$|cpu\s*(temp|die|ccd)/i,
];

function pickCpuTemp(
  candidates: { label: string; c: number }[],
): { label: string; c: number } | null {
  for (const pattern of CPU_TEMP_PREFERENCE) {
    const hit = candidates.find((t) => pattern.test(t.label));
    if (hit) return hit;
  }
  return null;
}

/** HWiNFO gadget entries: units come with the formatted value ("45 °C", "1,234 RPM"). */
export function fromHwinfo(entries: HwinfoEntry[]): Omit<MachineSensors, 'at'> | null {
  if (!entries.length) return null;
  const temps: { label: string; c: number }[] = [];
  const fans: SensorFan[] = [];
  for (const e of entries) {
    const unit = String(e.value ?? '');
    const value = number(e.raw) ?? number(unit.replace(/[^\d.,-]/g, ''));
    if (/°\s*C|℃/.test(unit) && plausibleTemp(value)) {
      const where = e.sensor && !/cpu/i.test(e.label) ? `${e.sensor}: ` : '';
      temps.push({ label: `${where}${e.label}`, c: value });
    } else if (/rpm/i.test(unit) && plausibleRpm(value)) {
      // An RPM reading is a fan or pump, whatever its label ("Chassis1", "CPU", "AIO Pump").
      fans.push({ label: e.label, rpm: Math.round(value) });
    }
  }
  const cpu = pickCpuTemp(temps);
  if (!cpu && !fans.length) return null;
  return {
    source: 'hwinfo',
    cpuTempC: cpu ? round1(cpu.c) : null,
    cpuTempLabel: cpu?.label ?? null,
    fans: cpuFansFirst(fans),
    note: null,
  };
}

/** LibreHardwareMonitor / OpenHardwareMonitor WMI sensors. */
export function fromLhm(sensors: LhmSensor[]): Omit<MachineSensors, 'at'> | null {
  if (!sensors.length) return null;
  const isCpu = (s: LhmSensor) => /cpu/i.test(s.parent ?? '');
  const temps = sensors
    .filter((s) => s.type === 'Temperature' && isCpu(s) && plausibleTemp(s.value))
    .map((s) => ({ label: s.name, c: s.value! }));
  const cpu =
    pickCpuTemp(temps) ?? (temps.length ? temps.reduce((a, b) => (b.c > a.c ? b : a)) : null);
  const fans = sensors
    .filter((s) => s.type === 'Fan' && plausibleRpm(s.value))
    .map((s) => ({ label: s.name, rpm: Math.round(s.value!) }));
  if (!cpu && !fans.length) return null;
  return {
    source: 'librehardwaremonitor',
    cpuTempC: cpu ? round1(cpu.c) : null,
    cpuTempLabel: cpu?.label ?? null,
    fans: cpuFansFirst(fans),
    note: null,
  };
}

/** Windows thermal zones (tenths of a kelvin): the hottest, labelled as what it is. */
export function fromThermalZones(
  zones: { name: string; tenthsKelvin: number | null }[],
): Omit<MachineSensors, 'at'> | null {
  const temps = zones
    .map((z) => ({
      label: z.name,
      c: z.tenthsKelvin === null ? null : z.tenthsKelvin / 10 - 273.15,
    }))
    .filter((z): z is { label: string; c: number } => plausibleTemp(z.c));
  if (!temps.length) return null;
  const hottest = temps.reduce((a, b) => (b.c > a.c ? b : a));
  return {
    source: 'acpi',
    cpuTempC: round1(hottest.c),
    cpuTempLabel: `ACPI thermal zone ${hottest.label.replace(/^\\_TZ\./, '')}`,
    fans: [],
    note: null,
  };
}

/** Linux hwmon: CPU drivers' temperatures and every fan input. */
export async function fromHwmon(
  root = '/sys/class/hwmon',
): Promise<Omit<MachineSensors, 'at'> | null> {
  let dirs: string[];
  try {
    dirs = await readdir(root);
  } catch {
    return null;
  }
  const text = (file: string) =>
    readFile(file, 'utf8').then(
      (s) => s.trim(),
      () => null,
    );
  const temps: { label: string; c: number }[] = [];
  const fans: SensorFan[] = [];
  for (const dir of dirs) {
    const base = path.join(root, dir);
    const driver = (await text(path.join(base, 'name'))) ?? dir;
    const files = await readdir(base).catch(() => [] as string[]);
    for (const file of files) {
      const temp = /^temp(\d+)_input$/.exec(file);
      const fan = /^fan(\d+)_input$/.exec(file);
      if (temp && /coretemp|k10temp|zenpower|cpu_thermal|x86_pkg_temp/.test(driver)) {
        const milli = number(await text(path.join(base, file)));
        const label =
          (await text(path.join(base, `temp${temp[1]}_label`))) ?? `${driver} ${temp[1]}`;
        if (milli !== null && plausibleTemp(milli / 1000))
          temps.push({
            label: /k10temp|zenpower/.test(driver) && !label ? 'Tctl' : label,
            c: milli / 1000,
          });
      } else if (fan) {
        const rpm = number(await text(path.join(base, file)));
        const label = (await text(path.join(base, `fan${fan[1]}_label`))) ?? `Fan ${fan[1]}`;
        if (plausibleRpm(rpm) && rpm! > 0) fans.push({ label, rpm: Math.round(rpm!) });
      }
    }
  }
  const cpu =
    pickCpuTemp(temps) ?? (temps.length ? temps.reduce((a, b) => (b.c > a.c ? b : a)) : null);
  if (!cpu && !fans.length) return null;
  return {
    source: 'hwmon',
    cpuTempC: cpu ? round1(cpu.c) : null,
    cpuTempLabel: cpu?.label ?? null,
    fans: cpuFansFirst(fans),
    note: null,
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** The CPU fan (and pump) first, then the others; at most a handful. */
function cpuFansFirst(fans: SensorFan[]): SensorFan[] {
  const rank = (f: SensorFan) => (/cpu|pump|aio/i.test(f.label) ? 0 : 1);
  return [...fans].sort((a, b) => rank(a) - rank(b)).slice(0, MAX_FANS);
}

// One PowerShell run collects every Windows source (a constant script: no user data in it).
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'SilentlyContinue'
$o = @{ hwinfo = @(); lhm = @(); zones = @() }
$k = Get-ItemProperty 'HKCU:\\Software\\HWiNFO64\\VSB'
if ($k) { for ($i = 0; $i -lt 1000; $i++) { $l = $k."Label$i"; if ($null -eq $l) { break }
  $o.hwinfo += @{ sensor = $k."Sensor$i"; label = $l; value = $k."Value$i"; raw = $k."ValueRaw$i" } } }
foreach ($ns in 'root/LibreHardwareMonitor', 'root/OpenHardwareMonitor') {
  $s = Get-CimInstance -Namespace $ns -ClassName Sensor
  if ($s) { $o.lhm = @($s | Where-Object { $_.SensorType -in 'Temperature', 'Fan' } | ForEach-Object {
    @{ type = $_.SensorType; name = $_.Name; parent = $_.Parent; value = $_.Value } }); break } }
$o.zones = @(Get-CimInstance Win32_PerfFormattedData_Counters_ThermalZoneInformation | ForEach-Object {
  @{ name = $_.Name; tenthsKelvin = $_.HighPrecisionTemperature } })
$o | ConvertTo-Json -Depth 4 -Compress
`;

function runPowerShell(): Promise<{
  hwinfo?: HwinfoEntry[];
  lhm?: LhmSensor[];
  zones?: { name: string; tenthsKelvin: number | null }[];
}> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
      { windowsHide: true, timeout: 8_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return resolve({});
        try {
          resolve(JSON.parse(stdout) as never);
        } catch {
          resolve({});
        }
      },
    );
  });
}

async function measure(): Promise<MachineSensors> {
  const at = new Date().toISOString();
  const cpuUsagePercent = sampleCpuUsage();
  if (process.platform === 'win32') {
    const raw = await runPowerShell();
    const reading =
      fromHwinfo(raw.hwinfo ?? []) ?? fromLhm(raw.lhm ?? []) ?? fromThermalZones(raw.zones ?? []);
    if (reading) return { ...reading, cpuUsagePercent, at };
    return {
      source: null,
      cpuTempC: null,
      cpuTempLabel: null,
      cpuUsagePercent,
      fans: [],
      note: 'No sensors available.',
      at,
    };
  }
  if (process.platform === 'linux') {
    const reading = await fromHwmon();
    if (reading) return { ...reading, cpuUsagePercent, at };
    return {
      source: null,
      cpuTempC: null,
      cpuTempLabel: null,
      cpuUsagePercent,
      fans: [],
      note: 'No sensors available.',
      at,
    };
  }
  return {
    source: null,
    cpuTempC: null,
    cpuTempLabel: null,
    cpuUsagePercent,
    fans: [],
    note: 'No sensors available.',
    at,
  };
}

let cache: { at: number; value: Promise<MachineSensors> } | null = null;

/** The current reading, shared by concurrent callers and cached for a couple of seconds. */
export function readSensors(now = Date.now()): Promise<MachineSensors> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const value = measure();
  cache = { at: now, value };
  return value;
}
