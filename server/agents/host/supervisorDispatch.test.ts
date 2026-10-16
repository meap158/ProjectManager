import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { openDb } from '../../db.js';
import { AgentSupervisor } from '../supervisor.js';
import { startRunHost, runRendezvousFile } from './runDaemon.js';
import { RunClient } from './runClient.js';

it.each([true, false, 'lost-reply'] as const)(
  'opt-in supervisor uses hosted ownership without local fallback (authenticated=%s)',
  async (authenticated) => {
    const lostReply = authenticated === 'lost-reply';
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-supervisor-dispatch-'));
    const db = openDb(':memory:');
    const host = await startRunHost(dir);
    const client = await RunClient.connect(host.connection.address, host.connection.token);
    let supervisor: AgentSupervisor | undefined;
    let nonce: string | undefined;
    try {
      if (authenticated === false)
        writeFileSync(
          runRendezvousFile(dir),
          JSON.stringify({ ...host.connection, token: 'wrong-token' }),
        );
      db.prepare("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture',?,'now')").run(
        dir,
      );
      const marker = path.join(dir, 'launches');
      db.prepare(
        `INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path)
      VALUES(1,1,'Worker',?,'queued','now',?)`,
      ).run(
        JSON.stringify({
          command: [
            process.execPath,
            '-e',
            `require('node:fs').appendFileSync(${JSON.stringify(marker)},'one');console.log('ready');setInterval(()=>{},1000)`,
          ],
          timeoutMs: 10000,
        }),
        path.join(dir, 'worker.log'),
      );
      if (lostReply) {
        const launch = RunClient.prototype.launch;
        vi.spyOn(RunClient.prototype, 'launch').mockImplementationOnce(async function (input) {
          await launch.call(this, input);
          throw new Error('fixture lost launch acknowledgment');
        });
      }
      supervisor = new AgentSupervisor(db, path.join(dir, 'logs'), {
        dataDir: dir,
        managedRuns: true,
      });
      await supervisor.ready;
      await expect
        .poll(() => supervisor!.getRun(1)?.status)
        .toBe(authenticated ? 'running' : 'failed');
      if (authenticated) {
        const identity = db
          .prepare('SELECT nonce FROM agent_run_executions WHERE run_id=1')
          .get() as { nonce: string };
        nonce = identity.nonce;
        await expect.poll(async () => (await client.read(nonce!, 0))?.data).toContain('ready');
        expect(readFileSync(marker, 'utf8')).toBe('one');
        expect(supervisor.getRun(1)).toMatchObject({
          attempts: 1,
          executionState: lostReply ? 'unknown' : 'active',
        });
        await supervisor.shutdown();
        expect((await client.status(nonce))?.state).toBe('running');
        supervisor = new AgentSupervisor(db, path.join(dir, 'logs'), {
          dataDir: dir,
          managedRuns: true,
        });
        await supervisor.ready;
        expect(supervisor.getRun(1)).toMatchObject({
          status: 'running',
          attempts: 1,
          executionState: 'active',
        });
        expect(readFileSync(marker, 'utf8')).toBe('one');
        await supervisor.stopRun(1);
        expect((await client.status(nonce))?.state).toBe('exited');
      } else {
        expect(existsSync(marker)).toBe(false);
        expect(db.prepare('SELECT COUNT(*) AS n FROM agent_run_executions').get()).toMatchObject({
          n: 0,
        });
        expect(supervisor.getRun(1)?.error).toContain('Hosted runtime unavailable');
      }
    } finally {
      vi.restoreAllMocks();
      await supervisor?.shutdown();
      if (nonce) await client.stop(nonce).catch(() => false);
      client.close();
      writeFileSync(runRendezvousFile(dir), JSON.stringify(host.connection));
      await host.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
