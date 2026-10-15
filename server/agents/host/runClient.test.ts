import net from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { RunJournal } from './runJournal.js';
import { RunLauncher } from './runLauncher.js';
import { createRunServer } from './runServer.js';
import { RunClient } from './runClient.js';

it('reconnects to the same live execution without relaunching and preserves stop/output controls', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-client-'));
  const journal = new RunJournal(path.join(dir, 'journal.db'), 'host-identity');
  const launcher = new RunLauncher(journal, path.join(dir, 'logs'));
  const token = randomUUID(),
    host = createRunServer(token, launcher, journal);
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\pm-run-client-${randomUUID()}`
      : path.join(dir, 'host.sock');
  let first: RunClient | undefined, second: RunClient | undefined;
  try {
    host.server.listen(address);
    await once(host.server, 'listening');
    await expect(RunClient.connect(address, 'wrong', 1000)).rejects.toThrow(/disconnected/);
    first = await RunClient.connect(address, token);
    expect(first.hostInstance).toBe('host-identity');
    const marker = path.join(dir, 'launches');
    const input = {
      nonce: 'one',
      cwd: dir,
      env: { ...process.env } as Record<string, string>,
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'one');console.log('ready');setTimeout(()=>{},10000)`,
      ],
    };
    await first.launch(input);
    await expect.poll(async () => (await first!.read('one', 0))?.data).toContain('ready');
    first.close();
    second = await RunClient.connect(address, token);
    expect(await second.launch(input)).toMatchObject({ nonce: 'one', state: 'running' });
    expect(readFileSync(marker, 'utf8')).toBe('one');
    expect(await second.stop('one')).toBe(true);
    expect(await second.status('one')).toMatchObject({ state: 'exited' });
    expect((await second.read('one', 0))?.data).toContain('ready');
    expect(await second.status('missing')).toBeNull();
  } finally {
    first?.close();
    second?.close();
    host.disconnect();
    await new Promise<void>((resolve) => host.server.close(() => resolve()));
    await launcher.stop('one');
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

it.each(['unsupported', 'silent'])('rejects a %s host without attempting launch', async (mode) => {
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\pm-run-invalid-${randomUUID()}`
      : path.join(tmpdir(), `pm-run-${randomUUID()}.sock`);
  const sockets = new Set<net.Socket>();
  let received = '';
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('data', (data) => {
      received += String(data);
      if (mode === 'unsupported')
        socket.write(
          JSON.stringify({
            id: 1,
            ok: true,
            result: { version: 1, instance: 'old', capabilities: [] },
          }) + '\n',
        );
    });
  });
  try {
    server.listen(address);
    await once(server, 'listening');
    await expect(RunClient.connect(address, randomUUID(), 200)).rejects.toThrow(
      mode === 'unsupported' ? /capability unavailable/ : /disconnected/,
    );
    expect(received).toContain('hello');
    expect(received).not.toContain('launch');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
