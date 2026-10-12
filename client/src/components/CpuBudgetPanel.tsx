import { useEffect, useState } from 'react';
import type { CpuBudget, MachineSensors } from '../../../shared/types';
import { api } from '../api';
import { serialPoll } from '../lib/serialPoll';
import { Dropdown } from './Dropdown';
import './cpu-budget.css';

/** Choices: 1, every even count (whole cores with two threads each), and all threads. */
export function budgetChoices(total: number): number[] {
  return Array.from({ length: total }, (_, i) => i + 1).filter(
    (n) => n === 1 || n % 2 === 0 || n === total,
  );
}

function label(n: number, budget: CpuBudget): string {
  if (n === budget.totalThreads) return `All ${n} threads (no limit)`;
  const share = Math.round((n / budget.totalThreads) * 100);
  return `${n} of ${budget.totalThreads} threads (${share}%)${n === budget.defaultThreads ? ' · recommended' : ''}`;
}

/**
 * Settings → CPU budget: how many CPU threads all agent processes may use together, plus
 * below-normal priority. Applies at once to running sessions and runs (server/agents/cpuBudget.ts).
 */
export function CpuBudgetPanel({ onError }: { onError: (message: string) => void }) {
  const [budget, setBudget] = useState<CpuBudget | null>(null);

  useEffect(() => {
    let active = true;
    api.getCpuBudget().then(
      (b) => active && setBudget(b),
      (e: Error) => active && onError(e.message),
    );
    return () => {
      active = false;
    };
  }, [onError]);

  const save = (threads: number) => {
    const before = budget;
    if (before) setBudget({ ...before, threads }); // Optimistic; a failure restores it.
    api.setCpuBudget(threads).then(setBudget, (e: Error) => {
      setBudget(before);
      onError(e.message);
    });
  };

  return (
    <section className="panel" aria-label="CPU budget">
      <div className="panel-header">
        <h2>CPU budget</h2>
        <span className="meta">applies at once to running agents</span>
      </div>
      <p className="faint" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        Agent CLIs and the builds and tests they start share these CPU threads, at below-normal
        priority, so many agents at once can&rsquo;t hold every core, overheat the machine or slow
        your other apps. A lower budget runs cooler; agents take longer.
      </p>
      {budget === null ? (
        <div className="skeleton" style={{ height: 40 }} />
      ) : !budget.supported ? (
        <p className="faint" style={{ margin: 0 }}>
          Not available on this system: macOS offers no way to limit which CPUs a process uses.
        </p>
      ) : (
        <ul className="list">
          <li className="permission-row cpu-budget-row">
            <span className="cpu-budget-label">
              <b>All agents</b>
              <span className="faint">
                up to {budget.threads} of {budget.totalThreads} threads
              </span>
            </span>
            <Dropdown
              label="CPU threads for all agents"
              value={budget.threads}
              options={budgetChoices(budget.totalThreads).map((n) => ({
                value: n,
                label: label(n, budget),
              }))}
              onChange={(threads: number) => save(threads)}
            />
          </li>
        </ul>
      )}
      <SensorTable />
    </section>
  );
}

const SOURCES: Record<NonNullable<MachineSensors['source']>, string> = {
  hwinfo: 'HWiNFO',
  librehardwaremonitor: 'LibreHardwareMonitor',
  hwmon: 'hwmon',
  acpi: 'Windows (ACPI)',
};
/** Under 70 °C cool, under 85 °C warm, then hot: where CPUs start to throttle. */
export function tempLevel(c: number): 'cool' | 'warm' | 'hot' {
  return c < 70 ? 'cool' : c < 85 ? 'warm' : 'hot';
}
const celsius = (c: number) => `${c.toFixed(1)} °C`;
const rpm = (r: number) => `${r.toLocaleString()} RPM`;
type Range = { min: number; max: number };
const widen = (range: Range | undefined, value: number): Range =>
  range
    ? { min: Math.min(range.min, value), max: Math.max(range.max, value) }
    : { min: value, max: value };

