// CPU budget for agent processes (Settings). Agent CLIs build, test and lint on their own; many
// at once can hold every core for hours (heat, throttling). Two OS mechanisms keep them in check,
// both inherited by every process an agent starts later:
//  - processor affinity: all agent processes together use at most `threads` logical CPUs (the
//    highest-numbered ones; CPU 0 handles most system interrupts and stays free), which bounds
//    the power the package can draw;
//  - below-normal priority: the desktop, browser and ProjectManager itself win any contention.
// Applied to the session host (all terminal sessions) and to each run, never to the server.

import { execFile } from 'node:child_process';
import os from 'node:os';
import type { CpuBudget } from '../../shared/types.js';
import type { Db } from '../db.js';
import { getSetting, setSetting } from '../store.js';

const KEY = 'cpu_budget_threads';

export function totalThreads(): number {
  return Math.max(1, os.cpus().length);
}

/**
 * Three quarters of the threads, as an even count (whole cores where cores run two threads):
 * 20 threads → 14, 8 → 6, 4 → 2. Agents stay fast; the rest keeps the machine cool and responsive.
 */
export function defaultThreads(total = totalThreads()): number {
  return Math.min(total, Math.max(1, Math.floor((total * 3) / 8) * 2));
}

/** Affinity masks are 64 bits wide on Windows (one processor group); Linux has taskset. */
export function cpuBudgetSupported(total = totalThreads()): boolean {
  return (process.platform === 'win32' && total <= 64) || process.platform === 'linux';
}

/** The highest `threads` of `total` logical CPUs. */
export function affinityMask(threads: number, total = totalThreads()): bigint {
  const n = Math.min(Math.max(1, threads), total);
  return ((1n << BigInt(n)) - 1n) << BigInt(total - n);
}

export interface CpuTimesSnapshot {
  idle: number;
  total: number;
}

/** Sums user/nice/sys/idle/irq ticks across all logical CPUs without spawning a process. */
export function readCpuTotals(
  cpus: readonly { times: { user: number; nice: number; sys: number; idle: number; irq: number } }[] = os.cpus(),
): CpuTimesSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const { user, nice, sys, idle: cIdle, irq } = cpu.times;
    idle += cIdle;
    total += user + nice + sys + cIdle + irq;
  }
  return { idle, total };
}

/** Utilization percentage (0–100, one decimal place) between two os.cpus() snapshots. */
export function calcCpuUsagePercent(
  prev: CpuTimesSnapshot,
  next: CpuTimesSnapshot,
): number | null {
  const dTotal = next.total - prev.total;
  const dIdle = next.idle - prev.idle;
  if (dTotal <= 0) return null;
  const busy = Math.max(0, Math.min(dTotal, dTotal - dIdle));
  return Math.round((busy / dTotal) * 1000) / 10;
}

let cpuSample: { at: number; snap: CpuTimesSnapshot; lastPercent: number | null } = {
  at: Date.now(),
  snap: readCpuTotals(),
  lastPercent: null,
};

/**
 * Current overall CPU utilization (0–100%), computed from os.cpus() deltas since the last sample.
 * Reuses the previous reading when sampled again within 250ms so back-to-back requests never divide
 * by a near-zero tick window.
 */
export function sampleCpuUsage(now = Date.now()): number {
  const current = readCpuTotals();
  const elapsed = now - cpuSample.at;
  const delta = calcCpuUsagePercent(cpuSample.snap, current);
  if (elapsed >= 250 && delta !== null) {
    cpuSample = { at: now, snap: current, lastPercent: delta };
    return delta;
  }
  if (cpuSample.lastPercent !== null) return cpuSample.lastPercent;
  if (delta !== null) {
    cpuSample = { at: now, snap: current, lastPercent: delta };
    return delta;
  }
  return 0;
}

