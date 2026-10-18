// Antigravity's conversations, for the chat view. Each conversation is a SQLite file
// (~/.gemini/antigravity-cli/conversations/<id>.db) whose `steps` rows carry protobuf payloads
// with no published schema. The fields read here were worked out from real conversations:
//   step type 14  user message           19.2 text
//   step type 15  model turn             20.1 reply, 20.3 reasoning, 20.7 tool call (1 id, 2 name, 3 args)
//   step type 132 tool step              5.4 the call (1 id, 2 name, 3 args), 140.2.1 its result,
//                                        140.1 key/value pairs (toolSummary)
//   step type 17  error                  24.3.1 message
//   every step                           5.1 created (1 seconds, 2 nanos)
// and the conversation's folder is trajectory_metadata_blob 1.1 (a file:// URL). Anything else is
// skipped, so an Antigravity update that changes the format shows less rather than wrong things.
// Reads are read-only, and scoped to the pinned conversation and the session's folder.

import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import type { ChatItem } from '../../shared/types.js';
import { toolSummary } from './transcript.js';

/** A decoded protobuf message: each field number's values (varints, bytes). */
type Fields = Map<number, (bigint | Buffer)[]>;

/** Decodes one protobuf message without a schema; null when the bytes aren't one. */
export function decodeMessage(buf: Buffer): Fields | null {
  const fields: Fields = new Map();
  let pos = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (pos >= buf.length) throw new Error('truncated');
      const b = buf[pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) return result;
      shift += 7n;
      if (shift > 63n) throw new Error('varint too long');
    }
  };
  try {
    while (pos < buf.length) {
      const key = varint();
      const field = Number(key >> 3n);
      const wire = Number(key & 7n);
      if (field < 1) return null;
      let value: bigint | Buffer;
      if (wire === 0) value = varint();
      else if (wire === 2) {
        const len = Number(varint());
        if (pos + len > buf.length) return null;
        value = buf.subarray(pos, pos + len);
        pos += len;
      } else if (wire === 1 || wire === 5) {
        pos += wire === 1 ? 8 : 4;
        if (pos > buf.length) return null;
        continue;
      } else return null;
      const list = fields.get(field);
      if (list) list.push(value);
      else fields.set(field, [value]);
    }
  } catch {
    return null;
  }
  return fields;
}

/** The nested message at a field path (first value at each step). */
function at(fields: Fields | null, ...path: number[]): Fields | null {
  let current = fields;
  for (const field of path) {
    const value = current?.get(field)?.[0];
    current = Buffer.isBuffer(value) ? decodeMessage(value) : null;
  }
  return current;
}
function text(fields: Fields | null, field: number): string {
  const value = fields?.get(field)?.[0];
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}
function int(fields: Fields | null, field: number): number | null {
  const value = fields?.get(field)?.[0];
  return typeof value === 'bigint' ? Number(value) : null;
}

const clip = (s: string) => (s.length > 16_000 ? s.slice(0, 16_000) + '\n… more in CLI' : s);
const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** Chat items from steps (oldest first). */
export function antigravityItems(
  steps: { idx: number; type: number; payload: Buffer }[],
): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ChatItem>();
  const tool = (id: string, name: string, args: string, when: string | null, idx: number) => {
    let item = tools.get(id);
    if (!item) {
      const input = parseJson(args);
      item = {
        id: `agy:${idx}:tool`,
        kind: 'tool',
        toolId: id,
        name: name || 'Tool',
        summary: toolSummary(name, input),
        input: clip(typeof input === 'string' ? input : JSON.stringify(input, null, 2)),
        at: when,
      };
      tools.set(id, item);
      items.push(item);
    }
    return item;
  };
  for (const step of steps) {
    const root = decodeMessage(step.payload);
    if (!root) continue;
    const created = at(root, 5, 1);
    const seconds = int(created, 1);
    const when = seconds ? new Date(seconds * 1000).toISOString() : null;
    const id = `agy:${step.idx}`;
    if (step.type === 14) {
      const message = text(at(root, 19), 2);
      if (message.trim()) items.push({ id, kind: 'user', text: clip(message), at: when });
    } else if (step.type === 15) {
      const turn = at(root, 20);
      const thought = text(turn, 3);
      const reply = text(turn, 1);
      if (thought.trim())
        items.push({ id: `${id}:thought`, kind: 'note', text: clip(thought), at: when });
      if (reply.trim()) items.push({ id, kind: 'assistant', text: clip(reply), at: when });
      const call = at(turn, 7);
      if (call && text(call, 1)) tool(text(call, 1), text(call, 2), text(call, 3), when, step.idx);
    } else if (step.type === 132) {
      const call = at(root, 5, 4);
      const callId = text(call, 1);
      if (!callId) continue;
      const item = tool(callId, text(call, 2), text(call, 3), when, step.idx);
      // The tool's own one-line summary, when it gives one.
      for (const pair of root.get(140) ?? []) {
        const kv = Buffer.isBuffer(pair) ? decodeMessage(pair) : null;
        for (const entry of kv?.get(1) ?? []) {
          const e = Buffer.isBuffer(entry) ? decodeMessage(entry) : null;
          if (text(e, 1) === 'toolSummary' && text(e, 2)) item.summary = text(e, 2);
        }
      }
      const output = text(at(root, 140, 2), 1);
      if (output)
        items.push({
          id: `${id}:result`,
          kind: 'result',
          toolId: callId,
          text: clip(output),
          at: when,
        });
    } else if (step.type === 17) {
      const message = text(at(root, 24, 3), 1);
      if (message) items.push({ id, kind: 'note', text: clip(`Error: ${message}`), at: when });
    }
  }
  return items;
}

/** Where a conversation lives: the CLI's store, else the app's. */
export function antigravityConversationFile(id: string, home = os.homedir()): string | null {
  for (const dir of ['antigravity-cli', 'antigravity']) {
    const file = path.join(home, '.gemini', dir, 'conversations', `${id}.db`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** The conversation's last steps, or null when it isn't the session's (other folder) or unreadable. */
export function readAntigravity(file: string, cwd: string, limit = 600): ChatItem[] | null {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const meta = db.prepare('SELECT data FROM trajectory_metadata_blob LIMIT 1').get() as
      { data: Uint8Array } | undefined;
    const folder = meta ? text(at(decodeMessage(Buffer.from(meta.data)), 1), 1) : '';
    let dir = '';
    try {
      dir = folder ? fileURLToPath(folder) : '';
    } catch {
      dir = '';
    }
    if (!dir || path.resolve(dir).toLowerCase() !== path.resolve(cwd).toLowerCase()) return null;
    const rows = db
      .prepare(
        'SELECT idx, step_type AS type, step_payload AS payload FROM steps WHERE step_payload IS NOT NULL ORDER BY idx DESC LIMIT ?',
      )
      .all(limit) as { idx: number; type: number; payload: Uint8Array }[];
    return antigravityItems(
      rows.reverse().map((r) => ({ idx: r.idx, type: r.type, payload: Buffer.from(r.payload) })),
    );
  } finally {
    db.close();
  }
}
