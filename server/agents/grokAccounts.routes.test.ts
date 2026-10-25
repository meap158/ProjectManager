import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createApp } from '../app.js';
import { openDb } from '../db.js';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.unstubAllEnvs();
});
function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pm-grok-api-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  vi.stubEnv('GROK_HOME', path.join(dir, 'home'));
  const db = openDb(':memory:');
  const app = createApp(db, { dataDir: dir });
  cleanups.push(async () => {
    await app.supervisor.shutdown();
    db.close();
  });
  return (method: string, url = '', body?: unknown, host = 'localhost:5180') =>
    app.request('/api/agents/grok-accounts' + url, {
      method,
      headers: { host, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
}
it('supports native import, rename, switch and remove without exposing credential material', async () => {
  const call = setup();
  const authJson = JSON.stringify({
    'https://auth.x.ai': {
      email: 'fixture@example.com',
      key: 'secret-fixture-token',
      user_id: 'fixture-user',
    },
  });
  const imported = await call('POST', '', { authJson });
  expect(imported.status).toBe(200);
  const text = await imported.text();
  expect(text).not.toContain('secret-fixture-token');
  const id = JSON.parse(text).accounts[0].id as string;
  expect((await call('PATCH', '/' + id, { name: 'Work' })).status).toBe(200);
  const switched = await call('PUT', '/active', { accountId: id });
  expect(switched.status).toBe(200);
  expect((await switched.json()).defaultAccount.email).toBe('fixture@example.com');
  const removed = await call('DELETE', '/' + id);
  const state = await removed.json();
  expect(state.accounts).toEqual([]);
  expect(state.defaultAccount.email).toBe('fixture@example.com');
});
it('returns safe validation errors and preserves the existing Host gate', async () => {
  const call = setup();
  expect((await call('GET', '', undefined, 'evil.example')).status).toBe(403);
  const malformed = await call('POST', '', { authJson: 'secret-invalid-json' });
  expect(malformed.status).toBe(400);
  expect(await malformed.text()).not.toContain('secret-invalid-json');
  expect((await call('PUT', '/active', { accountId: '../auth' })).status).toBe(400);
  expect((await call('POST', '', { authJson: 42 })).status).toBe(400);
});
