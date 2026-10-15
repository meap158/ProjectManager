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
type Response = {
  id?: number;
  ok: boolean;
  error?: string;
  result?: { state?: string; data?: string; capabilities?: string[] };
};

it('requires authentication and replays real pipe execution over bounded local requests', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pm-run-server-'));
  const journal = new RunJournal(path.join(dir, 'journal.db'), 'host');
  const launcher = new RunLauncher(journal, path.join(dir, 'logs'));
  const token = randomUUID();
  const host = createRunServer(token, launcher, journal);
  const address =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\pm-run-test-${randomUUID()}`
      : path.join(dir, 'host.sock');
  let client: net.Socket | undefined;
  try {
    host.server.listen(address);
    await once(host.server, 'listening');
    const unauthorized = net.connect(address);
    await once(unauthorized, 'connect');
    unauthorized.write(JSON.stringify({ id: 1, op: 'stop', nonce: 'attempt' }) + '\n');
    await once(unauthorized, 'close');
    expect(journal.get('attempt')).toBeNull();
    const wrong = net.connect(address);
    await once(wrong, 'connect');
    wrong.write(JSON.stringify({ id: 1, op: 'hello', token: 'wrong' }) + '\n');
    await once(wrong, 'close');
    const oversized = net.connect(address);
    await once(oversized, 'connect');
    oversized.on('error', () => {});
    oversized.write('x'.repeat(256 * 1024 + 1));
    await new Promise<void>((resolve) => oversized.once('close', () => resolve()));

    client = net.connect(address);
    client.setEncoding('utf8');
    await once(client, 'connect');
    let buffer = '';
    const responses: ((value: Response) => void)[] = [];
    client.on('data', (data: string) => {
      buffer += data;
      let n;
      while ((n = buffer.indexOf('\n')) >= 0) {
        const value = JSON.parse(buffer.slice(0, n));
        buffer = buffer.slice(n + 1);
        responses.shift()!(value);
      }
    });
    const send = (message: unknown) =>
      new Promise<Response>((resolve) => {
        responses.push(resolve);
        client!.write(JSON.stringify(message) + '\n');
      });
    expect(await send({ id: 1, op: 'hello', token })).toMatchObject({
      ok: true,
      result: { capabilities: ['pipe-runs-v1'] },
    });
    const marker = path.join(dir, 'launches.txt');
    const launch = {
      id: 2,
      op: 'launch',
      nonce: 'attempt',
      cwd: dir,
      env: { ...process.env },
      argv: [
        process.execPath,
        '-e',
        `require('node:fs').appendFileSync(${JSON.stringify(marker)},'one'); console.log('done');`,
      ],
    };
    expect(await send(launch)).toMatchObject({ ok: true });
    expect(await send({ ...launch, id: 3 })).toMatchObject({ ok: true });
    await expect
      .poll(async () => (await send({ id: 4, op: 'status', nonce: 'attempt' })).result?.state)
      .toBe('exited');
    expect((await send({ id: 5, op: 'read', nonce: 'attempt', after: 0 })).result?.data).toContain(
      'done',
    );
    expect(readFileSync(marker, 'utf8')).toBe('one');
    expect(await send({ id: 6, op: 'read', nonce: 'attempt', after: -1 })).toMatchObject({
      ok: false,
      error: 'Invalid run host request',
    });
  } finally {
    client?.destroy();
    host.disconnect();
    await new Promise<void>((resolve) => host.server.close(() => resolve()));
    await launcher.stop('attempt');
    journal.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
