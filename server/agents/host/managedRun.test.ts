import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { AgentSupervisor } from '../supervisor.js';
import { openDb } from '../../db.js';
import { startRunHost } from './runDaemon.js';
import { RunClient } from './runClient.js';
import { recoverManagedRuns, stopManagedRun } from './recoverRuns.js';
import { launchManagedRun, observeManagedRun } from './managedRun.js';

it('binds a run attempt before real launch and reattaches without another worker', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-managed-run-'));
  const db = openDb(':memory:');
  const host = await startRunHost(dir);
  const client = await RunClient.connect(host.connection.address, host.connection.token);
  let nonce: string | undefined;
  let supervisor: AgentSupervisor | undefined;
  try {
    db.prepare("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture',?,'now')").run(
      dir,
    );
    db.exec(`INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path,orchestrator_id)
      VALUES(1,1,'Managed','{"command":["fixture"]}','queued','now','/managed.log','master');`);
    const actualLog = path.join(dir, 'managed.log');
    db.prepare('UPDATE agent_runs SET log_path=? WHERE id=1').run(actualLog);
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
    expect(readFileSync(actualLog, 'utf8')).toContain('ready');
    expect(again.execution.outputPath).toBe(actualLog);
    expect(await observeManagedRun(client, first.identity, 0)).toMatchObject({
      phase: 'active',
      outcome: null,
      output: { data: expect.stringContaining('ready') },
    });
    supervisor = new AgentSupervisor(db, path.join(dir, 'supervisor-logs'), { dataDir: dir });
    await supervisor.ready;
    expect(
      db.prepare('SELECT status,execution_state,attempts FROM agent_runs WHERE id=1').get(),
    ).toMatchObject({ status: 'running', execution_state: 'active', attempts: 1 });
    const writes = () => (db.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
    const activeWrites = writes();
    const outputChanged = vi.fn();
    await recoverManagedRuns(db, dir, () => true, outputChanged);
    await recoverManagedRuns(db, dir, () => true, outputChanged);
    expect(writes()).toBe(activeWrites);
    expect(outputChanged).toHaveBeenCalledTimes(2);
    db.exec("UPDATE agent_runs SET execution_state='unknown' WHERE id=1");
    await expect(supervisor.resolveUnknownRun(1, nonce)).rejects.toThrow('no longer unknown');
    expect(supervisor.getRun(1)).toMatchObject({ status: 'running', executionState: 'active' });
    await supervisor!.stopRun(1);
    await supervisor!.shutdown();
    supervisor = undefined;
    expect(
      db.prepare('SELECT status,execution_state FROM agent_runs WHERE id=1').get(),
    ).toMatchObject({ status: 'killed', execution_state: 'complete' });
    expect(readFileSync(marker, 'utf8')).toBe('one');
    expect(await observeManagedRun(client, first.identity, 0)).toMatchObject({
      phase: 'complete',
      outcome: 'failed',
    });
    const lost = await RunClient.connect(host.connection.address, host.connection.token);
    lost.close();
    expect(await observeManagedRun(lost, first.identity, 0)).toMatchObject({
      phase: 'unknown',
      outcome: null,
    });

    db.exec("UPDATE agent_runs SET status='running',execution_state='active' WHERE id=1");
    await recoverManagedRuns(
      db,
      dir,
      () => true,
      () => {},
    );
    expect(
      db.prepare('SELECT status,execution_state FROM agent_runs WHERE id=1').get(),
    ).toMatchObject({ status: 'failed', execution_state: 'complete' });
    db.exec("UPDATE agent_runs SET status='running',execution_state='active' WHERE id=1");
    await recoverManagedRuns(
      db,
      null,
      () => true,
      () => {},
    );
    expect(
      db.prepare('SELECT status,execution_state FROM agent_runs WHERE id=1').get(),
    ).toMatchObject({ status: 'running', execution_state: 'unknown' });
    const unknownWrites = writes();
    await recoverManagedRuns(
      db,
      null,
      () => true,
      () => {},
    );
    expect(writes()).toBe(unknownWrites);
    await expect(stopManagedRun(db, null, 1, actualLog)).rejects.toThrow();
    expect(
      db.prepare('SELECT status,execution_state FROM agent_runs WHERE id=1').get(),
    ).toMatchObject({ status: 'running', execution_state: 'unknown' });
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
    await supervisor?.shutdown();
    if (nonce) await client.stop(nonce).catch(() => false);
    client.close();
    await host.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it('drains bounded output before completion and refuses mismatched output ownership', async () => {
  const identity = {
    nonce: 'n',
    runId: 1,
    runLogPath: path.resolve('fixture.log'),
    attempt: 1,
    fingerprint: 'f',
    hostInstance: 'host',
    hostGeneration: 1,
    dispatchKey: null,
    orchestratorId: null,
    createdAt: 0,
  };
  const status = vi.fn(async () => ({
    nonce: 'n',
    hostInstance: 'host',
    state: 'exited',
    exitCode: 0,
    outputPath: identity.runLogPath,
  }));
  const read = vi.fn(async () => ({ data: 'page', nextOffset: 128, totalBytes: 256 }));
  const client = { status, read } as unknown as RunClient;
  expect(await observeManagedRun(client, identity, 0)).toMatchObject({
    phase: 'draining',
    outcome: null,
  });
  read.mockResolvedValueOnce({ data: 'tail', nextOffset: 256, totalBytes: 256 });
  expect(await observeManagedRun(client, identity, 128)).toMatchObject({
    phase: 'complete',
    outcome: 'succeeded',
  });
  status.mockResolvedValueOnce({
    nonce: 'n',
    hostInstance: 'host',
    state: 'exited',
    exitCode: 0,
    outputPath: path.resolve('other.log'),
  });
  read.mockClear();
  expect(await observeManagedRun(client, identity, 0)).toMatchObject({
    phase: 'unknown',
    outcome: null,
  });
  expect(read).not.toHaveBeenCalled();
});
