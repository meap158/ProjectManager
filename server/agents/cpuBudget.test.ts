import { stripVTControlCharacters } from 'node:util';
import { execFileSync, spawn } from 'node:child_process';
import { afterAll, describe, expect, it } from 'vitest';
import { openDb } from '../db.js';
import {
  affinityMask,
  applyCpuBudget,
  cpuBudgetSupported,
  defaultThreads,
  getCpuBudget,
  setCpuBudget,
  totalThreads,
} from './cpuBudget.js';

describe('CPU budget', () => {
  it('defaults to three quarters of the threads, as whole cores', () => {
    expect(defaultThreads(20)).toBe(14);
    expect(defaultThreads(8)).toBe(6);
    expect(defaultThreads(4)).toBe(2);
    expect(defaultThreads(2)).toBe(1);
    expect(defaultThreads(1)).toBe(1);
  });

  it('uses the highest-numbered CPUs and leaves CPU 0 free', () => {
    expect(affinityMask(2, 4)).toBe(0b1100n);
    expect(affinityMask(4, 4)).toBe(0b1111n);
    expect(affinityMask(0, 4)).toBe(0b1000n); // Never zero CPUs.
    expect(affinityMask(64, 64)).toBe((1n << 64n) - 1n);
  });

  it('stores a chosen budget and falls back to the default', () => {
    const db = openDb(':memory:');
    expect(getCpuBudget(db).threads).toBe(defaultThreads());
    expect(setCpuBudget(db, 1).threads).toBe(1);
    expect(getCpuBudget(db).totalThreads).toBe(totalThreads());
    db.close();
  });
});

const children: number[] = [];
afterAll(() => {
  for (const pid of children) {
    try {
      process.kill(pid);
    } catch {
      // Already gone.
    }
  }
});

describe.skipIf(process.platform !== 'win32' || !cpuBudgetSupported())(
  'CPU budget on Windows',
  () => {
    it('limits a process tree, including children it already started', async () => {
      // A parent that starts a child of its own, like an agent running a build.
      const parent = spawn(
        process.execPath,
        [
          '-e',
          `const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
            `console.log(c.pid);setInterval(()=>{},1000)`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
      );
      if (parent.pid) children.push(parent.pid);
      const childPid = await new Promise<number>((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(
          () => reject(new Error('Fixture child PID was not received')),
          10000,
        );
        parent.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        parent.stdout.on('data', (data) => {
          buffer += stripVTControlCharacters(String(data));
          const newline = buffer.indexOf('\n');
          if (newline < 0) return;
          clearTimeout(timer);
          const pid = Number(buffer.slice(0, newline).trim());
          if (!Number.isSafeInteger(pid) || pid < 1)
            reject(new Error(`Invalid fixture child PID: ${buffer}`));
          else resolve(pid);
        });
      });
      children.push(childPid);

      expect(await applyCpuBudget([parent.pid!], 1)).toBeGreaterThanOrEqual(2);
      for (const pid of [parent.pid!, childPid]) {
        const [affinity, priority] = execFileSync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `$p = Get-Process -Id ${pid}; "$([int64]$p.ProcessorAffinity) $($p.PriorityClass)"`,
          ],
          { encoding: 'utf8' },
        )
          .trim()
          .split(' ');
        expect(BigInt(affinity!)).toBe(BigInt.asIntN(64, affinityMask(1)));
        expect(priority).toBe('BelowNormal');
      }
    }, 60_000);
  },
);
