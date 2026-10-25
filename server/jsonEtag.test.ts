import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { describe, expect, it } from 'vitest';
import { jsonEtag } from './jsonEtag.js';

describe('jsonEtag', () => {
  const app = new Hono();
  app.use('*', compress({ threshold: 16 }));
  app.use('*', jsonEtag);
  let value = 'a';
  app.get('/list', (c) => c.json({ items: Array(50).fill(value) }));
  app.get('/stream', (c) => c.body('data: x\n\n', 200, { 'content-type': 'text/event-stream' }));
  app.post('/list', (c) => c.json({ ok: true }));

  it('answers an unchanged JSON read with a bodiless 304, and a changed one in full', async () => {
    const first = await app.request('/list');
    const etag = first.headers.get('etag')!;
    expect(etag).toMatch(/^W\/"/);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    const again = await app.request('/list', { headers: { 'if-none-match': etag } });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    // Compressed or not, the tag is the same (it hashes the uncompressed body).
    const gzip = await app.request('/list', { headers: { 'accept-encoding': 'gzip' } });
    expect(gzip.headers.get('content-encoding')).toBe('gzip');
    expect(gzip.headers.get('etag')).toBe(etag);
    value = 'b';
    const changed = await app.request('/list', { headers: { 'if-none-match': etag } });
    expect(changed.status).toBe(200);
    expect(((await changed.json()) as { items: string[] }).items[0]).toBe('b');
  });

  it('leaves streams and writes alone', async () => {
    expect((await app.request('/stream')).headers.get('etag')).toBeNull();
    expect((await app.request('/list', { method: 'POST' })).headers.get('etag')).toBeNull();
  });
});
