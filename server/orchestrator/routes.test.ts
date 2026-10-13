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

it('bounds and validates plan preview pages before inspecting tasks', async () => {
  const preview = vi.fn(async () => ({ total: 1000, decisions: [] }));
  const app = new Hono();
  registerOrchestratorRoutes(app, { preview } as unknown as OrchestratorService);
  for (const query of [
    'limit=201',
    'limit=0',
    'offset=-1',
    'offset=1.5',
    'offset=invalid',
    'unknown=1',
  ]) {
    expect((await app.request(`/orchestrators/master/preview?${query}`)).status).toBe(400);
  }
  expect(preview).not.toHaveBeenCalled();
  expect((await app.request('/orchestrators/master/preview')).status).toBe(200);
  expect(preview).toHaveBeenLastCalledWith('master', 0, 100);
  expect((await app.request('/orchestrators/master/preview?offset=100&limit=50')).status).toBe(200);
  expect(preview).toHaveBeenLastCalledWith('master', 100, 50);
});

it('validates pending pages before reading and passes bounded scope to the service', async () => {
  const pending = vi.fn(() => ({
    version: 1,
    total: 0,
    offset: 0,
    limit: 10,
    items: [],
    nextOffset: null,
    generatedAt: 'now',
  }));
  const app = new Hono();
  registerOrchestratorRoutes(app, { pending } as unknown as OrchestratorService);
  for (const query of [
    'offset=-1',
    'limit=0',
    'limit=101',
    'projectId=0',
    'offset=1.5',
    'unknown=1',
  ]) {
    expect((await app.request('/orchestrators/master/pending?' + query)).status).toBe(400);
  }
  expect(pending).not.toHaveBeenCalled();
  expect(
    (await app.request('/orchestrators/master/pending?offset=10&limit=10&projectId=2')).status,
  ).toBe(200);
  expect(pending).toHaveBeenCalledWith('master', 10, 10, 2);
  pending.mockReturnValueOnce(null as unknown as ReturnType<typeof pending>);
  expect((await app.request('/orchestrators/missing/pending')).status).toBe(404);
});

it('validates workspace run cursors before reading and preserves missing-owner responses', async () => {
  const workspaceRuns = vi.fn(() => ({ version: 1, runs: [], historyIds: [], nextBefore: null }));
  const app = new Hono();
  registerOrchestratorRoutes(app, { workspaceRuns } as unknown as OrchestratorService);
  for (const query of ['before=0', 'before=-1', 'before=no', 'limit=0', 'limit=101', 'extra=1']) {
    expect((await app.request(`/orchestrators/owner/runs?${query}`)).status).toBe(400);
  }
  expect(workspaceRuns).not.toHaveBeenCalled();
  expect((await app.request('/orchestrators/owner/runs?before=40&limit=10')).status).toBe(200);
  expect(workspaceRuns).toHaveBeenCalledExactlyOnceWith('owner', 40, 10);
  workspaceRuns.mockReturnValueOnce(null as unknown as ReturnType<typeof workspaceRuns>);
  expect((await app.request('/orchestrators/missing/runs')).status).toBe(404);
});
