// CPU governor for agent processes on Windows (Settings → CPU budget). The budget's affinity was
// set once and left alone: it limits which threads agents may use but nothing reacts to the
// machine, so busy agents plus the load they cause (the system, antivirus scanning their output)
// and the user's own apps took the whole machine to 100% (frozen, overheating). The governor adds
// feedback:
//  - it follows the agent processes: those carrying the budget's affinity mask (however they
//    were started: the session host, runs) and every process they start;
//  - every 2 s it measures the whole machine and the agents' own CPU time;
//  - when other load would take the total past the target, it narrows the agents to fewer
//    threads (never under one), and widens them again a thread at a time as room returns.
// Affinity is the lever because it works on every process, whatever job it is in (CLIs put their
// children in jobs of their own, so a job-wide cap cannot reach existing sessions), and fewer
// active cores also means less power and heat.
// It is a small Windows PowerShell process compiling the C# below at start (no native modules).
// On exit it gives every agent process the full budget again, so none stays narrowed.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

export interface GovernorConfig {
  /** The budget: the most threads agents may use (the highest-numbered ones). */
  threads: number;
  total: number;
}

export interface GovernorStats {
  /** What the agents themselves use now, as % of the whole machine. */
  agentPercent: number;
  /** What the whole machine uses now, %. */
  machinePercent: number;
  /** Threads the agents may use right now (≤ the budget; fewer while the machine is busy). */
  allowedThreads: number;
  /** Agent processes followed. */
  processes: number;
  at: number;
}

/**
 * Threads the agents may use next: the room left under the target once other load is counted
 * (in threads), never under one or over the budget. Narrows at once (protecting the machine);
 * widens one thread per interval and only with half a thread to spare, so small swings in other
 * load don't re-mask every agent process each interval.
 */
export function nextAllowed(
  current: number,
  config: GovernorConfig,
  machinePercent: number,
  agentPercent: number,
): number {
  const otherThreads = (Math.max(0, machinePercent - agentPercent) / 100) * config.total;
  const clamp = (n: number) => Math.max(1, Math.min(config.threads, Math.floor(n)));
  const wanted = clamp(config.threads - otherThreads);
  const roomy = clamp(config.threads - otherThreads - 0.5);
  return wanted < current ? wanted : roomy > current ? current + 1 : current;
}

export function parseStats(line: string, now = Date.now()): GovernorStats | null {
  const m = /^stats (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+) (\d+)$/.exec(line.trim());
  if (!m) return null;
  return {
    agentPercent: Number(m[1]),
    machinePercent: Number(m[2]),
    allowedThreads: Number(m[3]),
    processes: Number(m[4]),
    at: now,
  };
}

