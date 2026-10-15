import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { startRunHost, readRunRendezvous } from './runDaemon.js';
import { RunClient } from './runClient.js';

it('publishes authenticated host identity and refuses a competing host without replacing credentials', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-daemon-'));
  const host = await startRunHost(dir);
  let client: RunClient | undefined;
  try {
    const connection = readRunRendezvous(dir);
    expect(connection).toEqual(host.connection);
    await expect(startRunHost(dir)).rejects.toThrow();
    if (process.platform === 'win32')
      await expect(startRunHost(dir.toUpperCase())).rejects.toThrow();
    expect(readRunRendezvous(dir)).toEqual(connection);
    client = await RunClient.connect(connection.address, connection.token);
    expect(client.hostInstance).toBe(connection.instance);
    const marker = path.join(dir, 'launches');
    const input = {
      nonce: 'daemon-run',
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'one');console.log('ready');setTimeout(()=>{},10000)`,
      ],
    };
    await client.launch(input);
    await expect.poll(async () => (await client!.read('daemon-run', 0))?.data).toContain('ready');
    client.close();
    client = await RunClient.connect(connection.address, connection.token);
    expect(await client.launch(input)).toMatchObject({ state: 'running' });
    expect(readFileSync(marker, 'utf8')).toBe('one');
    expect(await host.shutdown()).toBe(true);
    expect(() => readRunRendezvous(dir)).toThrow();
  } finally {
    client?.close();
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it('keeps a real worker in a standalone host after its dispatching client process exits', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-daemon-process-'));
  const daemon = spawn(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      fileURLToPath(new URL('./runHostMain.ts', import.meta.url)),
      '--data-dir',
      dir,
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  let client: RunClient | undefined;
  try {
    await expect
      .poll(
        () => {
          try {
            return readRunRendezvous(dir).version;
          } catch {
            return null;
          }
        },
        { timeout: 10000 },
      )
      .toBe(1);
    const connection = readRunRendezvous(dir);
    const marker = path.join(dir, 'launches');
    const input = {
      nonce: 'standalone',
      cwd: dir,
      env: { ...process.env },
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'one');console.log('ready');setTimeout(()=>{},15000)`,
      ],
    };
    const source = `import { RunClient } from ${JSON.stringify(new URL('./runClient.ts', import.meta.url).href)};
      const client=await RunClient.connect(${JSON.stringify(connection.address)},${JSON.stringify(connection.token)});
      await client.launch(${JSON.stringify(input)});
      const deadline=Date.now()+10000;
      while(!(await client.read('standalone',0))?.data.includes('ready')) {
        if(Date.now()>deadline)throw new Error('Worker startup timeout');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      client.close();process.exit(86);`;
    const dispatch = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', source],
      { cwd: dir, encoding: 'utf8', timeout: 15000, windowsHide: true },
    );
    expect(dispatch.error, dispatch.stderr).toBeUndefined();
    expect(dispatch.status, dispatch.stderr).toBe(86);
    expect(daemon.exitCode).toBeNull();
    client = await RunClient.connect(connection.address, connection.token);
    expect(await client.launch(input)).toMatchObject({ state: 'running' });
    expect(readFileSync(marker, 'utf8')).toBe('one');
    expect(await client.stop('standalone')).toBe(true);
  } finally {
    if (client) {
      await client.stop('standalone').catch(() => false);
      client.close();
    }
    if (daemon.exitCode === null && daemon.signalCode === null) {
      const exit = once(daemon, 'exit');
      daemon.kill();
      await exit;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
