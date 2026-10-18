import type { Hono } from 'hono';
import { z } from 'zod';
import type { OrchestratorService } from './service.js';
import type { OrchestratorChat } from './chat.js';
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
const chatOpen = z
  .object({ providerId: z.enum(['claude', 'codex', 'antigravity', 'opencode']).optional() })
  .strict();
const chatCheck = z
  .object({
    focus: z.enum(['all', 'todo', 'in_progress', 'review', 'attention']).optional(),
    attentionKinds: z
      .array(z.enum(['Folder missing', 'Scan failed', 'Stale', 'Uncommitted', 'Unpushed']))
      .min(1)
      .max(5)
      .optional(),
  })
  .strict();
export function registerOrchestratorRoutes(
  app: Hono,
  service: OrchestratorService,
  chat?: OrchestratorChat,
) {
  app.get('/orchestrators', (c) => c.json(service.state()));
  app.get('/orchestrators/overview', (c) => c.json(service.overview()));
  if (chat) {
    app.get('/orchestrators/:id/chat-work', (c) => c.json(chat.currentWork(c.req.param('id'))));
    // The master's own chat CLI (PM-89): open (or reopen) it, or ask it for a one-time check
    // on pending work. AgentErrors (404 / 409 / 400) carry their own status.
    app.post('/orchestrators/:id/chat', async (c) => {
      const parsed = chatOpen.safeParse((await c.req.json().catch(() => null)) ?? {});
      if (!parsed.success) return c.json({ error: 'Invalid chat request' }, 400);
      return c.json(await chat.open(c.req.param('id'), parsed.data.providerId));
    });
    app.post('/orchestrators/:id/check', async (c) => {
      const parsed = chatCheck.safeParse((await c.req.json().catch(() => null)) ?? {});
      if (!parsed.success) return c.json({ error: 'Invalid check request' }, 400);
      if (parsed.data.attentionKinds && parsed.data.focus !== 'attention')
        return c.json({ error: 'attentionKinds needs focus "attention"' }, 400);
      return c.json(
        await chat.check(c.req.param('id'), parsed.data.focus, parsed.data.attentionKinds),
      );
    });
  }
  // What the orchestrators see of Home, with trace-back identity (PM-70). Registered before
  // '/orchestrators/:id/…' so "situation" is never read as an id.
  app.get('/orchestrators/situation', (c) => c.json(service.situation()));
  app.get('/orchestrators/:id/situation', (c) => {
    const situation = service.situation(c.req.param('id'));
    return situation ? c.json(situation) : c.json({ error: 'Orchestrator not found' }, 404);
  });
  app.get('/orchestrators/:id/pending', (c) => {
    const page = z
      .object({
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(20),
        projectId: z.coerce.number().int().positive().optional(),
      })
      .strict()
      .safeParse(c.req.query());
    if (!page.success) return c.json({ error: 'Invalid pending page' }, 400);
    const result = service.pending(
      c.req.param('id'),
      page.data.offset,
      page.data.limit,
      page.data.projectId,
    );
    return result ? c.json(result) : c.json({ error: 'Orchestrator not found' }, 404);
  });
  app.get('/orchestrators/:id/summary', (c) => {
    const summary = service.workspaceSummary(c.req.param('id'));
    return summary ? c.json(summary) : c.json({ error: 'Orchestrator not found' }, 404);
  });
  app.get('/orchestrators/:id/actionable-runs', (c) => {
    const parsed = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        kind: z.enum(['all', 'live', 'review']).default('all'),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict()
      .safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid actionable run page' }, 400);
    const page = service.workspaceActionable(
      c.req.param('id'),
      parsed.data.before,
      parsed.data.limit,
      parsed.data.kind,
    );
    return page ? c.json(page) : c.json({ error: 'Orchestrator not found' }, 404);
  });
  app.get('/orchestrators/:id/runs', (c) => {
    const parsed = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        focus: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict()
      .safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid run page' }, 400);
    const page = service.workspaceRuns(
      c.req.param('id'),
      parsed.data.before,
      parsed.data.limit,
      parsed.data.focus,
    );
    return page ? c.json(page) : c.json({ error: 'Orchestrator not found' }, 404);
  });
  app.get('/orchestrators/:id/history-runs', (c) => {
    const parsed = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        focus: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(20),
      })
      .strict()
      .safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: 'Invalid run page' }, 400);
    const page = service.workspaceRuns(
      c.req.param('id'),
      parsed.data.before,
      parsed.data.limit,
      parsed.data.focus,
      true,
    );
    return page ? c.json(page) : c.json({ error: 'Orchestrator not found' }, 404);
  });
  app.get('/orchestrators/:id/preview', async (c) => {
    const page = z
      .object({
        offset: z.coerce.number().int().min(0).max(1000000).default(0),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .strict()
      .safeParse(c.req.query());
    if (!page.success) return c.json({ error: 'Invalid preview page' }, 400);
    const result = await service.preview(c.req.param('id'), page.data.offset, page.data.limit);
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
    await service.tick(undefined, { refreshQuota: true });
    return c.json(service.state());
  });
  app.post('/orchestrators/:id/tick', async (c) => {
    const id = c.req.param('id');
    if (!service.state().instances.some((instance) => instance.id === id))
      return c.json({ error: 'Orchestrator not found' }, 404);
    await service.tick(id, { refreshQuota: true });
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
