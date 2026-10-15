import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { RunLauncher } from './runLauncher.js';
import { RunJournal } from './runJournal.js';

const nonce = z.string().min(1).max(128);
const request = z.discriminatedUnion('op', [
  z
    .object({
      id: z.number().int().positive(),
      op: z.literal('launch'),
      nonce,
      argv: z.array(z.string().max(20000)).min(1).max(1024),
      cwd: z.string().min(1).max(32768),
      env: z.record(z.string(), z.string().max(32768)),
      timeoutMs: z.number().int().min(1).max(14400000).optional(),
    })
    .strict(),
  z.object({ id: z.number().int().positive(), op: z.literal('status'), nonce }).strict(),
  z
    .object({
      id: z.number().int().positive(),
      op: z.literal('read'),
      nonce,
      after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    })
    .strict(),
  z.object({ id: z.number().int().positive(), op: z.literal('stop'), nonce }).strict(),
]);

type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
export type RunCommand = WithoutId<z.infer<typeof request>>;

/** Authenticated, bounded local transport; callers own listening address and journal lifetime. */
export function createRunServer(token: string, launcher: RunLauncher, journal: RunJournal) {
  if (Buffer.byteLength(token) < 32)
    throw new Error('Run host token must contain at least 32 bytes');
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    if (sockets.size >= 16) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setEncoding('utf8');
    socket.setTimeout(30000, () => socket.destroy());
    let authed = false,
      buffer = '',
      pending = 0;
    let chain = Promise.resolve();
    const send = (value: unknown) => {
      if (socket.destroyed) return;
      if (socket.writableLength > 256 * 1024) {
        socket.destroy();
        return;
      }
      socket.write(JSON.stringify(value) + '\n');
    };
    const handle = async (line: string) => {
      if (socket.destroyed) return;
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        socket.destroy();
        return;
      }
      if (!authed) {
        const hello = z
          .object({
            id: z.number().int().positive(),
            op: z.literal('hello'),
            token: z.string().max(1024),
          })
          .strict()
          .safeParse(raw);
        if (!hello.success) {
          socket.destroy();
          return;
        }
        const candidate = Buffer.from(hello.data.token),
          expected = Buffer.from(token);
        if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected)) {
          socket.destroy();
          return;
        }
        authed = true;
        send({
          id: hello.data.id,
          ok: true,
          result: { version: 1, instance: journal.instance, capabilities: ['pipe-runs-v1'] },
        });
        return;
      }
      const parsed = request.safeParse(raw);
      if (!parsed.success) {
        const identity = z.object({ id: z.number().int().positive() }).passthrough().safeParse(raw);
        if (!identity.success) {
          socket.destroy();
          return;
        }
        send({ id: identity.data.id, ok: false, error: 'Invalid run host request' });
        return;
      }
      const message = parsed.data;
      try {
        const result =
          message.op === 'launch'
            ? launcher.launch(message, () => {})
            : message.op === 'status'
              ? journal.get(message.nonce)
              : message.op === 'read'
                ? launcher.read(message.nonce, message.after)
                : await launcher.stop(message.nonce);
        send({ id: message.id, ok: true, result });
      } catch (error) {
        send({ id: message.id, ok: false, error: (error as Error).message });
      }
    };
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 256 * 1024) {
        socket.destroy();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (++pending > 8) {
          socket.destroy();
          return;
        }
        chain = chain
          .then(() => handle(line))
          .catch(() => socket.destroy())
          .then(() => {
            pending--;
          });
      }
    });
  });
  return {
    server,
    disconnect: () => {
      for (const socket of sockets) socket.destroy();
    },
  };
}
