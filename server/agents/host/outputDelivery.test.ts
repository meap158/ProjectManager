import { expect, it } from 'vitest';
import { OutputDelivery, OUTPUT_BACKLOG_BYTES } from './outputDelivery.js';
import { OutputLog } from '../supervisor.js';
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { HostMessage } from './protocol.js';

it('coalesces thousands of persisted events and replays exact disk bytes after drain', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-delivery-'));
  try {
    const messages: HostMessage[] = [];
    const socket = {
      writableLength: OUTPUT_BACKLOG_BYTES,
      write: (data: string) => messages.push(JSON.parse(data)),
    };
    const delivery = new OutputDelivery(socket);
    let notifications = 0;
    const log = new OutputLog(path.join(dir, 'log'), () => notifications++);
    const text = '😀line\n'.repeat(10000);
    appendFileSync(log.file, text);
    let offset = 0;
    for (let i = 0; i < 10000; i++) {
      delivery.send({ ev: 'data', key: 'session', offset, data: '😀line\n' }, true);
      offset += Buffer.byteLength('😀line\n');
    }
    expect(messages).toHaveLength(0);
    socket.writableLength = 0;
    delivery.flush();
    expect(messages).toEqual([{ ev: 'data', key: 'session', offset, data: '' }]);
    log.ingest(offset, '');
    expect(notifications).toBe(1);
    expect(log.read(0)).toEqual({ data: text, nextOffset: offset });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
it('preserves live order, exit delivery, and bytes that were not persisted', () => {
  const messages: HostMessage[] = [];
  const socket = { writableLength: 0, write: (data: string) => messages.push(JSON.parse(data)) };
  const delivery = new OutputDelivery(socket);
  delivery.send({ ev: 'data', key: 'a', offset: 0, data: 'first' }, true);
  socket.writableLength = OUTPUT_BACKLOG_BYTES;
  delivery.send({ ev: 'data', key: 'a', offset: 5, data: 'saved' }, true);
  delivery.send({ ev: 'data', key: 'a', offset: 10, data: 'unsaved' });
  delivery.send({ ev: 'exit', key: 'a', exitCode: 0, signal: null });
  expect(messages).toEqual([
    { ev: 'data', key: 'a', offset: 0, data: 'first' },
    { ev: 'data', key: 'a', offset: 10, data: '' },
    { ev: 'data', key: 'a', offset: 10, data: 'unsaved' },
    { ev: 'exit', key: 'a', exitCode: 0, signal: null },
  ]);
});
