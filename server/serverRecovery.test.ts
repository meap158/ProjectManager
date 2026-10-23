import { spawn, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
// @ts-expect-error Launcher helpers are plain JavaScript, used before compilation.
import { childOutcome, recordServerOutput, restartBudget } from '../scripts/serverRecovery.mjs';

it('the actual launcher retries a busy port and recovers a crashed production server', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-launch-recovery-'));
  const blocker = createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const port = (blocker.address() as { port: number }).port;
  mkdirSync(path.join(dir, 'scripts'));
  mkdirSync(path.join(dir, 'node_modules'));
  mkdirSync(path.join(dir, 'dist/server'), { recursive: true });
  for (const file of ['launch.mjs', 'serverRecovery.mjs'])
    copyFileSync(new URL('../scripts/' + file, import.meta.url), path.join(dir, 'scripts', file));
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify({ type: 'module', config: { port } }),
  );
  writeFileSync(
    path.join(dir, 'dist/server/index.js'),
    `
    import { createServer } from 'node:http';
    import { existsSync, writeFileSync } from 'node:fs';
    const first = !existsSync('booted'); writeFileSync('booted', 'yes');
    createServer((req,res)=>res.end('ok')).listen(Number(process.env.PORT),'127.0.0.1');
    if(first) setTimeout(()=>process.exit(1),1500);
    setTimeout(()=>process.exit(0),15000).unref();
  `,
  );
  const launcher = spawn(process.execPath, ['scripts/launch.mjs', '--prod', '--no-open'], {
    cwd: dir,
    windowsHide: true,
    env: { ...process.env, DATA_DIR: path.join(dir, 'data'), PORT: String(port) },
  });
  let output = '';
  launcher.stdout.on('data', (data) => {
    output += data;
  });
  launcher.stderr.on('data', (data) => {
    output += data;
  });
  try {
    await expect.poll(() => output, { timeout: 20000 }).toContain('Server recovered at');
    expect(output).toContain(`Port ${port} is busy`);
    expect(output).toContain('code=1');
    expect(readFileSync(path.join(dir, 'data/server-output.log'), 'utf8')).toContain(
      'server stopped',
    );
  } finally {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(launcher.pid), '/T', '/F'], { stdio: 'ignore' });
    } else launcher.kill('SIGTERM');
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30000);

it('detects a real child crash and can start a healthy replacement', async () => {
  const crashed = spawn(process.execPath, ['-e', 'throw new Error("fixture crash")'], {
    windowsHide: true,
  });
  expect(await childOutcome(crashed)).toMatchObject({ code: 1 });
  const replacement = spawn(process.execPath, ['-e', 'process.exit(0)'], { windowsHide: true });
  expect(await childOutcome(replacement)).toMatchObject({ code: 0 });
});

it('detects a fatal server inside a watcher that remains alive, including split markers', async () => {
  const watcher = spawn(
    process.execPath,
    [
      '-e',
      'process.stderr.write("[server] FA"); setTimeout(()=>process.stderr.write("TAL fixture\\n"),20); setInterval(()=>{},1000)',
    ],
    { windowsHide: true },
  );
  try {
    expect(await childOutcome(watcher)).toMatchObject({ fatal: true, code: 1 });
    expect(watcher.exitCode).toBeNull();
  } finally {
    watcher.kill();
  }
});

it.each([
  'FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory',
  'FATAL ERROR: Fatal process out of memory: Zone',
])('detects native V8 failure while its watcher remains alive: %s', async (message) => {
  const watcher = spawn(
    process.execPath,
    [
      '-e',
      `process.stderr.write('ordinary out of memory warning\\n'); setTimeout(() => process.stderr.write(${JSON.stringify(message.slice(0, 8))}), 20); setTimeout(() => process.stderr.write(${JSON.stringify(message.slice(8) + '\n')}), 40); setInterval(()=>{},1000)`,
    ],
    { windowsHide: true },
  );
  try {
    expect(await childOutcome(watcher)).toMatchObject({ fatal: true, code: 1 });
    expect(watcher.exitCode).toBeNull();
  } finally {
    watcher.kill();
  }
});

it('limits repeated crashes and replenishes the budget after stable runtime', () => {
  const allowed = restartBudget(2, 100);
  expect(allowed(0)).toBe(true);
  expect(allowed(10)).toBe(true);
  expect(allowed(20)).toBe(false);
  expect(allowed(110)).toBe(true);
});

it('retains bounded crash output and tolerates an unwritable diagnostic destination', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-crash-output-'));
  try {
    const file = path.join(dir, 'server-output.log');
    writeFileSync(file, 'x'.repeat(2 * 1024 * 1024));
    recordServerOutput(dir, 'crash evidence');
    expect(readFileSync(file, 'utf8')).toBe('crash evidence');
    expect(readFileSync(file + '.previous').length).toBe(2 * 1024 * 1024);
    expect(() => recordServerOutput(file, 'cannot write here')).not.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
