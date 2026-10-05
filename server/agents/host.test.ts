// The session host keeps interactive sessions alive across server restarts. These tests drive a
// real host process (started on demand, like in production) through the public API.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { AgentSession } from '../../shared/types.js';
import { createApp } from '../app.js';
import { openDb } from '../db.js';
import { isAlive } from '../instance.js';
import { ptyAvailable } from './proc.js';
import { rendezvousFile } from './host/protocol.js';

const NODE = process.execPath;
const tmp = mkdtempSync(path.join(os.tmpdir(), 'pm-host-'));
const projectDir = path.join(tmp, 'proj');
mkdirSync(projectDir);
const dbs: ReturnType<typeof openDb>[] = [];

afterAll(() => {
  // Stop the host so the test leaves nothing behind.
  try {
    const { pid } = JSON.parse(readFileSync(rendezvousFile(tmp), 'utf8')) as { pid: number };
    process.kill(pid);
  } catch {
    // Already gone.
  }
  for (const db of dbs) db.close();
  // The killed host may still hold a log file for a moment on Windows; cleanup is best-effort.
  try {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Temp folder; the OS cleans it eventually.
  }
});

function boot() {
  const db = openDb(tmp);
  dbs.push(db);
  const app = createApp(db, { dataDir: tmp, agentHost: true });
  const call = (method: string, url: string, body?: unknown) =>
    app.request(`/api${url}`, {
      method,
      headers: {
        host: 'localhost:5180',
        ...(method === 'GET' || method === 'DELETE' ? {} : { 'content-type': 'application/json' }),
      },
      body: method === 'GET' || method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
    });
  return { app, call };
}

async function waitFor<T>(fn: () => Promise<T>, pred: (v: T) => boolean, label: string) {
  let last: T | undefined;
  for (let i = 0; i < 200; i++) {
    last = await fn();
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)?.slice(0, 400)}`);
}

describe.skipIf(!ptyAvailable())('session host', () => {
  it('keeps a session alive across a server restart, with output and input intact', async () => {
    // ---- first server ----
    let { app, call } = boot();
    const project = (await (await call('POST', '/projects', { path: projectDir })).json()) as {
      id: number;
    };
    const script =
      `let n=0;setInterval(()=>process.stdout.write('tick'+(n++)+'\\n'),300);` +
      `process.stdin.on('data',d=>process.stdout.write('got:'+String(d).trim()+'\\n'))`;
    const created = (await (
      await call('POST', `/projects/${project.id}/agent-sessions`, {
        providerId: 'custom',
        command: [NODE, '-e', script],
      })
    ).json()) as AgentSession;
    expect(created.status).toBe('running');
    expect(created.terminal).toBe('pty');
    const pid = created.pid!;
    const output = async () =>
      (
        (await (await call('GET', `/agent-sessions/${created.id}/output?after=0`)).json()) as {
          data: string;
        }
      ).data;
    await waitFor(output, (d) => d.includes('tick1'), 'first ticks');

    // ---- "server restart": the supervisor shuts down; the session must not ----
    await app.supervisor.shutdown();
    expect(isAlive(pid)).toBe(true);
    await new Promise((r) => setTimeout(r, 1200)); // Output keeps flowing into the log meanwhile.

    ({ app, call } = boot());
    await app.supervisor.ready;
    const after = (await (
      await call('GET', `/agent-sessions/${created.id}`)
    ).json()) as AgentSession;
    expect(after.status).toBe('running');
    expect(after.pid).toBe(pid); // Re-attached, not relaunched.
    expect(after.restarts).toBe(0);

    const before = await output();
    const lastTick = Number(before.match(/tick(\d+)(?![\s\S]*tick\d)/)?.[1]);
    // Live output resumes through the new server…
    await waitFor(output, (d) => d.includes(`tick${lastTick + 2}`), 'ticks after re-attach');
    // …with no relaunch banner (nothing was restarted).
    expect(await output()).not.toContain('relaunched');
    // …and input reaches the same process.
    await call('POST', `/agent-sessions/${created.id}/input`, { data: 'ping\r' });
    await waitFor(output, (d) => d.includes('got:ping'), 'input after re-attach');

    // ---- stopping on purpose really stops it ----
    await call('POST', `/agent-sessions/${created.id}/stop`);
    await waitFor(
      async () =>
        ((await (await call('GET', `/agent-sessions/${created.id}`)).json()) as AgentSession)
          .status,
      (status) => status === 'killed',
      'killed',
    );
    await waitFor(
      async () => isAlive(pid),
      (alive) => !alive,
      'process gone',
    );
    await app.supervisor.shutdown();
  }, 60_000);
});
