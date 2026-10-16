import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { connectRunHost } from './connectRunHost.js';
import { startRunHost, runRendezvousFile } from './runDaemon.js';
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
