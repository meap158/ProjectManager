import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import path from 'node:path';
import { MEDIA_TYPES } from '../shared/media.js';
import { FileAccessError, resolveInside } from './projectFiles.js';

/** A single HTTP byte range, including suffix and open-ended requests. */
export function mediaRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start: number;
  let end: number;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    start >= size ||
    end < start
  )
    return null;
  return { start, end: Math.min(end, size - 1) };
}
/** Streams only allowlisted media after the same containment checks as other Files reads. */
export async function streamMedia(root: string, rel: string, request: Request): Promise<Response> {
  const abs = await resolveInside(root, rel);
  const type = MEDIA_TYPES[path.extname(abs).toLowerCase()];
  if (!type) throw new FileAccessError(400, 'This file is not a supported media type');
  const info = await stat(abs);
  if (!info.isFile()) throw new FileAccessError(400, 'Not a file');
  const etag = `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
  const headers = new Headers({
    'content-type': type,
    'accept-ranges': 'bytes',
    'cache-control': 'private, no-cache',
    etag: etag,
    'last-modified': info.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
  });
  if (request.headers.get('if-none-match') === etag)
    return new Response(null, { status: 304, headers });
  const range = request.headers.get('range');
  const ifRange = request.headers.get('if-range');
  const partial = range && (!ifRange || ifRange === etag || ifRange === info.mtime.toUTCString());
  const bounds = partial ? mediaRange(range, info.size) : { start: 0, end: info.size - 1 };
  if (!bounds) {
    headers.set('content-range', `bytes */${info.size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('content-length', String(Math.max(0, bounds.end - bounds.start + 1)));
  if (partial) headers.set('content-range', `bytes ${bounds.start}-${bounds.end}/${info.size}`);
  if (request.method === 'HEAD' || info.size === 0)
    return new Response(null, { status: partial ? 206 : 200, headers });
  const stream = createReadStream(abs, {
    start: bounds.start,
    end: bounds.end,
    highWaterMark: 64 * 1024,
  });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: partial ? 206 : 200,
    headers,
  });
}
