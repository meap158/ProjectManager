import type { HostMessage } from './protocol.js';

export const OUTPUT_BACKLOG_BYTES = 256 * 1024;
interface OutputSocket {
  readonly writableLength: number;
  write(data: string): unknown;
}
/** Coalesce only disk-backed output; control messages and unsaved bytes are never dropped. */
export class OutputDelivery {
  private pending = new Map<string, number>();
  constructor(private socket: OutputSocket) {}
  send(message: HostMessage, persisted = false): void {
    if (
      'ev' in message &&
      message.ev === 'data' &&
      persisted &&
      this.socket.writableLength >= OUTPUT_BACKLOG_BYTES
    ) {
      this.pending.set(message.key, message.offset + Buffer.byteLength(message.data));
      return;
    }
    this.flush();
    this.socket.write(JSON.stringify(message) + '\n');
  }
  flush(): void {
    for (const [key, offset] of this.pending) {
      // Existing data protocol: a forward offset with no text invalidates the memory
      // window and wakes readers, which replay the exact skipped range from disk.
      this.socket.write(JSON.stringify({ ev: 'data', key, offset, data: '' }) + '\n');
    }
    this.pending.clear();
  }
}
