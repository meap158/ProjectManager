import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { openDb } from '../../db.js';
import { AgentSupervisor } from '../supervisor.js';
import { startRunHost, readRunRendezvous } from './runDaemon.js';
import { RunClient } from './runClient.js';
import { launchManagedRun } from './managedRun.js';

// Unix stale sockets intentionally refuse replacement; that platform needs a separate case.
it.skipIf(process.platform !== 'win32')(
  'a crashed real host leaves its surviving worker unknown and blocks duplicate dispatch',
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-host-crash-'));
    const db = openDb(path.join(dir, 'db'));
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
    let replacement: Awaited<ReturnType<typeof startRunHost>> | undefined;
    let supervisor: AgentSupervisor | undefined;
    let workerPid: number | undefined;
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
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
      const original = readRunRendezvous(dir);
      client = await RunClient.connect(original.address, original.token);
      db.prepare("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture',?,'now')").run(
        dir,
      );
      const marker = path.join(dir, 'launches');
      const logPath = path.join(dir, 'worker.log');
      const input = {
        cwd: dir,
        env: { ...process.env } as Record<string, string>,
        argv: [
          process.execPath,
          '-e',
          `require('node:fs').appendFileSync(${JSON.stringify(marker)},JSON.stringify({pid:process.pid})+String.fromCharCode(10));console.log('ready');setInterval(()=>{},1000)`,
        ],
      };
      db.prepare(
        `INSERT INTO agent_runs(id,project_id,name,command_json,status,attempts,max_attempts,created_at,log_path)
      VALUES(1,1,'Survivor',?,'running',1,1,'now',?)`,
      ).run(JSON.stringify({ command: input.argv, timeoutMs: 15000 }), logPath);
      const first = await launchManagedRun(db, client, 1, 1, input);
      await expect
        .poll(async () => (await client!.read(first.identity.nonce, 0))?.data, { timeout: 10000 })
        .toContain('ready');
      workerPid = JSON.parse(readFileSync(marker, 'utf8').trim()).pid;
      expect(workerPid).toBeGreaterThan(0);
      expect(workerPid).not.toBe(process.pid);
      const exited = once(daemon, 'exit');
      daemon.kill('SIGKILL');
      await exited;
      client.close();
      expect(alive(workerPid!)).toBe(true);
      replacement = await startRunHost(dir);
      client = await RunClient.connect(
        replacement.connection.address,
        replacement.connection.token,
      );
      expect(await client.status(first.identity.nonce)).toMatchObject({
        state: 'unknown',
        hostInstance: original.instance,
      });
      expect((await launchManagedRun(db, client, 1, 1, input)).execution.state).toBe('unknown');
      db.prepare(
        `INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path)
      VALUES(2,1,'Queued',?,'queued','now',?)`,
      ).run(
        JSON.stringify({
          command: [
            process.execPath,
            '-e',
            `require('node:fs').appendFileSync(${JSON.stringify(marker)},'DUPLICATE')`,
          ],
          timeoutMs: 10000,
        }),
        path.join(dir, 'queued.log'),
      );
      supervisor = new AgentSupervisor(db, path.join(dir, 'logs'), {
        dataDir: dir,
        managedRuns: true,
        maxParallelRuns: 1,
      });
      await supervisor.ready;
      expect(supervisor.getRun(1)).toMatchObject({
        status: 'running',
        executionState: 'unknown',
        attempts: 1,
        validation: null,
      });
      expect(supervisor.getRun(2)?.status).toBe('queued');
      expect(() => supervisor!.retryRun(1)).toThrow('still active');
      await expect(supervisor.stopRun(1)).rejects.toThrow('Stop unconfirmed');
      expect(supervisor.getRun(1)).toMatchObject({ status: 'running', executionState: 'unknown' });
      expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(alive(workerPid!)).toBe(true);
    } finally {
      await supervisor?.shutdown();
      client?.close();
      await replacement?.shutdown();
      if (daemon.exitCode === null && daemon.signalCode === null) {
        const exit = once(daemon, 'exit');
        daemon.kill('SIGKILL');
        await exit;
      }
      // This isolated fixture worker's independently written PID is used only for teardown.
      if (workerPid && workerPid !== process.pid && alive(workerPid)) {
        process.kill(workerPid, 'SIGKILL');
        await expect.poll(() => alive(workerPid!), { timeout: 10000 }).toBe(false);
      }
      db.close();
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
  },
  30000,
);
