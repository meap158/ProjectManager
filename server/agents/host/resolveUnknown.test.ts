import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { openDb } from '../../db.js';
import { createApp } from '../../app.js';
import { reserveRunExecution } from '../runExecution.js';

it('requires explicit manual confirmation and the current nonce, retaining unverified outcome', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-resolve-unknown-'));
  const db = openDb(':memory:');
  const app = createApp(db, { dataDir: dir });
  const post = (body: unknown) =>
    app.request('/api/agent-runs/1/resolve-unknown', {
      method: 'POST',
      headers: { host: 'localhost:5180', 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  try {
    await app.supervisor.ready;
    db.prepare("INSERT INTO projects(id,name,path,created_at) VALUES(1,'Fixture',?,'now')").run(
      dir,
    );
    db.prepare(
      `INSERT INTO agent_runs(id,project_id,name,command_json,status,created_at,log_path,execution_state)
      VALUES(1,1,'Unknown','{"command":["fixture"]}','running','now',?,'unknown')`,
    ).run(path.join(dir, 'run.log'));
    const identity = reserveRunExecution(db, 1, { instance: 'absent', generation: 1, attempt: 1 });
    expect(app.supervisor.getRun(1)?.executionNonce).toBe(identity.nonce);
    expect((await post({ nonce: identity.nonce })).status).toBe(400);
    expect((await post({ nonce: randomUUID(), confirmation: 'worker-stopped' })).status).toBe(409);
    expect(app.supervisor.getRun(1)?.status).toBe('running');
    const response = await post({ nonce: identity.nonce, confirmation: 'worker-stopped' });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'failed',
      executionState: 'complete',
      validation: null,
      executionResolution: {
        source: 'manual-confirmation',
        nonce: identity.nonce,
        resolvedAt: expect.any(String),
      },
    });
    expect((await post({ nonce: identity.nonce, confirmation: 'worker-stopped' })).status).toBe(
      409,
    );
  } finally {
    await app.supervisor.shutdown();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
