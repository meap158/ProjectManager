import { appendFileSync, mkdirSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import path from 'node:path';
import { compactLog, LOG_KEEP_BYTES, logBase, logicalSize, physicalSize } from './logFile.js';

export const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MEM_CAP_BYTES = 256 * 1024;
const MAX_READ_BYTES = 128 * 1024;

interface Chunk {
  data: Buffer;
  bytes: number;
}

/** File-backed, offset-addressed log with a capped in-memory window. */
export class OutputLog {
  private chunks: Chunk[] = [];
  private memBytes = 0;
  private baseOffset = 0; // bytes dropped from the head of `chunks`
  totalBytes = 0;

  constructor(
    readonly file: string,
    private onAppend?: () => void,
    private maxFileBytes = MAX_LOG_BYTES,
  ) {
    mkdirSync(path.dirname(file), { recursive: true });
    // Continue from what is already on disk, so byte offsets match the file across server
    // restarts (a reconnecting terminal asks for "everything after byte N"). Offsets are logical:
    // compacted logs record the bytes dropped from their head (logFile.ts).
    const size = logicalSize(file);
    this.baseOffset = size;
    this.totalBytes = size;
  }

  /** Output the session host already wrote to the file at `offset`: mirror it in memory only. */
  ingest(offset: number, text: string): void {
    const bytes = Buffer.byteLength(text);
    if (offset + bytes <= this.totalBytes) return; // Already have it.
    if (offset !== this.totalBytes) this.resync(offset); // Gap/overlap: follow the host.
    this.push(text);
  }

  /** Re-anchor at the file size the host reports; anything older is read from disk. */
  resync(size: number): void {
    if (size === this.totalBytes) return;
    this.chunks = [];
    this.memBytes = 0;
    this.baseOffset = size;
    this.totalBytes = size;
  }

  /** Drop inactive cache only when disk can still serve every byte (writes are best-effort). */
  releaseCache(): boolean {
    if (logicalSize(this.file) < this.totalBytes) return false;
    this.chunks = [];
    this.memBytes = 0;
    this.baseOffset = this.totalBytes;
    return true;
  }

  append(text: string): void {
    if (!text) return;
    try {
      // A full log is compacted to its recent tail; output keeps flowing at growing offsets.
      if (physicalSize(this.file) + Buffer.byteLength(text) > this.maxFileBytes) {
        compactLog(this.file, Math.min(LOG_KEEP_BYTES, Math.floor(this.maxFileBytes / 4)));
      }
      appendFileSync(this.file, text);
    } catch {
      // A log write must never take down a session; memory still serves reads.
    }
    this.push(text);
  }

  private push(text: string): void {
    this.onAppend?.();
    const bytes = Buffer.byteLength(text);
    let tail = this.chunks.at(-1);
    if (!tail || tail.bytes === 4096) {
      tail = { data: Buffer.allocUnsafe(4096), bytes: 0 };
      this.chunks.push(tail);
    }
    // Most PTY events fit in the current block. Encode directly into it, avoiding a
    // temporary Buffer allocation per keystroke/progress update.
    if (bytes <= 4096 - tail.bytes) {
      tail.data.write(text, tail.bytes, bytes, 'utf8');
      tail.bytes += bytes;
      this.memBytes += bytes;
      this.totalBytes += bytes;
      while (this.memBytes > MEM_CAP_BYTES) {
        const dropped = this.chunks.shift()!;
        this.memBytes -= dropped.bytes;
        this.baseOffset += dropped.bytes;
      }
      return;
    }
    const data = Buffer.from(text, 'utf8');
    this.totalBytes += data.length;
    // Fixed blocks bound object overhead even for one-character output events. Store bytes
    // once instead of encoding every cached chunk for every connected viewer's read.
    for (let offset = 0; offset < data.length;) {
      let tail = this.chunks.at(-1);
      if (!tail || tail.bytes === 4096) {
        tail = { data: Buffer.allocUnsafe(4096), bytes: 0 };
        this.chunks.push(tail);
      }
      const take = Math.min(4096 - tail.bytes, data.length - offset);
      data.copy(tail.data, tail.bytes, offset, offset + take);
      tail.bytes += take;
      offset += take;
      this.memBytes += take;
      while (this.memBytes > MEM_CAP_BYTES) {
        const dropped = this.chunks.shift()!;
        this.memBytes -= dropped.bytes;
        this.baseOffset += dropped.bytes;
      }
    }
  }

  /** Read up to MAX_READ_BYTES starting at byte offset `after`. */
  read(after: number): { data: string; nextOffset: number } {
    if (!Number.isFinite(after) || after < 0) after = 0;
    if (after < this.baseOffset) return this.readFile(after);
    // Serve from memory; slice chunks by bytes so multibyte chars never split.
    let skip = after - this.baseOffset;
    const parts: Buffer[] = [];
    let used = 0;
    for (const c of this.chunks) {
      if (used >= MAX_READ_BYTES) break;
      if (skip >= c.bytes) {
        skip -= c.bytes;
        continue;
      }
      const take = Math.min(c.bytes - skip, MAX_READ_BYTES - used);
      parts.push(c.data.subarray(skip, skip + take));
      used += take;
      skip = 0;
    }
    // A byte-limited read can end inside a multibyte glyph. Leave that suffix for the next
    // read instead of inserting replacement characters and advancing beyond its true offset.
    const data = new TextDecoder('utf-8', { ignoreBOM: true }).decode(Buffer.concat(parts), {
      stream: true,
    });
    return { data, nextOffset: after + Buffer.byteLength(data) };
  }

  /** Positioned read straight from the file for ranges that fell out of memory. */
  private readFile(after: number): { data: string; nextOffset: number } {
    try {
      const base = logBase(this.file);
      const fd = openSync(this.file, 'r');
      try {
        const size = fstatSync(fd).size;
        // Offsets are logical; anything older than the compacted head resumes at the head.
        const start = Math.min(Math.max(after, base), base + size);
        const len = Math.min(MAX_READ_BYTES, base + size - start);
        if (len <= 0) return { data: '', nextOffset: start };
        const buf = Buffer.allocUnsafe(len);
        const bytesRead = readSync(fd, buf, 0, len, start - base);
        const slice = bytesRead < len ? buf.subarray(0, bytesRead) : buf;
        const data = new TextDecoder('utf-8', { ignoreBOM: true }).decode(slice, { stream: true });
        return { data, nextOffset: start + Buffer.byteLength(data) };
      } finally {
        closeSync(fd);
      }
    } catch {
      return { data: '', nextOffset: after };
    }
  }
}
