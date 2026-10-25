import { createReadStream } from 'node:fs';
import { appendFile, open, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';

// Codex conversations full of screenshots cannot be resumed (PM-276). A running Codex sends each
// new turn on top of the previous response, so screenshots go up once. A relaunched one
// (restart, account switch, crash) re-sends the whole resumable history in one request: a
// conversation with a dozen 2.5 MB screenshots is a 20 MB+ body, and the connection is dropped
// ("stream disconnected before completion ... os error 10053/10054") on every retry, while the
// same history without its images resumes fine.
//
// Before relaunching, `slimResumeImages` appends one record to the rollout: a "compacted" record
// whose replacement history is exactly the history Codex would rebuild (the last compaction's
// replacement history plus every response item after it), with all but the newest screenshots
// replaced by a short note. Codex resumes from the last compaction, so the next request is small.
// Nothing is rewritten or deleted: the original records, images included, stay in the file above
// the new one, so it is its own backup. Only the tail after the last compaction is read.

/** Image bytes (as base64 data URLs) above which a resume is slimmed. */
export const SLIM_ABOVE_BYTES = 8 * 1024 * 1024;
/** The newest screenshots kept, by count and by bytes. */
export const KEEP_IMAGES = 3;
export const KEEP_BYTES = 4 * 1024 * 1024;
export const IMAGE_NOTE =
  '[Screenshot removed by ProjectManager so this resumed conversation is small enough to send. Take a new one if you need it.]';

const COMPACTED = /"type"\s*:\s*"compacted"/;
const CHUNK = 8 * 1024 * 1024;

/**
 * Byte offset of the last "compacted" record (the start of its line), or 0 when there is none.
 * Read backwards in chunks: the record is usually near the end of a multi-GB file.
 */
export async function lastCompactionOffset(file: string): Promise<number> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    let end = size;
    // Bytes carried from the previous (later) chunk, so a match split across chunks is found.
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const start = Math.max(0, end - CHUNK);
      const buffer = Buffer.alloc(end - start);
      await handle.read(buffer, 0, buffer.length, start);
      const window = Buffer.concat([buffer, carry]);
      // Every line start in this window, latest first; the record type sits near the start.
      for (let nl = window.lastIndexOf(10); nl !== -1; nl = window.lastIndexOf(10, nl - 1)) {
        const head = window.subarray(nl + 1, nl + 1 + 300).toString('utf8');
        if (COMPACTED.test(head)) return start + nl + 1;
        if (nl === 0) break;
      }
      // The file's first line starts at 0, whether or not it is the compaction.
      if (start === 0) return 0;
      // Keep the partial first line for the next window (it continues into this one).
      const firstNl = window.indexOf(10);
      carry = firstNl === -1 ? window : window.subarray(0, firstNl + 1);
      end = start;
    }
    return 0;
  } finally {
    await handle.close();
  }
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Every image object in `items`, oldest first, with where it sits so it can be replaced. */
function imageSlots(
  items: Json[],
): { holder: Json[] | Record<string, Json>; key: string | number; bytes: number }[] {
  const slots: { holder: Json[] | Record<string, Json>; key: string | number; bytes: number }[] =
    [];
  const walk = (value: Json, holder: Json[] | Record<string, Json>, key: string | number) => {
    if (Array.isArray(value)) value.forEach((v, i) => walk(v, value, i));
    else if (value && typeof value === 'object') {
      if (value.type === 'input_image') {
        const url = value.image_url;
        slots.push({ holder, key, bytes: typeof url === 'string' ? url.length : 0 });
      } else for (const k of Object.keys(value)) walk(value[k]!, value, k);
    }
  };
  items.forEach((item, i) => walk(item, items, i));
  return slots;
}

export interface SlimResult {
  images: number;
  removed: number;
  bytesBefore: number;
  bytesAfter: number;
}

/**
 * Appends a slimmed compaction record when the resumable history carries more than
 * SLIM_ABOVE_BYTES of screenshots. Returns what it did, or null when nothing was needed (or the
 * history has something it does not model, in which case it leaves the file alone).
 */
export async function slimResumeImages(file: string): Promise<SlimResult | null> {
  const { size } = await stat(file);
  if (size === 0) return null;
  // A rollout still being written (no trailing newline) is left alone.
  const tail = await open(file, 'r');
  try {
    const last = Buffer.alloc(1);
    await tail.read(last, 0, 1, size - 1);
    if (last[0] !== 10) return null;
  } finally {
    await tail.close();
  }

  const start = await lastCompactionOffset(file);
  const items: Json[] = [];
  let lastOrdinal: number | null = null;
  let first = true;
  let unsupported = false;
  const lines = createInterface({
    input: createReadStream(file, { start, end: size - 1 }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let record: { type?: string; ordinal?: number; payload?: Json };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      unsupported = true;
      break;
    }
    if (typeof record.ordinal === 'number') lastOrdinal = record.ordinal;
    const payload = record.payload as Record<string, Json> | undefined;
    if (record.type === 'compacted' && first) {
      const history = payload?.replacement_history;
      // An old-style compaction (a summary message, no replacement history) is not modelled.
      if (!Array.isArray(history)) {
        unsupported = true;
        break;
      }
      items.push(...history);
    } else if (record.type === 'response_item' && payload) items.push(payload);
    else if (record.type === 'event_msg' && payload?.type === 'thread_rolled_back') {
      // A rollback removes turns from history; not modelled, so leave the file alone.
      unsupported = true;
      break;
    }
    first = false;
  }
  if (unsupported) return null;

  const slots = imageSlots(items);
  const bytesBefore = slots.reduce((sum, s) => sum + s.bytes, 0);
  if (bytesBefore <= SLIM_ABOVE_BYTES) return null;
  let kept = 0;
  let keptBytes = 0;
  let removed = 0;
  for (let i = slots.length - 1; i >= 0; i--) {
    const slot = slots[i]!;
    if (kept < KEEP_IMAGES && keptBytes + slot.bytes <= KEEP_BYTES) {
      kept++;
      keptBytes += slot.bytes;
      continue;
    }
    (slot.holder as Record<string | number, Json>)[slot.key] = {
      type: 'input_text',
      text: IMAGE_NOTE,
    };
    removed++;
  }
  const record: Record<string, Json> = {
    timestamp: new Date().toISOString(),
    ...(lastOrdinal !== null ? { ordinal: lastOrdinal + 1 } : {}),
    type: 'compacted',
    payload: { message: '', replacement_history: items },
  };
  await appendFile(file, JSON.stringify(record) + '\n');
  return { images: slots.length, removed, bytesBefore, bytesAfter: keptBytes };
}
