import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { withAttachments } from './attachments.js';
import { openDb } from './db.js';
import { insertCard, insertProject } from './store.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-attach-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const db = openDb(':memory:');
const app = createApp(db, { dataDir: dir });
const project = insertProject(db, 'demo', process.cwd());
const card = insertCard(db, project, { title: 'Hero image', description: '', status: 'todo' });
const root = path.join(dir, 'attachments');

// 1x1 transparent PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const json = { 'content-type': 'application/json', host: 'localhost' };

describe('card attachments', () => {
  it('uploads, lists, serves and deletes an image', async () => {
    const up = await app.request(`/api/cards/${card.id}/attachments`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: '../../evil name.png', type: 'image/png', data: PNG }),
    });
    expect(up.status).toBe(201);
    const added = (await up.json()) as { file: string; name: string; url: string };
    expect(added.name).toBe('evil name.png'); // path parts dropped

    const list = await app.request(`/api/cards/${card.id}/attachments`, { headers: json });
    expect(((await list.json()) as unknown[]).length).toBe(1);

    const img = await app.request(added.url, { headers: json });
    expect(img.status).toBe(200);
    expect(img.headers.get('content-type')).toBe('image/png');

    const del = await app.request(added.url, { method: 'DELETE', headers: json });
    expect(del.status).toBe(204);
  });

  it('rejects other types, bad names and unknown cards', async () => {
    const svg = await app.request(`/api/cards/${card.id}/attachments`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'x.svg', type: 'image/svg+xml', data: PNG }),
    });
    expect(svg.status).toBe(415);
    const traversal = await app.request(`/api/cards/${card.id}/attachments/..%2F..%2Fdb`, {
      headers: json,
    });
    expect(traversal.status).toBe(404);
    const missing = await app.request('/api/cards/99999/attachments', { headers: json });
    expect(missing.status).toBe(404);
  });

  it('adds image paths to agent tasks without ever truncating them', async () => {
    await app.request(`/api/cards/${card.id}/attachments`, {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ name: 'mockup.png', type: 'image/png', data: PNG }),
    });
    const prompt = withAttachments('x'.repeat(30_000), root, card.id);
    expect(prompt.length).toBeLessThanOrEqual(20_000);
    expect(prompt).toMatch(/Attached images \(1\)/);
    expect(prompt).toMatch(/mockup\.png$/);
    expect(withAttachments('task', root, 424242)).toBe('task');
  });

  it('removes a card’s images when the card is deleted', async () => {
    const res = await app.request(`/api/cards/${card.id}`, { method: 'DELETE', headers: json });
    expect(res.status).toBe(204);
    expect(withAttachments('task', root, card.id)).toBe('task');
  });
});
