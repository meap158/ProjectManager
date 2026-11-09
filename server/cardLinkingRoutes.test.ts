import { expect, it } from 'vitest';
import { createApp } from './app.js';
import { openDb } from './db.js';
import { insertProject } from './store.js';

it('exposes an off-by-default per-project setting and accepts linked PR URLs', async () => {
  const db = openDb(':memory:');
  const project = insertProject(db, 'Demo', process.cwd());
  const app = createApp(db);
  const headers = { host: 'localhost:5180', 'content-type': 'application/json' };
  const request = (method: string, path: string, body?: unknown) =>
    app.request(`/api${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    const url = `/projects/${project}/card-linking`;
    expect(await (await request('GET', url)).json()).toMatchObject({
      writeBack: false,
      authorized: false,
    });
    expect((await request('PUT', url, { writeBack: 'true' })).status).toBe(400);
    expect((await request('PUT', url, { writeBack: true })).status).toBe(200);
    expect(await (await request('GET', url)).json()).toMatchObject({
      writeBack: true,
      authorized: false,
    });
    expect((await request('PUT', '/projects/9999/card-linking', { writeBack: true })).status).toBe(
      404,
    );
    const added = await request('POST', `/projects/${project}/cards`, {
      title: 'PR card',
      issueUrl: 'https://github.com/owner/repo/pull/12',
    });
    expect(added.status).toBe(201);
    const card = (await added.json()) as { id: number };
    expect(
      (
        await request('PATCH', `/cards/${card.id}`, {
          issueUrl: 'https://example.com/owner/repo/pull/12',
        })
      ).status,
    ).toBe(400);
  } finally {
    await app.supervisor.shutdown();
    db.close();
  }
});
