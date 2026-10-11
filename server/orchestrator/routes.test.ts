import { Hono } from 'hono';
import { expect, it, vi } from 'vitest';
import { registerOrchestratorRoutes } from './routes.js';
import type { OrchestratorService } from './service.js';

it('rejects invalid attention scopes and malformed JSON without invoking actions', async () => {
  const action = vi.fn();
  const app = new Hono();
  registerOrchestratorRoutes(app, {
    state: () => ({ instances: [{ id: 'master' }] }),
    pruneAttention: action,
    resolveAttention: action,
    dismissAttention: action,
    clearDismissedAttention: action,
  } as unknown as OrchestratorService);
  for (const path of [
    '/orchestrators/prune-attention',
    '/orchestrators/resolve-attention',
    '/orchestrators/master/prune-attention',
    '/orchestrators/master/resolve-attention',
  ]) {
    for (const body of [
      '{',
      'null',
      '{"projectId":0}',
      '{"projectId":-1}',
      '{"projectId":"1"}',
      '{"projectId":1.5}',
    ]) {
      expect(
        (
          await app.request(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
        ).status,
      ).toBe(400);
    }
  }
  expect(
    (
      await app.request('/orchestrators/dismiss-attention', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 1, kinds: ['invalid'] }),
      })
    ).status,
  ).toBe(400);
  expect(
    (await app.request('/orchestrators/dismiss-attention/-1', { method: 'DELETE' })).status,
  ).toBe(400);
  expect(action).not.toHaveBeenCalled();
  const valid = await app.request('/orchestrators/resolve-attention', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"projectId":1}',
  });
  expect(valid.status).toBe(200);
  expect(action).toHaveBeenCalledExactlyOnceWith(undefined, 1);
  action.mockClear();
  const all = await app.request('/orchestrators/resolve-attention', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  expect(all.status).toBe(200);
  expect(action).toHaveBeenCalledExactlyOnceWith(undefined, undefined);
});
