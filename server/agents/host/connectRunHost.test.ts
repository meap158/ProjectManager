import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { connectRunHost } from './connectRunHost.js';
import { startRunHost, runRendezvousFile, readRunRendezvous } from './runDaemon.js';
import type { RunClient } from './runClient.js';

it('starts once for simultaneous callers and reuses the authenticated host', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-connect-run-'));
  let host: Awaited<ReturnType<typeof startRunHost>> | undefined;
  const clients: RunClient[] = [];
  const start = vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    host = await startRunHost(dir);
  });
  try {
    clients.push(...(await Promise.all([connectRunHost(dir, start), connectRunHost(dir, start)])));
    clients.push(await connectRunHost(dir, start));
    expect(start).toHaveBeenCalledTimes(1);
    expect(clients.map((c) => c.hostInstance)).toEqual(Array(3).fill(host!.connection.instance));
  } finally {
    clients.forEach((c) => c.close());
    await host?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('refuses published broken or mismatched ownership without starting a replacement', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-connect-run-'));
  const host = await startRunHost(dir);
  const start = vi.fn(async () => {});
  try {
    writeFileSync(
      runRendezvousFile(dir),
      JSON.stringify({ ...host.connection, instance: 'wrong' }),
    );
    await expect(connectRunHost(dir, start)).rejects.toThrow('identity mismatch');
    writeFileSync(
      runRendezvousFile(dir),
      JSON.stringify({ ...host.connection, token: 'wrong-token' }),
    );
    await expect(connectRunHost(dir, start)).rejects.toThrow();
    writeFileSync(
      runRendezvousFile(dir),
      JSON.stringify({
        ...host.connection,
        address:
          process.platform === 'win32'
            ? host.connection.address + '-absent'
            : path.join(dir, 'absent.sock'),
      }),
    );
    await expect(connectRunHost(dir, start)).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
  } finally {
    writeFileSync(runRendezvousFile(dir), JSON.stringify(host.connection));
    await host.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('releases a failed startup flight so a later explicit connection can retry', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-connect-retry-'));
  let host: Awaited<ReturnType<typeof startRunHost>> | undefined;
  let client: RunClient | undefined;
  try {
    await expect(
      connectRunHost(dir, async () => {
        throw new Error('fixture startup failed');
      }),
    ).rejects.toThrow('fixture startup failed');
    client = await connectRunHost(dir, async () => {
      host = await startRunHost(dir);
    });
    expect(client.hostInstance).toBe(host!.connection.instance);
  } finally {
    client?.close();
    await host?.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
});

it('default detached startup survives the calling process and reuses its live worker', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-auto-host-process-'));
  const marker = path.join(dir, 'launches');
  const input = {
    nonce: 'auto-fixture',
    cwd: dir,
    env: { ...process.env },
    argv: [
      process.execPath,
      '-e',
      `require('node:fs').appendFileSync(${JSON.stringify(marker)},'one');console.log('ready');setInterval(()=>{},1000)`,
    ],
  };
  let client: RunClient | undefined;
  let connection: ReturnType<typeof readRunRendezvous> | undefined;
  try {
    const source = `import {connectRunHost} from ${JSON.stringify(new URL('./connectRunHost.ts', import.meta.url).href)};
      const client=await connectRunHost(${JSON.stringify(dir)});
      await client.launch(${JSON.stringify(input)});
      const deadline=Date.now()+10000;
      while(!(await client.read('auto-fixture',0))?.data.includes('ready')) {
        if(Date.now()>deadline)throw new Error('fixture worker timeout');
        await new Promise(resolve=>setTimeout(resolve,20));
      }
      client.close();process.exit(86);`;
    const caller = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', source],
      { cwd: dir, encoding: 'utf8', timeout: 20000, windowsHide: true },
    );
    expect(caller.error, caller.stderr).toBeUndefined();
    expect(caller.status, caller.stderr).toBe(86);
    connection = readRunRendezvous(dir);
    expect(connection.pid).toBeGreaterThan(0);
    expect(connection.pid).not.toBe(process.pid);
    client = await connectRunHost(dir);
    expect(client.hostInstance).toBe(connection.instance);
    expect(await client.launch(input)).toMatchObject({ state: 'running' });
    expect(readFileSync(marker, 'utf8')).toBe('one');
    expect(await client.stop(input.nonce)).toBe(true);
  } finally {
    if (!connection) {
      try {
        connection = readRunRendezvous(dir);
      } catch {
        /* Startup may fail before publication. */
      }
    }
    if (client) {
      await client.stop(input.nonce).catch(() => false);
      client.close();
    }
    if (connection?.pid && connection.pid !== process.pid) {
      // Only this test's fresh data folder can publish this diagnostic PID.
      try {
        process.kill(connection.pid, 'SIGTERM');
      } catch {
        /* Already exited. */
      }
      await expect
        .poll(
          () => {
            try {
              process.kill(connection!.pid!, 0);
              return false;
            } catch {
              return true;
            }
          },
          { timeout: 10000 },
        )
        .toBe(true);
    }
    await expect
      .poll(
        () => {
          try {
            rmSync(dir, { recursive: true, force: true });
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 5000 },
      )
      .toBe(true);
  }
}, 30000);