/**
 * Live CPU temperature and fan speeds (PM-113), laid out like HWiNFO's sensor window: current
 * value with the minimum and maximum seen since the panel opened. Polls every 2 s while the
 * page is visible; the server reads HWiNFO, LibreHardwareMonitor, hwmon or the ACPI zone.
 */
export function SensorTable() {
  const [reading, setReading] = useState<MachineSensors | null>(null);
  const [failed, setFailed] = useState(false);
  const [ranges, setRanges] = useState<Record<string, Range>>({});

  useEffect(() => {
    let active = true;
    let stop: (() => void) | null = null;
    const poll = () =>
      api.getSensors().then(
        (next) => {
          if (!active) return;
          setFailed(false);
          setReading(next);
          setRanges((prev) => {
            const out = { ...prev };
            if (next.cpuTempC !== null) out.cpu = widen(prev.cpu, next.cpuTempC);
            for (const f of next.fans) out[`fan:${f.label}`] = widen(prev[`fan:${f.label}`], f.rpm);
            return out;
          });
        },
        () => active && setFailed(true),
      );
    // One reading at once, then refreshes only while someone can see it: a hidden tab stops
    // reading the sensors (each read starts a short process on the server).
    const sync = () => {
      if (document.visibilityState === 'visible') stop ??= serialPoll(poll, 2_000);
      else {
        stop?.();
        stop = null;
      }
    };
    if (document.visibilityState !== 'visible') void poll();
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => {
      active = false;
      stop?.();
      document.removeEventListener('visibilitychange', sync);
    };
  }, []);

  const rows: {
    key: string;
    label: string;
    current: string;
    range?: Range;
    fmt: (n: number) => string;
    level?: string;
  }[] = [];
  if (reading?.cpuTempC != null)
    rows.push({
      key: 'cpu',
      label: reading.cpuTempLabel ?? 'CPU',
      current: celsius(reading.cpuTempC),
      range: ranges.cpu,
      fmt: celsius,
      level: tempLevel(reading.cpuTempC),
    });
  for (const f of reading?.fans ?? [])
    rows.push({
      key: `fan:${f.label}`,
      label: f.label,
      current: rpm(f.rpm),
      range: ranges[`fan:${f.label}`],
      fmt: rpm,
    });

  return (
    <div className="cpu-sensors" aria-label="CPU temperature and fans">
      <div className="cpu-sensors-head">
        <span className="cpu-sensors-title">Sensors</span>
        {reading?.source && (
          <span className="faint">
            from {SOURCES[reading.source]}
            {Object.keys(ranges).length > 0 && (
              <>
                {' · '}
                <button type="button" className="link-button" onClick={() => setRanges({})}>
                  Reset min/max
                </button>
              </>
            )}
          </span>
        )}
      </div>
      {reading === null ? (
        failed ? (
          <p className="faint cpu-sensors-note">Couldn&rsquo;t read the sensors.</p>
        ) : (
          <div className="skeleton" style={{ height: 56 }} />
        )
      ) : rows.length ? (
        <table className="cpu-sensors-table">
          <thead>
            <tr>
              <th scope="col">Sensor</th>
              <th scope="col">Current</th>
              <th scope="col">Min</th>
              <th scope="col">Max</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row" title={r.label}>
                  {r.level && <span className={`cpu-temp-dot is-${r.level}`} aria-hidden="true" />}
                  {r.label}
                </th>
                <td className={`num${r.level ? ` cpu-temp is-${r.level}` : ''}`}>{r.current}</td>
                <td className="num faint">{r.range ? r.fmt(r.range.min) : '–'}</td>
                <td className="num faint">{r.range ? r.fmt(r.range.max) : '–'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {reading?.note && <p className="faint cpu-sensors-note">{reading.note}</p>}
    </div>
  );
}
