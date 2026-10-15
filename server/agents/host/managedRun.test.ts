import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDb } from '../../db.js';
import { startRunHost } from './runDaemon.js';
import { RunClient } from './runClient.js';
import { launchManagedRun } from './managedRun.js';

it('binds a run attempt before real launch and reattaches without another worker', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-managed-run-'));
  const db = openDb(':memory:');
  const host = await startRunHost(dir);
  const client = await RunClient.connect(host.connection.address, host.connection.token);
  let nonce: string | undefined;
  try {
    db.prepare("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture',?,'now')").run(
      dir,
    );
    db.exec(`INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path,orchestrator_id)
      VALUES(1,1,'Managed','{"command":["fixture"]}','queued','now','/managed.log','master');`);
    const marker = path.join(dir, 'launches');
    const input = {
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'one');console.log('ready');setTimeout(()=>{},10000)`,
      ],
    };
    const first = await launchManagedRun(db, client, 1, 1, input);
    nonce = first.identity.nonce;
    await expect.poll(async () => (await client.read(nonce!, 0))?.data).toContain('ready');
    const again = await launchManagedRun(db, client, 1, 1, input);
    expect(again.identity.nonce).toBe(nonce);
    expect(readFileSync(marker, 'utf8')).toBe('one');
    expect(await client.stop(nonce)).toBe(true);
    expect((await launchManagedRun(db, client, 1, 1, input)).execution.state).toBe('exited');
    // An unavailable old journal is not evidence that its execution never launched.
    const replacement = {
      hostInstance: 'replacement',
      status: vi.fn(async () => null),
      launch: vi.fn(),
    } as unknown as RunClient;
    await expect(launchManagedRun(db, replacement, 1, 1, input)).rejects.toThrow(
      /ownership is unknown/,
    );
    expect(replacement.launch).not.toHaveBeenCalled();
  } finally {
    if (nonce) await client.stop(nonce).catch(() => false);
    client.close();
    await host.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
