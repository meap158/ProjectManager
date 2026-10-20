import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { gzip } from 'node:zlib';

// Gzip for the LAN listener. Vite dev serves JS/CSS uncompressed (fine on loopback, ~10 MB per
// cold phone load over Wi-Fi), and the API's Hono compress only covers JSON. Browsers only offer
// gzip/deflate over plain http (br and zstd need https), so gzip it is. Level 4: close to the
// default's ratio for a third less CPU (the machine's CPU budget matters more than the last %).
// Whole bodies only: anything that streams (event streams, the API) passes through untouched.
// Vite dev also inlines a base64 source map in every module: two thirds of the bytes, and base64
// barely compresses. Phones over the LAN get modules without it (desktop debugging keeps it).

const LEVEL = 4;
/** Below this, gzip's own overhead outweighs the saving. */
const MIN_BYTES = 1024;
const COMPRESSIBLE =
  /^(?:text\/(?!event-stream)|application\/(?:javascript|json|manifest\+json|xml)|image\/svg\+xml)/i;
const INLINE_MAP = Buffer.from('\n//# sourceMappingURL=data:');

/** The body without a trailing inline source map comment, when it ends with one. */
export function withoutInlineMap(body: Buffer): Buffer {
  const at = body.lastIndexOf(INLINE_MAP);
  if (at < 0) return body;
  const tail = body.subarray(at + INLINE_MAP.length).toString('latin1');
  return /^[^\n]*\s*$/.test(tail) ? body.subarray(0, at + 1) : body;
}

/** Compressed bodies by URL + version (ETag, else Last-Modified): unchanged files reuse theirs. */
const CACHE_LIMIT_BYTES = 48 * 1024 * 1024;
const cache = new Map<string, Buffer>();
let cacheBytes = 0;

function remember(key: string, body: Buffer): void {
  if (body.length > CACHE_LIMIT_BYTES / 4) return;
  cache.set(key, body);
  cacheBytes += body.length;
  // Oldest first (Map keeps insertion order; hits re-insert below).
  for (const [old, value] of cache) {
    if (cacheBytes <= CACHE_LIMIT_BYTES) break;
    cache.delete(old);
    cacheBytes -= value.length;
  }
}

function recall(key: string): Buffer | undefined {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
  }
  return hit;
}

const asBuffer = (chunk: unknown, encoding?: BufferEncoding) =>
  Buffer.isBuffer(chunk)
    ? chunk
    : chunk instanceof Uint8Array
      ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
      : Buffer.from(String(chunk), encoding);

/**
 * Makes `res` gzip a whole compressible body when the client accepts it. Decides once the
 * status and headers are known (first write or end): anything else is passed through as is.
 */
export function gzipResponse(req: IncomingMessage, res: ServerResponse): void {
  if (req.method !== 'GET' || req.headers.range) return;
  if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] ?? ''))) return;
  const writeHead = res.writeHead.bind(res) as (
    status: number,
    ...rest: unknown[]
  ) => ServerResponse;
  const write = res.write.bind(res) as (...args: unknown[]) => boolean;
  const end = res.end.bind(res) as (...args: unknown[]) => ServerResponse;
  let mode: 'undecided' | 'buffer' | 'pass' = 'undecided';
  /** Set while sending the final body: Node's own end() calls writeHead for the headers. */
  let finishing = false;
  const chunks: Buffer[] = [];

  const decide = () => {
    if (mode !== 'undecided') return mode;
    const type = String(res.getHeader('content-type') ?? '');
    mode =
      res.statusCode === 200 && !res.getHeader('content-encoding') && COMPRESSIBLE.test(type)
        ? 'buffer'
        : 'pass';
    return mode;
  };

  // writeHead(status, [message], [headers]): keep the headers on res and send them later.
  res.writeHead = ((status: number, ...rest: unknown[]) => {
    if (mode === 'pass' || finishing) return writeHead(status, ...rest);
    res.statusCode = status;
    if (typeof rest[0] === 'string') res.statusMessage = rest.shift() as string;
    const headers = rest[0] as OutgoingHttpHeaders | (string | string[])[] | undefined;
    if (Array.isArray(headers)) {
      const flat = headers.flat();
      for (let i = 0; i + 1 < flat.length; i += 2) res.setHeader(flat[i]!, flat[i + 1]!);
    } else if (headers) {
      for (const [name, value] of Object.entries(headers))
        if (value !== undefined) res.setHeader(name, value);
    }
    // A streaming response (event stream) must reach the client now, not at its first write.
    if (decide() === 'pass') writeHead(res.statusCode);
    return res;
  }) as typeof res.writeHead;

  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (decide() === 'pass') return write(chunk, ...rest);
    const encoding = typeof rest[0] === 'string' ? (rest[0] as BufferEncoding) : undefined;
    chunks.push(asBuffer(chunk, encoding));
    const callback = rest.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    callback?.();
    return true;
  }) as typeof res.write;

  res.end = ((...args: unknown[]) => {
    if (decide() === 'pass') return end(...args);
    const callback = args.find((arg) => typeof arg === 'function') as (() => void) | undefined;
    const chunk = typeof args[0] === 'function' ? undefined : args[0];
    const encoding = typeof args[1] === 'string' ? (args[1] as BufferEncoding) : undefined;
    if (chunk !== undefined && chunk !== null) chunks.push(asBuffer(chunk, encoding));
    const whole = Buffer.concat(chunks);
    const type = String(res.getHeader('content-type'));
    const body = /javascript/i.test(type) ? withoutInlineMap(whole) : whole;
    const finish = (out: Buffer, gzipped: boolean) => {
      if (gzipped) {
        res.setHeader('content-encoding', 'gzip');
        const vary = String(res.getHeader('vary') ?? '');
        res.setHeader('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
      }
      res.setHeader('content-length', out.length);
      finishing = true;
      end(out, callback);
    };
    if (body.length < MIN_BYTES) {
      finish(body, false);
      return res;
    }
    // The production static server sends Last-Modified but no ETag.
    const version = res.getHeader('etag') ?? res.getHeader('last-modified');
    const key = version ? `${req.url}\0${String(version)}` : null;
    const cached = key ? recall(key) : undefined;
    if (cached) {
      finish(cached, true);
      return res;
    }
    gzip(body, { level: LEVEL }, (error, out) => {
      if (error) return finish(body, false);
      if (key) remember(key, out);
      finish(out, true);
    });
    return res;
  }) as typeof res.end;
}
