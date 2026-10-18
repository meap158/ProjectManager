import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { getPriority } from 'node:os';
import { promisify } from 'node:util';
import { applyCpuBudget, cpuBudgetSupported, totalThreads, affinityMask } from '../cpuBudget.js';

const [budget, encoded, ...extra] = process.argv.slice(2);
const threads = Number(budget);
let argv: string[] = [];
try {
  const parsed: unknown = JSON.parse(Buffer.from(encoded ?? '', 'base64').toString('utf8'));
  if (
    !Array.isArray(parsed) ||
    !parsed.length ||
    parsed.length > 1024 ||
    !parsed.every((value) => typeof value === 'string' && value.length <= 20000)
  )
    throw new Error('Invalid command');
  argv = parsed;
} catch {
  /* Invalid input never starts a worker. */
}
if (
  extra.length ||
  !argv[0]?.trim() ||
  !Number.isSafeInteger(threads) ||
  threads < 1 ||
  threads > totalThreads() ||
  !cpuBudgetSupported()
) {
  console.error('[run host] Invalid or unsupported CPU budget');
  process.exit(78);
}
if ((await applyCpuBudget([process.pid], threads)) < 1 || !(await verifiedBudget(threads))) {
  console.error('[run host] CPU budget could not be applied; worker was not started');
  process.exit(78);
}
const worker = spawn(argv[0]!, argv.slice(1), { stdio: 'inherit', windowsHide: true });
worker.once('error', (error) => {
  console.error('[run host] Worker could not start:', error.message);
  process.exitCode = 1;
});
worker.once('close', (code) => {
  process.exitCode = code ?? 1;
});

/** Confirm the bootstrap itself was updated; a successful descendant update is insufficient. */
async function verifiedBudget(threads: number): Promise<boolean> {
  try {
    const mask = affinityMask(threads);
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '$p=Get-Process -Id $env:PM_VERIFY_PID; "$([int64]$p.ProcessorAffinity) $($p.PriorityClass)"',
        ],
        {
          windowsHide: true,
          timeout: 5000,
          env: { ...process.env, PM_VERIFY_PID: String(process.pid) },
        },
      );
      const [actual, priority] = stdout.trim().split(/\s+/);
      // The governor may already have narrowed it to fewer threads within the budget.
      const got = BigInt.asUintN(64, BigInt(actual!));
      return got !== 0n && (got & ~mask) === 0n && priority === 'BelowNormal';
    }
    const status = await readFile('/proc/self/status', 'utf8');
    const actual = /^Cpus_allowed:\s*([a-f\d,]+)/im.exec(status)?.[1]?.replaceAll(',', '');
    return !!actual && BigInt('0x' + actual) === mask && getPriority(process.pid) >= 10;
  } catch {
    return false;
  }
}
