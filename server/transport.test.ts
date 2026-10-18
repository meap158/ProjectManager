import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { gunzipSync } from 'node:zlib';
import { expect, it } from 'vitest';

it('compresses dashboard JSON without buffering terminal event streams or ignoring client encoding preferences', async () => {
  const app = new Hono();
  app.use('*', compress({ threshold: 2048, contentTypeFilter: /^application\/json(?:;|$)/i }));
  const body = JSON.stringify({
    projects: Array.from({ length: 1000 }, (_, i) => ({
      id: i,
      name: 'Project',
      status: 'in_progress',
    })),
  });
  app.get('/projects', (c) => c.body(body, 200, { 'Content-Type': 'application/json' }));
  app.get('/stream', (c) =>
    c.body('data: hello\n\n', 200, { 'Content-Type': 'text/event-stream' }),
  );
  const response = await app.request('/projects', { headers: { 'Accept-Encoding': 'gzip' } });
  const bytes = Buffer.from(await response.arrayBuffer());
  expect(response.headers.get('content-encoding')).toBe('gzip');
  expect(response.headers.get('vary')).toContain('Accept-Encoding');
  expect(gunzipSync(bytes).toString()).toBe(body);
  expect(bytes.length).toBeLessThan(Buffer.byteLength(body) / 5);
  expect(
    (await app.request('/stream', { headers: { 'Accept-Encoding': 'gzip' } })).headers.get(
      'content-encoding',
    ),
  ).toBeNull();
  expect(
    (await app.request('/projects', { headers: { 'Accept-Encoding': 'gzip;q=0' } })).headers.get(
      'content-encoding',
    ),
  ).toBeNull();
});