// Mirrors nextAllowed() (tested in TypeScript). stdin: "config <threads> <total> <inherited>"
// (inherited: threads a previous governor last allowed, 0 if none); stdout every
// interval: "stats <agent%> <machine%> <allowedThreads> <processes>".
const SOURCE = String.raw`
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;

public static class PmCpuGovernor {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ProcessEntry {
    public uint dwSize, cntUsage, th32ProcessID;
    public IntPtr th32DefaultHeapID;
    public uint th32ModuleID, cntThreads, th32ParentProcessID;
    public int pcPriClassBase;
    public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool GetProcessAffinityMask(IntPtr process, out UIntPtr processMask, out UIntPtr systemMask);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool SetProcessAffinityMask(IntPtr process, UIntPtr mask);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32", SetLastError = true)]
  static extern bool GetSystemTimes(out long idle, out long kernel, out long user);
  [DllImport("kernel32", SetLastError = true)]
  static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")]
  static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
  [DllImport("kernel32", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")]
  static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

  // query limited information, set information (affinity)
  const uint Access = 0x1000 | 0x0200;

  class Agent { public long Created; public long Cpu; }
  static readonly Dictionary<uint, Agent> agents = new Dictionary<uint, Agent>();
  static int inherited = 0;

  static ulong MaskOf(int threads, int total) {
    int n = Math.Max(1, Math.Min(threads, total));
    ulong low = n >= 64 ? ulong.MaxValue : (1UL << n) - 1;
    return low << (total - n);
  }

  // Follows agent processes: the budget's (or the current) mask marks one, and so does a parent
  // already followed, if the child started after it (process IDs are reused). Narrows or widens
  // each to the allowed mask and returns the CPU time they used since the last call (100 ns).
  static long Sweep(int budgetThreads, int totalThreads, ulong allowedMask) {
    var parents = new Dictionary<uint, uint>();
    IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
    if (snap == IntPtr.Zero || snap == new IntPtr(-1)) return 0;
    try {
      var e = new ProcessEntry { dwSize = (uint)Marshal.SizeOf(typeof(ProcessEntry)) };
      for (bool ok = Process32First(snap, ref e); ok; ok = Process32Next(snap, ref e))
        if (e.th32ProcessID != 0) parents[e.th32ProcessID] = e.th32ParentProcessID;
    } finally { CloseHandle(snap); }

    foreach (var pid in new List<uint>(agents.Keys)) if (!parents.ContainsKey(pid)) agents.Remove(pid);
    long used = 0;
    // Parents before children within one sweep: repeat while new agents turn up.
    for (int pass = 0, found = 1; found > 0 && pass < 8; pass++) {
      found = 0;
      foreach (var kv in parents) {
        uint pid = kv.Key;
        // Later passes only look for children of agents found in this sweep.
        if (pass > 0 && (agents.ContainsKey(pid) || !agents.ContainsKey(kv.Value))) continue;
        IntPtr h = OpenProcess(Access, false, pid);
        if (h == IntPtr.Zero) continue;
        try {
          long created, exited, kernel, user;
          if (!GetProcessTimes(h, out created, out exited, out kernel, out user)) continue;
          Agent known;
          if (agents.TryGetValue(pid, out known) && known.Created != created) { agents.Remove(pid); known = null; }
          if (known == null) {
            UIntPtr pm, sm;
            if (!GetProcessAffinityMask(h, out pm, out sm)) continue;
            ulong mask = pm.ToUInt64();
            Agent parent;
            // The budget's own mask, the current one, or the one a previous governor had narrowed
            // agents to before it stopped without restoring them.
            bool marked = mask == MaskOf(budgetThreads, totalThreads) || mask == allowedMask
              || (inherited > 0 && mask == MaskOf(inherited, totalThreads));
            bool child = agents.TryGetValue(kv.Value, out parent) && created >= parent.Created;
            if (!marked && !child) continue;
            known = new Agent { Created = created, Cpu = kernel + user };
            agents[pid] = known;
            found++;
            // A ceiling only: narrowed when it reaches past the allowed threads, never widened
            // from a narrower mask something else chose.
            if ((mask & ~allowedMask) != 0) SetProcessAffinityMask(h, new UIntPtr(allowedMask));
            continue;
          }
          if (pass == 0) {
            used += Math.Max(0, kernel + user - known.Cpu);
            known.Cpu = kernel + user;
          }
        } finally { CloseHandle(h); }
      }
    }
    return used;
  }

  // Moves agents from the previous allowed mask to the new one: widened only from the mask the
  // governor had set, narrowed whenever they reach past the new one; other masks are left alone.
  static void Apply(ulong mask, ulong previous) {
    foreach (var pid in agents.Keys) {
      IntPtr h = OpenProcess(Access, false, pid);
      if (h == IntPtr.Zero) continue;
      try {
        UIntPtr pm, sm;
        if (!GetProcessAffinityMask(h, out pm, out sm)) continue;
        ulong current = pm.ToUInt64();
        if (current != mask && (current == previous || (current & ~mask) != 0))
          SetProcessAffinityMask(h, new UIntPtr(mask));
      } finally { CloseHandle(h); }
    }
  }

  static string F(double v) { return v.ToString("0.0", CultureInfo.InvariantCulture); }

  public static void Run() {
    var lines = new ConcurrentQueue<string>();
    bool eof = false;
    var reader = new Thread(() => {
      string l;
      while ((l = Console.In.ReadLine()) != null) lines.Enqueue(l);
      eof = true;
    });
    reader.IsBackground = true;
    reader.Start();

    int budget = 0, total = Environment.ProcessorCount, allowed = 0;
    long idle0, kernel0, user0;
    GetSystemTimes(out idle0, out kernel0, out user0);
    while (true) {
      string line;
      while (lines.TryDequeue(out line)) {
        var p = line.Split(' ');
        if (p.Length == 4 && p[0] == "config") {
          budget = int.Parse(p[1], CultureInfo.InvariantCulture);
          total = int.Parse(p[2], CultureInfo.InvariantCulture);
          inherited = int.Parse(p[3], CultureInfo.InvariantCulture);
          allowed = allowed == 0 ? budget : Math.Min(allowed, budget);
        }
      }
      // Leaving: every agent gets the full budget back.
      if (eof) { if (budget > 0) Apply(MaskOf(budget, total), MaskOf(allowed, total)); return; }
      if (budget == 0) { Thread.Sleep(200); continue; }
      ulong allowedMask = MaskOf(allowed, total);
      long agentTime = Sweep(budget, total, allowedMask);
      Thread.Sleep(2000);
      agentTime += Sweep(budget, total, allowedMask);
      long idle1, kernel1, user1;
      GetSystemTimes(out idle1, out kernel1, out user1);
      double all = (kernel1 - kernel0) + (user1 - user0);
      double machine = all <= 0 ? 0 : Math.Max(0, Math.Min(100, (all - (idle1 - idle0)) / all * 100));
      double agentsPct = all <= 0 ? 0 : Math.Max(0, Math.Min(machine, agentTime / all * 100));
      idle0 = idle1; kernel0 = kernel1; user0 = user1;
      double otherThreads = Math.Max(0, machine - agentsPct) / 100 * total;
      int wanted = Math.Max(1, Math.Min(budget, (int)Math.Floor(budget - otherThreads)));
      int roomy = Math.Max(1, Math.Min(budget, (int)Math.Floor(budget - otherThreads - 0.5)));
      int next = wanted < allowed ? wanted : roomy > allowed ? allowed + 1 : allowed;
      if (next != allowed) {
        ulong previous = MaskOf(allowed, total);
        allowed = next;
        Apply(MaskOf(allowed, total), previous);
      }
      Console.WriteLine("stats " + F(agentsPct) + " " + F(machine) + " " + allowed + " " + agents.Count);
      Console.Out.Flush();
    }
  }
}
`;

