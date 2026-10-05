import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { claimInstance, readInstance, releaseInstance, type InstanceInfo } from './instance.js';

let dir: string;
let other: ChildProcess;

beforeAll(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'pm-instance-'));
  // A live process standing in for "another ProjectManager server".
  other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
});
afterAll(() => {
  other.kill();
  rmSync(dir, { recursive: true, force: true });
});

const me = (owner = process.pid): InstanceInfo => ({
  pid: process.pid,
  owner,
  url: 'http://localhost:59999',
  startedAt: new Date().toISOString(),
});
const record = (info: Partial<InstanceInfo>) =>
  writeFileSync(
    path.join(dir, 'server.json'),
    JSON.stringify({ ...me(), startedAt: new Date().toISOString(), ...info }),
  );

describe('single instance per data folder', () => {
  it('claims a free folder and releases only its own record', async () => {
    expect(await claimInstance(dir, me())).toBeNull();
    expect(readInstance(dir)?.pid).toBe(process.pid);
    releaseInstance(dir, 12345); // Not ours: kept.
    expect(readInstance(dir)).not.toBeNull();
    releaseInstance(dir, process.pid);
    expect(readInstance(dir)).toBeNull();
  });

  it('yields to another live server that is starting up', async () => {
    record({ pid: other.pid!, owner: other.pid! });
    const found = await claimInstance(dir, me());
    expect(found?.pid).toBe(other.pid);
    expect(readInstance(dir)?.pid).toBe(other.pid); // Untouched.
  });

  it('takes over a stale record from a dead process', async () => {
    record({ pid: 999_999, owner: 999_999 });
    expect(await claimInstance(dir, me())).toBeNull();
    expect(readInstance(dir)?.pid).toBe(process.pid);
  });

  it('takes over its own previous incarnation (same launcher), e.g. a dev restart', async () => {
    record({ pid: other.pid!, owner: 4242 });
    expect(await claimInstance(dir, me(4242))).toBeNull();
    expect(readInstance(dir)?.owner).toBe(4242);
  });

  it('treats an old record whose server no longer answers as stale (PID reuse)', async () => {
    record({ pid: other.pid!, owner: other.pid!, startedAt: '2020-01-01T00:00:00.000Z' });
    expect(await claimInstance(dir, me())).toBeNull();
  });
});
