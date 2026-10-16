import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { budgetedRunArgv } from './budgetedRun.js';
import { affinityMask, cpuBudgetSupported } from '../cpuBudget.js';

it.skipIf(process.platform !== 'win32' || !cpuBudgetSupported())(
  'applies inherited affinity and priority before the worker executes',
  () => {
    const source = `const {execFileSync}=require('node:child_process');
    const out=execFileSync('powershell.exe',['-NoProfile','-Command','$p=Get-Process -Id '+process.pid+'; "$([int64]$p.ProcessorAffinity) $($p.PriorityClass)"'],{encoding:'utf8',windowsHide:true});process.stdout.write(out);process.exitCode=7;`;
    const [command, ...args] = budgetedRunArgv([process.execPath, '-e', source], 1);
    const result = spawnSync(command!, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 45000,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(7);
    const [mask, priority] = result.stdout.trim().split(/\s+/);
    expect(BigInt(mask!)).toBe(BigInt.asIntN(64, affinityMask(1)));
    expect(priority).toBe('BelowNormal');
  },
  60000,
);

it('rejects invalid budget before starting the command', () => {
  expect(() => budgetedRunArgv([process.execPath], 0)).toThrow('Invalid CPU');
  const [command, ...args] = budgetedRunArgv(
    [process.execPath, '-e', "console.log('MUST NOT RUN')"],
    Number.MAX_SAFE_INTEGER,
  );
  const result = spawnSync(command!, args, { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  expect(result.status).toBe(78);
  expect(result.stdout).not.toContain('MUST NOT RUN');
});