export function getCpuBudget(db: Db): CpuBudget {
  const total = totalThreads();
  const saved = getSetting<number>(db, KEY);
  const threads =
    Number.isInteger(saved) && saved! >= 1 && saved! <= total ? saved! : defaultThreads(total);
  return {
    supported: cpuBudgetSupported(total),
    totalThreads: total,
    threads,
    defaultThreads: defaultThreads(total),
    usagePercent: sampleCpuUsage(),
  };
}

export function setCpuBudget(db: Db, threads: number): CpuBudget {
  setSetting(db, KEY, threads);
  return getCpuBudget(db);
}

// Walks each root's process tree (children created after their parent, which guards against
// reused PIDs) and sets affinity + priority. Inputs arrive as environment variables, never as
// script text. Prints how many processes were updated.
const WINDOWS_SCRIPT = `
$mask = [int64]$env:PM_CPU_MASK
$roots = @($env:PM_CPU_PIDS -split ',' | Where-Object { $_ } | ForEach-Object { [int]$_ })
$all = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate)
$byId = @{}; $kids = @{}
foreach ($p in $all) {
  $byId[[int]$p.ProcessId] = $p
  $parent = [int]$p.ParentProcessId
  if (-not $kids.ContainsKey($parent)) { $kids[$parent] = New-Object System.Collections.ArrayList }
  [void]$kids[$parent].Add($p)
}
$queue = New-Object System.Collections.Queue
foreach ($r in $roots) { if ($byId.ContainsKey($r)) { $queue.Enqueue($byId[$r]) } }
$seen = @{}; $done = 0
while ($queue.Count -gt 0) {
  $p = $queue.Dequeue(); $id = [int]$p.ProcessId
  if ($seen.ContainsKey($id)) { continue }
  $seen[$id] = $true
  try {
    $proc = Get-Process -Id $id -ErrorAction Stop
    $proc.ProcessorAffinity = [IntPtr]$mask
    $proc.PriorityClass = 'BelowNormal'
    $done++
  } catch {}
  if ($kids.ContainsKey($id)) {
    foreach ($k in $kids[$id]) { if ($k.CreationDate -ge $p.CreationDate) { $queue.Enqueue($k) } }
  }
}
$done
`;

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile(
      command,
      args,
      { windowsHide: true, timeout: 30_000, env: env ? { ...process.env, ...env } : undefined },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout))),
    ),
  );
}

/** Processes under `roots` (inclusive), from `ps` (Linux re-parents orphans, so no PID guard). */
async function linuxTree(roots: number[]): Promise<number[]> {
  const kids = new Map<number, number[]>();
  for (const line of (await run('ps', ['-e', '-o', 'pid=,ppid='])).split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined) continue;
    kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
  }
  const out = new Set<number>();
  const queue = [...roots];
  while (queue.length) {
    const pid = queue.shift()!;
    if (out.has(pid)) continue;
    out.add(pid);
    queue.push(...(kids.get(pid) ?? []));
  }
  return [...out];
}

/**
 * Applies the budget to each root process and everything already running under it (processes
 * they start later inherit it). Returns how many processes were updated; failures are logged.
 */
export async function applyCpuBudget(roots: number[], threads: number): Promise<number> {
  const pids = roots.filter((pid) => Number.isInteger(pid) && pid > 0);
  if (pids.length === 0 || !cpuBudgetSupported()) return 0;
  const mask = affinityMask(threads);
  try {
    if (process.platform === 'win32') {
      const out = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT],
        // Signed: a mask using all 64 CPUs would overflow PowerShell's [int64].
        { PM_CPU_MASK: BigInt.asIntN(64, mask).toString(), PM_CPU_PIDS: pids.join(',') },
      );
      return Number(out.trim()) || 0;
    }
    let done = 0;
    for (const pid of await linuxTree(pids)) {
      try {
        await run('taskset', ['-a', '-p', mask.toString(16), String(pid)]);
        await run('renice', ['-n', '10', '-p', String(pid)]).catch(() => undefined);
        done++;
      } catch {
        // Exited meanwhile, or taskset is missing.
      }
    }
    return done;
  } catch (error) {
    console.error('[agents] CPU budget not applied:', (error as Error).message);
    return 0;
  }
}
