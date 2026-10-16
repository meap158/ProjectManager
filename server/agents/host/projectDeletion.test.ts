import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openDb } from '../../db.js';
import { createApp } from '../../app.js';
import { deleteProject } from '../../store.js';
import { startRunHost } from './runDaemon.js';
import { RunClient } from './runClient.js';
import { launchManagedRun } from './managedRun.js';

it.each([true, false])(
  'project deletion requires confirmed host termination (reachable=%s)',
  async (reachable) => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pm-project-delete-'));
    const db = openDb(':memory:');
    const host = await startRunHost(dir);
    const client = await RunClient.connect(host.connection.address, host.connection.token);
    const app = createApp(db, { dataDir: reachable ? dir : path.join(dir, 'offline') });
    let nonce: string | undefined;
    try {
      await app.supervisor.ready;
      db.prepare("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture',?,'now')").run(
        dir,
      );
      db.prepare(
        `INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path)
      VALUES(1,1,'Worker','{"command":["fixture"]}','queued','now',?)`,
      ).run(path.join(dir, 'worker.log'));
      const launched = await launchManagedRun(db, client, 1, 1, {
        cwd: dir,
        env: { ...process.env } as Record<string, string>,
        argv: [process.execPath, '-e', "console.log('ready');setInterval(()=>{},1000)"],
      });
      nonce = launched.identity.nonce;
      await expect.poll(async () => (await client.read(nonce!, 0))?.data).toContain('ready');
      // The storage fence also protects callers that bypass the HTTP preflight.
      expect(deleteProject(db, 1)).toBe(false);
      const response = await app.request('/api/projects/1', {
        method: 'DELETE',
        headers: { host: 'localhost:5180' },
      });
      if (reachable) {
        expect(response.status).toBe(204);
        expect((await client.status(nonce))?.state).toBe('exited');
        expect(db.prepare('SELECT id FROM projects WHERE id=1').get()).toBeUndefined();
        expect(
          db.prepare('SELECT run_id FROM agent_run_executions WHERE nonce=?').get(nonce),
        ).toMatchObject({ run_id: null });
      } else {
        expect(response.status).toBe(409);
        expect(await response.text()).toContain('Stop unconfirmed');
        expect(db.prepare('SELECT id FROM projects WHERE id=1').get()).toMatchObject({ id: 1 });
        expect(
          db.prepare('SELECT status,execution_state FROM agent_runs WHERE id=1').get(),
        ).toMatchObject({ status: 'queued', execution_state: 'unknown' });
        expect((await client.status(nonce))?.state).toBe('running');
        expect(deleteProject(db, 1)).toBe(false);
      }
    } finally {
      await app.supervisor.shutdown();
      if (nonce) await client.stop(nonce).catch(() => false);
      client.close();
      await host.shutdown();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  15000,
);
