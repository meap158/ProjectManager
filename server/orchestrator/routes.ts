import type { Hono } from 'hono';
import { z } from 'zod';
import type { OrchestratorService } from './service.js';
const attentionScope = z.object({ projectId: z.number().int().positive().optional() }).strict();
const attentionDismiss = z
  .object({
    projectId: z.number().int().positive(),
    kinds: z
      .array(z.enum(['Folder missing', 'Scan failed', 'Stale', 'Uncommitted', 'Unpushed']))
      .max(5)
      .optional(),
  })
  .strict();
const config = z.object({
  id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  enabled: z.boolean(),
  strategy: z.enum(['observe', 'autonomous']).optional(),
  followDashboardAttention: z.boolean().optional(),
  pruneDashboardAttention: z.boolean().optional(),
  projectIds: z.array(z.number().int().positive()).max(500),
  providers: z
    .array(z.enum(['claude', 'codex', 'grok', 'antigravity', 'opencode']))
    .min(1)
    .max(5),
  maxWorkers: z.number().int().min(1).max(32),
  maxWorkersPerProject: z.number().int().min(1).max(8),
  maxWorkersPerProvider: z.number().int().min(1).max(16),
  reservePercent: z.number().min(0).max(90),
  allowUnknownQuota: z.boolean(),
  quotaMaxAgeMs: z.number().int().min(60000).max(86400000),
});
export function registerOrchestratorRoutes(app: Hono, service: OrchestratorService) {
  app.get('/orchestrators', (c) => c.json(service.state()));
  // What the orchestrators see of Home, with trace-back identity (PM-70). Registered before
  // '/orchestrators/:id/…' so "situation" is never read as an id.
  app.get('/orchestrators/situation', (c) => c.json(service.situation()));
  app.get('/orchestrators/:id/situation', (c) => {
    const situation = service.situation(c.req.param('id'));
    return situation ? c.json(situation) : c.json({ error: 'Orchestrator not found' }, 404);
  });
  app.get('/orchestrators/:id/preview', async (c) => {
    const result = await service.preview(c.req.param('id'));
    if (!result) return c.json({ error: 'Orchestrator not found' }, 404);
    return c.json(result);
  });
  app.post('/orchestrators', async (c) => {
    const parsed = config.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success)
      return c.json({ error: parsed.error.issues[0]?.message ?? 'Invalid configuration' }, 400);
    return c.json(service.save(parsed.data), 201);
  });
  app.post('/orchestrators/tick', async (c) => {
    await service.tick();
    return c.json(service.state());
  });
  app.post('/orchestrators/:id/tick', async (c) => {
    const id = c.req.param('id');
    if (!service.state().instances.some((instance) => instance.id === id))
      return c.json({ error: 'Orchestrator not found' }, 404);
    await service.tick(id);
    return c.json(service.state());
  });
  app.post('/orchestrators/prune-attention', async (c) => {
    const parsed = attentionScope.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid attention scope' }, 400);
    const body = parsed.data;
    const result = service.pruneAttention(undefined, body?.projectId);
    return c.json({ ok: true, result, state: service.state() });
  });
  app.post('/orchestrators/:id/prune-attention', async (c) => {
    const id = c.req.param('id');
    if (!service.state().instances.some((instance) => instance.id === id))
      return c.json({ error: 'Orchestrator not found' }, 404);
    const parsed = attentionScope.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid attention scope' }, 400);
    const body = parsed.data;
    const result = service.pruneAttention(id, body?.projectId);
    return c.json({ ok: true, result, state: service.state() });
  });
  app.post('/orchestrators/resolve-attention', async (c) => {
    const parsed = attentionScope.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid attention scope' }, 400);
    const body = parsed.data;
    const result = await service.resolveAttention(undefined, body?.projectId);
    return c.json({ ok: true, result, state: service.state() });
  });
  app.post('/orchestrators/:id/resolve-attention', async (c) => {
    const id = c.req.param('id');
    if (!service.state().instances.some((instance) => instance.id === id))
      return c.json({ error: 'Orchestrator not found' }, 404);
    const parsed = attentionScope.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid attention scope' }, 400);
    const body = parsed.data;
    const result = await service.resolveAttention(id, body?.projectId);
    return c.json({ ok: true, result, state: service.state() });
  });
  app.post('/orchestrators/dismiss-attention', async (c) => {
    const parsed = attentionDismiss.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid attention dismissal' }, 400);
    const body = parsed.data;
    const result = service.dismissAttention(body.projectId, body.kinds);
    return c.json({ ok: true, result, state: service.state() });
  });
  app.delete('/orchestrators/dismiss-attention/:projectId', (c) => {
    const pid = Number(c.req.param('projectId'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return c.json({ error: 'Invalid projectId' }, 400);
    service.clearDismissedAttention(pid);
    return c.json({ ok: true, state: service.state() });
  });
  app.delete('/orchestrators/events', (c) => {
    service.clearEvents();
    return c.json(service.state());
  });
  app.delete('/orchestrators/:id', (c) => {
    const id = c.req.param('id');
    const ok = service.delete(id);
    if (!ok) return c.json({ error: 'Orchestrator not found' }, 404);
    return c.json(service.state());
  });
}