const SCRIPT =
  '$ErrorActionPreference = "Stop"; Add-Type -TypeDefinition $env:PM_GOVERNOR_CS -Language CSharp; [PmCpuGovernor]::Run()';

/** Runs and supervises the governor process; the latest measurements are kept for the UI. */
export class CpuGovernor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private config: GovernorConfig | null = null;
  private stopped = false;
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  stats: GovernorStats | null = null;

  static supported(): boolean {
    return process.platform === 'win32';
  }

  configure(config: GovernorConfig): void {
    this.config = config;
    if (!CpuGovernor.supported() || this.stopped) return;
    if (!this.child) this.start();
    else this.send();
  }

  /** Measurements, or null when none arrived lately (not running, or still starting). */
  latest(now = Date.now()): GovernorStats | null {
    return this.stats && now - this.stats.at < 10_000 ? this.stats : null;
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.restartTimer);
    // Closing stdin lets it give the agents their full budget back before it exits.
    this.child?.stdin.end();
    this.child = null;
  }

  private send(): void {
    const c = this.config;
    // Also the threads last allowed, so a restarted governor recognises agents it had narrowed.
    const inherited = this.stats?.allowedThreads ?? 0;
    if (c && this.child) this.child.stdin.write(`config ${c.threads} ${c.total} ${inherited}\n`);
  }

  private start(): void {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { windowsHide: true, env: { ...process.env, PM_GOVERNOR_CS: SOURCE } },
    );
    this.child = child;
    let buffer = '';
    child.stdout.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const stats = parseStats(line);
        if (stats) {
          this.stats = stats;
          this.restarts = 0;
        }
      }
    });
    child.stderr.on('data', (data: Buffer) => {
      const text = data.toString('utf8').trim();
      if (text) console.error(`[cpu-governor] ${text.slice(0, 300)}`);
    });
    child.stdin.on('error', () => undefined);
    child.on('error', (error) => console.error('[cpu-governor] could not start:', error.message));
    child.on('exit', () => {
      if (this.child === child) this.child = null;
      if (this.stopped) return;
      // Restart with backoff: agents must not stay ungoverned for long.
      const delay = Math.min(60_000, 2000 * 2 ** this.restarts++);
      this.restartTimer = setTimeout(() => {
        if (!this.stopped && !this.child) this.start();
      }, delay);
      this.restartTimer.unref();
    });
    this.send();
  }
}
