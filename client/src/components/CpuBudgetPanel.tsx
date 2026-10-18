import { useCallback, useEffect, useRef, useState } from 'react';
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

export interface BudgetUsageMetrics {
  clampedPercent: number;
  targetPercent: number;
  usedThreads: number;
  budgetSharePercent: number;
  level: 'cool' | 'warm' | 'hot';
}

/** The whole machine's CPU usage against the budget's threshold. */
export function budgetUsageMetrics(
  usagePercent: number,
  budget: Pick<CpuBudget, 'threads' | 'totalThreads'>,
): BudgetUsageMetrics {
  const total = Math.max(1, budget.totalThreads);
  const threads = Math.min(Math.max(1, budget.threads), total);
  const clampedPercent = Math.max(0, Math.min(100, Math.round(usagePercent * 10) / 10));
  const targetPercent = Math.round((threads / total) * 100);
  const usedThreads = Math.round((clampedPercent / 100) * total * 10) / 10;
  const budgetSharePercent =
    targetPercent > 0 ? Math.round((clampedPercent / targetPercent) * 100) : 0;
  const overTarget = threads < total ? clampedPercent > targetPercent : clampedPercent >= 90;
  const level: 'cool' | 'warm' | 'hot' = overTarget
    ? 'hot'
    : budgetSharePercent >= 75
      ? 'warm'
      : 'cool';
  return {
    clampedPercent,
    targetPercent,
    usedThreads,
    budgetSharePercent,
    level,
  };
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
  const [liveUsagePercent, setLiveUsagePercent] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    api.getCpuBudget().then(
      (b) => active && setBudget(b),
      (e: Error) => active && onError(e.message),
    );
    // The governor's live figures (agents' own use, threads allowed now) while this is open.
    const timer = setInterval(() => {
      api.getCpuBudget().then(
        (b) => active && setBudget(b),
        () => {},
      );
    }, 4000);
    return () => {
      active = false;
      clearInterval(timer);
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

  const handleSensorReading = useCallback((s: MachineSensors) => {
    if (s.cpuUsagePercent != null) setLiveUsagePercent(s.cpuUsagePercent);
  }, []);

  // With the governor's figures, its own machine reading (same sample as the agents' share);
  // otherwise the sensor poll's live reading.
  const effectiveUsage =
    budget?.agentPercent != null && budget.usagePercent != null
      ? budget.usagePercent
      : (liveUsagePercent ?? budget?.usagePercent ?? null);
  const metrics =
    budget && effectiveUsage != null ? budgetUsageMetrics(effectiveUsage, budget) : null;

  return (
    <section className="panel" aria-label="CPU budget">
      <div className="panel-header">
        <h2>CPU budget</h2>
        <span className="meta">applies at once to running agents</span>
      </div>
      <p className="faint" style={{ margin: '0 0 12px', fontSize: 12.5 }}>
        Agent CLIs and the builds and tests they start share these CPU threads, at below-normal
        priority, so many agents at once can&rsquo;t hold every core, overheat the machine or slow
        your other apps. When other load rises, agents are narrowed to fewer threads so the whole
        machine stays under the threshold. A lower budget runs cooler; agents take longer.
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
      {budget && metrics && (
        <div className="cpu-budget-usage" aria-label="CPU usage against the threshold">
          <div className="cpu-budget-usage-head">
            <span className="cpu-budget-usage-current">
              <span className={`cpu-temp-dot is-${metrics.level}`} aria-hidden="true" />
              <span>Whole machine:</span>{' '}
              <b className={`num cpu-temp is-${metrics.level}`}>
                {metrics.clampedPercent.toFixed(1)}%
              </b>{' '}
              <span className="faint num">
                · {metrics.usedThreads.toFixed(1)} of {budget.totalThreads} threads busy
              </span>
            </span>
            <span className="cpu-budget-usage-target faint num">
              Threshold:{' '}
              {budget.threads === budget.totalThreads
                ? `none (all ${budget.totalThreads} threads)`
                : `${budget.threads} of ${budget.totalThreads} threads (${metrics.targetPercent}%)`}
            </span>
          </div>
          {budget.agentPercent != null && budget.allowedThreads != null && (
            <div className="cpu-budget-agents faint num">
              Agents: {budget.agentPercent.toFixed(1)}% (
              {((budget.agentPercent / 100) * budget.totalThreads).toFixed(1)} threads) · may use{' '}
              {budget.allowedThreads} of {budget.threads} threads now
              {budget.allowedThreads < budget.threads &&
                ' · narrowed so the whole machine stays under the threshold'}
            </div>
          )}
          <div
            className="cpu-budget-meter"
            role="meter"
            aria-label="Whole machine CPU usage against the threshold"
            aria-valuenow={metrics.clampedPercent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuetext={`${metrics.clampedPercent.toFixed(1)}% of the machine (${metrics.usedThreads.toFixed(1)} of ${budget.totalThreads} threads); threshold ${metrics.targetPercent}%`}
          >
            <div
              className="cpu-budget-meter-target-zone"
              style={{ width: `${metrics.targetPercent}%` }}
              aria-hidden="true"
            />
            <div
              className={`cpu-budget-meter-fill is-${metrics.level}`}
              style={{ width: `${metrics.clampedPercent}%` }}
            />
            {budget.threads < budget.totalThreads && (
              <div
                className="cpu-budget-meter-marker"
                style={{ left: `${metrics.targetPercent}%` }}
                title={`Threshold: ${budget.threads} of ${budget.totalThreads} threads (${metrics.targetPercent}%)`}
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      )}
      <SensorTable onReading={handleSensorReading} />
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
export function SensorTable({
  onReading,
}: {
  onReading?: (reading: MachineSensors) => void;
} = {}) {
  const [reading, setReading] = useState<MachineSensors | null>(null);
  const [failed, setFailed] = useState(false);
  const [ranges, setRanges] = useState<Record<string, Range>>({});
  const onReadingRef = useRef(onReading);
  useEffect(() => {
    onReadingRef.current = onReading;
  }, [onReading]);

  useEffect(() => {
    let active = true;
    let stop: (() => void) | null = null;
    const poll = () =>
      api.getSensors().then(
        (next) => {
          if (!active) return;
          setFailed(false);
          setReading(next);
          onReadingRef.current?.(next);
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
