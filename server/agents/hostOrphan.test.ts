// Closing ProjectManager, even abruptly, must not leave agent CLIs running unseen: the session
// host ends every session once no server has been attached for a while, then exits.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentSession } from '../../shared/types.js';
import { createApp } from '../app.js';
import { openDb } from '../db.js';
import { isAlive } from '../instance.js';
import { ptyAvailable } from './proc.js';
import { HOST_GENERATION, rendezvousFile } from './host/protocol.js';

process.env.PM_HOST_ORPHAN_MS = '1500'; // Inherited by the host this file starts.

const tmp = mkdtempSync(path.join(os.tmpdir(), 'pm-orphan-'));
const projectDir = path.join(tmp, 'proj');
mkdirSync(projectDir);
const db = openDb(tmp);

afterAll(() => {
  db.close();
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Temp folder; the OS cleans it eventually.
  }
});

async function until(pred: () => boolean, label: string, ms = 20_000) {
  for (const start = Date.now(); Date.now() - start < ms;) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe.skipIf(!ptyAvailable())('orphaned session host', () => {
  it('ends every session and exits once no server is attached', async () => {
    const app = createApp(db, { dataDir: tmp, agentHost: true });
    const call = (method: string, url: string, body?: unknown) =>
      app.request(`/api${url}`, {
        method,
        headers: { host: 'localhost:5180', 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
    const project = (await (await call('POST', '/projects', { path: projectDir })).json()) as {
      id: number;
    };
    const session = (await (
      await call('POST', `/projects/${project.id}/agent-sessions`, {
        providerId: 'custom',
        command: [process.execPath, '-e', 'setInterval(()=>{},1000)'],
      })
    ).json()) as AgentSession;
    expect(session.terminal).toBe('pty');
    const hostPid = (
      JSON.parse(readFileSync(rendezvousFile(tmp, HOST_GENERATION), 'utf8')) as { pid: number }
    ).pid;
    expect(isAlive(session.pid!)).toBe(true);

    // The server goes away (like a closed window) without stopping the session.
    await app.supervisor.shutdown();
    expect(isAlive(session.pid!)).toBe(true);

    await until(() => !isAlive(session.pid!), 'session to end');
    await until(() => !isAlive(hostPid), 'host to exit');
    // The session is still wanted, so the next start relaunches it.
    expect(app.supervisor.getSession(session.id)?.desiredState).toBe('running');
  }, 40_000);
});
