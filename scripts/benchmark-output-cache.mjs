// Run each variant in a fresh process:
// node --expose-gc --import tsx scripts/benchmark-output-cache.mjs legacy
// node --expose-gc --import tsx scripts/benchmark-output-cache.mjs blocks
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { OutputLog } from '../server/agents/supervisor.ts';

// Previous cache algorithm, preserved here solely for comparative measurement.
class LegacyCache {
  chunks = [];
  memBytes = 0;
  baseOffset = 0;
  ingest(_offset, text) {
    const bytes = Buffer.byteLength(text);
    this.chunks.push({ text, bytes });
    this.memBytes += bytes;
    while (this.memBytes > 256 * 1024 && this.chunks.length > 1) {
      const dropped = this.chunks.shift();
      this.memBytes -= dropped.bytes;
      this.baseOffset += dropped.bytes;
    }
  }
  read(after) {
    let skip = after - this.baseOffset;
    const parts = [];
    let used = 0;
    for (const c of this.chunks) {
      if (used >= 128 * 1024) break;
      if (skip >= c.bytes) {
        skip -= c.bytes;
        continue;
      }
      const take = Math.min(c.bytes - skip, 128 * 1024 - used);
      parts.push(Buffer.from(c.text, 'utf8').subarray(skip, skip + take));
      used += take;
      skip = 0;
    }
    const data = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(parts), {
      stream: true,
    });
    return { data, nextOffset: after + Buffer.byteLength(data) };
  }
}

const variant = process.argv[2];
if (!['legacy', 'blocks'].includes(variant) || !global.gc) {
  throw new Error('Use --expose-gc --import tsx and specify legacy or blocks');
}
const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-cache-bench-'));
try {
  global.gc();
  const before = process.memoryUsage();
  const start = performance.now();
  const caches = Array.from({ length: 10 }, (_, i) =>
    variant === 'legacy' ? new LegacyCache() : new OutputLog(path.join(dir, `${i}.log`)),
  );
  for (const cache of caches) {
    for (let i = 0; i < 100000; i++) cache.ingest(i, 'x');
  }
  const ingestMs = performance.now() - start;
  global.gc();
  const retained = process.memoryUsage();
  const readStart = performance.now();
  let checksum = 0;
  for (let i = 0; i < 10; i++) {
    for (const cache of caches) checksum += cache.read(0).data.length;
  }
  console.log(
    JSON.stringify({
      variant,
      workload: '10 logs × 100000 one-byte events; 100 reads',
      retainedHeapBytes: retained.heapUsed - before.heapUsed,
      retainedBufferBytes: retained.arrayBuffers - before.arrayBuffers,
      retainedHeapAndBufferBytes:
        retained.heapUsed - before.heapUsed + retained.arrayBuffers - before.arrayBuffers,
      ingestMs: Math.round(ingestMs),
      readMs: Math.round(performance.now() - readStart),
      checksum,
    }),
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
