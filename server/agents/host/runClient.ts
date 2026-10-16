import net from 'node:net';
import { z } from 'zod';
import type { RunCommand } from './runServer.js';
import type { PipeRunLaunch } from './runLauncher.js';

const run = z.object({
  nonce: z.string(),
  fingerprint: z.string(),
  hostInstance: z.string(),
  state: z.enum(['claimed', 'running', 'exited', 'unknown']),
  pid: z.number().int().positive().nullable(),
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  outputPath: z.string().nullable(),
});
const output = z.object({
  data: z.string().max(128 * 1024),
  nextOffset: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
});

/** Explicit reconnect/replay only: losing a reply never automatically launches new work. */
export class RunClient {
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private nextId = 1;
  private buffer = '';
  private closed = false;
  private instance = '';
  private capabilities = new Set<string>();
  private constructor(
    private socket: net.Socket,
    private timeoutMs: number,
  ) {
    socket.setEncoding('utf8');
    socket.on('error', () => this.close());
    socket.on('close', () => this.close());
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      if (Buffer.byteLength(this.buffer) > 1024 * 1024) {
        this.close();
        return;
      }
      let newline: number;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        const parsed = z
          .object({
            id: z.number().int().positive(),
            ok: z.boolean(),
            result: z.unknown().optional(),
            error: z.string().optional(),
          })
          .safeParse(safeJson(line));
        if (!parsed.success) {
          this.close();
          return;
        }
        const message = parsed.data,
          pending = this.pending.get(message.id);
        if (!pending) continue;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.ok) pending.resolve(message.result);
        else pending.reject(new Error(message.error ?? 'Run host request failed'));
      }
    });
  }
  static async connect(address: string, token: string, timeoutMs = 10000): Promise<RunClient> {
    const client = new RunClient(net.connect(address), timeoutMs);
    try {
      const hello = z
        .object({
          version: z.literal(1),
          instance: z.string().min(1),
          capabilities: z.array(z.string()),
        })
        .parse(await client.call({ op: 'hello', token }));
      if (
        !['pipe-runs-v1', 'shared-run-log-v1'].every((capability) =>
          hello.capabilities.includes(capability),
        )
      )
        throw new Error('Run host capability unavailable');
      client.instance = hello.instance;
      client.capabilities = new Set(hello.capabilities);
      return client;
    } catch (error) {
      client.close();
      throw error;
    }
  }
  get hostInstance(): string {
    return this.instance;
  }
  async launch(input: PipeRunLaunch) {
    return run.parse(await this.call({ op: 'launch', ...input }));
  }
  async status(nonce: string) {
    return run.nullable().parse(await this.call({ op: 'status', nonce }));
  }
  async read(nonce: string, after: number) {
    return output.nullable().parse(await this.call({ op: 'read', nonce, after }));
  }
  async refreshCpuBudget(threads: number) {
    if (!this.capabilities.has('cpu-budget-refresh-v1'))
      throw new Error('Run host CPU refresh capability unavailable');
    return z
      .object({ owned: z.number().int().nonnegative(), updated: z.number().int().nonnegative() })
      .parse(await this.call({ op: 'cpu-budget', threads }));
  }
  async stop(nonce: string) {
    return z.boolean().parse(await this.call({ op: 'stop', nonce }));
  }
  private call(command: RunCommand | { op: 'hello'; token: string }): Promise<unknown> {
    if (this.closed)
      return Promise.reject(new Error('Run host disconnected; execution state may be unknown'));
    if (this.pending.size >= 8)
      return Promise.reject(new Error('Too many pending run host requests'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.close(), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ ...command, id }) + '\n');
    });
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Run host disconnected; execution state may be unknown'));
    }
    this.pending.clear();
  }
}
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
