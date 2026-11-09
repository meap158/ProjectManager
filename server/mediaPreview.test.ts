import { mkdtempSync, writeFileSync, truncateSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { expect, it } from 'vitest';
import { decodeMediaPath, mediaRange, OPAQUE_MEDIA_TYPE, streamMedia } from './mediaPreview.js';
import { previewFile } from './projectFiles.js';
import { createApp } from './app.js';
import { openDb } from './db.js';
it('parses bounded, suffix and open ranges and rejects invalid ranges', () => {
  expect(mediaRange('bytes=2-5', 10)).toEqual({ start: 2, end: 5 });
  expect(mediaRange('bytes=8-', 10)).toEqual({ start: 8, end: 9 });
  expect(mediaRange('bytes=-3', 10)).toEqual({ start: 7, end: 9 });
  expect(mediaRange('bytes=2-99', 10)).toEqual({ start: 2, end: 9 });
  for (const value of ['bytes=10-', 'bytes=5-2', 'bytes=-0', 'bytes=0-1,3-4', 'bytes=-', 'junk'])
    expect(mediaRange(value, 10)).toBeNull();
  expect(mediaRange('bytes=0-', 0)).toBeNull();
});
it('classifies and streams media beyond both text and raw caps without buffering the whole file', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-media-'));
  const file = path.join(root, 'big.mp4');
  writeFileSync(file, '0123456789');
  truncateSync(file, 40 * 1024 * 1024);
  expect(await previewFile(root, 'big.mp4')).toMatchObject({
    kind: 'video',
    size: 40 * 1024 * 1024,
  });
  const request = (headers: Record<string, string> = {}, method = 'GET') =>
    new Request('http://localhost/media', { headers, method });
  const response = await streamMedia(root, 'big.mp4', request({ range: 'bytes=2-5' }));
  expect(response.status).toBe(206);
  expect(response.headers.get('content-range')).toBe(`bytes 2-5/${40 * 1024 * 1024}`);
  expect(await response.text()).toBe('2345');
  const etag = response.headers.get('etag')!;
  const cached = await streamMedia(root, 'big.mp4', request({ 'if-none-match': etag }));
  expect(cached.status).toBe(304);
  const head = await streamMedia(root, 'big.mp4', request({}, 'HEAD'));
  expect(head.status).toBe(200);
  expect(head.headers.get('content-length')).toBe(String(40 * 1024 * 1024));
  expect(await head.text()).toBe('');
  const invalid = await streamMedia(root, 'big.mp4', request({ range: 'bytes=999999999-' }));
  expect(invalid.status).toBe(416);
  expect(invalid.headers.get('content-range')).toBe(`bytes */${40 * 1024 * 1024}`);
  const stale = await streamMedia(
    root,
    'big.mp4',
    request({ range: 'bytes=2-5', 'if-range': '"stale"' }, 'HEAD'),
  );
  expect(stale.status).toBe(200);
  writeFileSync(path.join(root, 'song.mp3'), 'audio');
  expect(await previewFile(root, 'song.mp3')).toMatchObject({ kind: 'audio' });
  writeFileSync(path.join(root, 'large.txt'), '');
  truncateSync(path.join(root, 'large.txt'), 3 * 1024 * 1024);
  expect(await previewFile(root, 'large.txt')).toMatchObject({ kind: 'too-large' });
  await expect(streamMedia(root, 'large.txt', request())).rejects.toMatchObject({ status: 400 });
  await expect(streamMedia(root, '../escape.mp4', request())).rejects.toMatchObject({
    status: 400,
  });
});
it('serves range and HEAD requests through the scoped API including LAN reads', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'pm-media-api-'));
  writeFileSync(path.join(root, 'clip.webm'), '0123456789');
  const db = openDb(':memory:');
  try {
    const app = createApp(db);
    const headers = { host: 'localhost:5180', 'content-type': 'application/json' };
    const created = await app.request('/api/projects', {
      method: 'POST',
      headers,
      body: JSON.stringify({ path: root }),
    });
    const { id } = (await created.json()) as { id: number };
    const response = await app.request(`/api/projects/${id}/media?path=clip.webm`, {
      headers: { ...headers, range: 'bytes=0-3', 'x-pm-lan': '1' },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get('content-type')).toBe('video/webm');
    expect(await response.text()).toBe('0123');
    const head = await app.request(`/api/projects/${id}/media?path=clip.webm`, {
      method: 'HEAD',
      headers,
    });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    // The Files preview's own read (PM-597): same bytes, a type download managers ignore, and
    // the path encoded so the URL carries no ".webm".
    const p = Buffer.from('clip.webm').toString('base64url');
    const opaque = await app.request(`/api/projects/${id}/media?opaque=1&p=${p}`, { headers });
    expect(opaque.status).toBe(200);
    expect(opaque.headers.get('content-type')).toBe(OPAQUE_MEDIA_TYPE);
    expect(opaque.headers.get('x-content-type-options')).toBe('nosniff');
    expect(opaque.headers.get('etag')).not.toBe(response.headers.get('etag'));
    expect(await opaque.text()).toBe('0123456789');
    const bad = await app.request(`/api/projects/${id}/media?opaque=1&p=not%20valid`, { headers });
    expect(bad.status).toBe(400);
    const escape = Buffer.from('../x.mp4').toString('base64url');
    expect(
      (await app.request(`/api/projects/${id}/media?opaque=1&p=${escape}`, { headers })).status,
    ).toBe(400);
    expect(decodeMediaPath(Buffer.from('a/ü.mp4').toString('base64url'))).toBe('a/ü.mp4');
  } finally {
    db.close();
  }
});
