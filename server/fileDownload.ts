import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { FileAccessError, resolveInside } from './projectFiles.js';

/*
 * Download any file in a project (PM-652): the Files lightbox's Download for every kind.
 * Read-only, the same containment checks as the other Files reads, streamed so a large file is
 * never held in memory, and always an attachment of an inert type: the browser saves it and
 * never shows or runs it on this origin.
 */

/** `attachment` with an ASCII fallback name and the exact name in RFC 5987 form. */
export function attachmentHeader(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function streamDownload(root: string, rel: string): Promise<Response> {
  const abs = await resolveInside(root, rel);
  const info = await stat(abs);
  if (!info.isFile()) throw new FileAccessError(400, 'Not a file');
  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'content-length': String(info.size),
    'content-disposition': attachmentHeader(path.basename(abs)),
    'cache-control': 'private, no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'",
  });
  if (info.size === 0) return new Response(null, { status: 200, headers });
  const stream = createReadStream(abs, { highWaterMark: 64 * 1024 });
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: 200,
    headers,
  });
}
