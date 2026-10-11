import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { HostClient } from './client.js';
import { logicalSize } from '../logFile.js';
import { ptyAvailable } from '../proc.js';
import type { HostSessionInfo } from './protocol.js';

it.skipIf(!ptyAvailable())(
  'retains exited session metadata and supports respawning its key',
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-host-lifecycle-'));
    let client: HostClient | null = null;
    try {
      client = await HostClient.connect(dir);
      expect(client).not.toBeNull();
      const request = {
        op: 'spawn' as const,
        key: 'test-session',
        argv: [process.execPath, '-e', 'console.log("host-lifecycle"); process.exit(0)'],
        cwd: dir,
        env: process.env as Record<string, string>,
        cols: 80,
        rows: 24,
        logPath: path.join(dir, 'output.log'),
        maxLogBytes: 1024 * 1024,
      };
      const first = (await client!.request(request)) as HostSessionInfo;
      async function exited() {
        for (let i = 0; i < 100; i++) {
          const result = (await client!.list()).find((s) => s.key === request.key);
          if (result && !result.alive) return result;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error('Fixture PTY did not exit');
      }
      const done = await exited();
      expect(done.pid).toBe(first.pid);
      expect(done.exitCode).toBe(0);
      expect(done.logBytes).toBeGreaterThan(0);
      expect(await client!.request({ op: 'write', key: request.key, data: 'ignored' })).toBe(false);
      const second = (await client!.request(request)) as HostSessionInfo;
      expect(second.alive).toBe(true);
      await exited();
      await client!.request({ op: 'forget', key: request.key });
      expect(await client!.list()).toEqual([]);
    } finally {
      const pid = client?.hostPid;
      client?.close();
      // This is exclusively the temporary fixture's host, never the user's active host.
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          /* Already exited. */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20000,
);

it.skipIf(!ptyAvailable())(
  'keeps streaming and recording when a restarted session inherits a full log',
  async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-host-fulllog-'));
    const logPath = path.join(dir, 'output.log');
    // A long-lived TUI filled the log before the restart (the OpenCode blank-screen bug).
    writeFileSync(logPath, 'x'.repeat(8192));
    let client: HostClient | null = null;
    try {
      client = await HostClient.connect(dir);
      expect(client).not.toBeNull();
      let streamed = '';
      client!.on('data', (key, _offset, data) => {
        if (key === 'full-log') streamed += data;
      });
      await client!.request({
        op: 'spawn',
        key: 'full-log',
        argv: [process.execPath, '-e', 'console.log("alive-after-restore"); process.exit(0)'],
        cwd: dir,
        env: process.env as Record<string, string>,
        cols: 80,
        rows: 24,
        logPath,
        maxLogBytes: 8192,
      });
      let done: HostSessionInfo | undefined;
      for (let i = 0; i < 100 && !done; i++) {
        const s = (await client!.list()).find((x) => x.key === 'full-log');
        if (s && !s.alive) done = s;
        else await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(done).toBeDefined();
      expect(streamed).toContain('alive-after-restore');
      const file = readFileSync(logPath, 'utf8');
      expect(file).toContain('alive-after-restore');
      expect(file.length).toBeLessThanOrEqual(8192);
      // Offsets kept growing past the compacted head.
      expect(done!.logBytes).toBe(logicalSize(logPath));
      expect(done!.logBytes).toBeGreaterThan(8192);
    } finally {
      const pid = client?.hostPid;
      client?.close();
      if (pid) {
        try {
          process.kill(pid);
        } catch {
          /* Already exited. */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      rmSync(dir, { recursive: true, force: true });
    }
  },
  20000,
);
