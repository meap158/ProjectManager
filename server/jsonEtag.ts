import { createHash } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

/**
 * Polled reads revalidate instead of re-downloading: a JSON GET gets a weak ETag of its body
 * (weak: compression changes the bytes on the wire) and `no-cache`, so the browser sends
 * If-None-Match and an unchanged list (the board's cards are ~0.5 MB) comes back as a bodiless
 * 304. Register it after `compress` so it hashes the uncompressed body. JSON only: streams pass.
 */
export const jsonEtag: MiddlewareHandler = async (c, next) => {
  await next();
  if (c.req.method !== 'GET' || c.res.status !== 200 || c.res.headers.has('etag')) return;
  if (!/^application\/json(?:;|$)/i.test(c.res.headers.get('content-type') ?? '')) return;
  const body = Buffer.from(await c.res.clone().arrayBuffer());
  const etag = `W/"${createHash('sha1').update(body).digest('base64url')}"`;
  const headers = new Headers(c.res.headers);
  headers.set('etag', etag);
  if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-cache');
  const match = c.req.header('if-none-match');
  if (match && match.split(',').some((tag) => tag.trim() === etag)) {
    headers.delete('content-length');
    headers.delete('content-type');
    c.res = new Response(null, { status: 304, headers });
  } else c.res = new Response(body, { status: 200, headers });
};
