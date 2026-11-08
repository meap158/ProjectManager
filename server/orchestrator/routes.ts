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
  delegateToSessions: z.boolean().optional(),
  superviseSessions: z.boolean().optional(),
  autoCheck: z.boolean().optional(),
  planFromGoals: z.boolean().optional(),
  acceptReviews: z.boolean().optional(),
  gitAutonomy: z.boolean().optional(),
  projectIds: z.array(z.number().int().positive()).max(500),
  priorityProjectIds: z.array(z.number().int().positive()).max(500).optional(),
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
    focus: z.enum(['all', 'todo', 'in_progress', 'review', 'attention', 'plan', 'goal']).optional(),
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
    app.get('/orchestrators/:id/chat-state', (c) => c.json(chat.chatState(c.req.param('id'))));
    // One card handed to the running chat (PM-202): scoped, never starts the chat.
    app.post('/orchestrators/:id/send-card', async (c) => {
      const parsed = z
        .object({ cardId: z.number().int().positive() })
        .strict()
        .safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ error: 'Invalid card request' }, 400);
      return c.json(chat.sendCard(c.req.param('id'), parsed.data.cardId));
    });
    // Goals (PM-433): what the orchestrator pursues until done, and the owner's controls.
    // A goal's optional limits (PM-473): automatic checks and days per budget window.
    const goalBudget = z
      .object({
        checks: z.number().int().min(1).max(500).optional(),
        days: z.number().min(0.1).max(365).optional(),
      })
      .strict();
    const goalInput = z
      .object({
        title: z.string().trim().min(1).max(120),
        objective: z.string().trim().min(1).max(4000),
        doneWhen: z.string().trim().min(1).max(2000),
        projectIds: z.array(z.number().int().positive()).max(50).optional(),
        cards: z
          .array(z.union([z.string().trim().min(1).max(40), z.number().int().positive()]))
          .max(60)
          .optional(),
        criteria: z.array(z.string().trim().min(1).max(500)).max(12).optional(),
        budget: goalBudget.optional(),
      })
      .strict();
    const cardRefs = z
      .array(z.union([z.string().trim().min(1).max(40), z.number().int().positive()]))
      .max(60);
    const goalChange = z
      .object({
        status: z.enum(['active', 'paused', 'blocked', 'achieved', 'dropped']).optional(),
        note: z.string().trim().min(1).max(2000).optional(),
        linkCards: cardRefs.optional(),
        unlinkCards: cardRefs.optional(),
        projectIds: z.array(z.number().int().positive()).max(50).optional(),
        /** Close it although linked cards are open (PM-454), after the owner confirmed. */
        force: z.boolean().optional(),
        /** With "achieved": accept its linked cards in Review as Done. */
        acceptReview: z.boolean().optional(),
        /** New limits (PM-473); null removes them. */
        budget: goalBudget.nullable().optional(),
        /** Criteria the owner confirms as passing (PM-524). */
        confirmCriteria: z.array(z.number().int().positive()).max(12).optional(),
      })
      .strict()
      .refine(
        (v) =>
          v.status ||
          v.note ||
          v.linkCards ||
          v.unlinkCards ||
          v.projectIds ||
          v.budget !== undefined ||
          Boolean(v.confirmCriteria?.length),
        'Give a status, a note, cards, projects or a budget',
      );
    app.get('/orchestrators/goals/recent', (c) => c.json(chat.goalEvents()));
    // The goals a card is linked to (PM-467), for the card dialog.
    app.get('/orchestrators/goals/by-card/:cardId', (c) =>
      c.json(chat.goalsForCard(Number(c.req.param('cardId')))),
    );
    // The full text behind a cut-off Activity entry (PM-452).
    app.get('/orchestrators/event-details/:id', (c) => {
      const text = chat.eventDetail(Number(c.req.param('id')));
      return text === null ? c.json({ error: 'No such detail' }, 404) : c.json({ text });
    });
    // Entries recorded before details were kept: found in the goal and message stores.
    app.get('/orchestrators/:id/event-text', (c) => {
      const action = c.req.query('action') ?? '';
      const message = (c.req.query('message') ?? '').slice(0, 1000);
      const text = chat.eventFullText(c.req.param('id'), action, message);
      return text === null ? c.json({ error: 'Not kept' }, 404) : c.json({ text });
    });
    app.get('/orchestrators/:id/goals', (c) => c.json(chat.goals(c.req.param('id'))));
    app.post('/orchestrators/:id/goals', async (c) => {
      const parsed = goalInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success)
        return c.json({ error: 'Give a title, the objective and when it is done' }, 400);
      try {
        return c.json(chat.addOwnerGoal(c.req.param('id'), parsed.data));
      } catch (e) {
        if (e instanceof Error && /already active/.test(e.message))
          return c.json({ error: e.message }, 409);
        if (e instanceof Error && /not in this orchestrator|at most/.test(e.message))
          return c.json({ error: e.message }, 400);
        throw e;
      }
    });
    // The owner's Follow up (PM-456): the chat checks that goal's cards and workers now.
    app.post('/orchestrators/:id/goals/:goalId/follow-up', async (c) => {
      const goalId = Number(c.req.param('goalId'));
      if (!Number.isInteger(goalId)) return c.json({ error: 'Invalid goal' }, 400);
      return c.json(await chat.check(c.req.param('id'), 'goal', [], goalId));
    });
    app.patch('/orchestrators/:id/goals/:goalId', async (c) => {
      const goalId = Number(c.req.param('goalId'));
      const parsed = goalChange.safeParse(await c.req.json().catch(() => null));
      if (!Number.isInteger(goalId) || !parsed.success)
        return c.json({ error: 'Invalid goal change' }, 400);
      try {
        return c.json(chat.updateOwnerGoal(c.req.param('id'), goalId, parsed.data));
      } catch (e) {
        if (e instanceof Error && /No goal/.test(e.message))
          return c.json({ error: e.message }, 404);
        if (e instanceof Error && /still open/.test(e.message))
          return c.json({ error: e.message }, 409);
        if (e instanceof Error && /not in this orchestrator|at most/.test(e.message))
          return c.json({ error: e.message }, 400);
        if (e instanceof Error && /already active/.test(e.message))
          return c.json({ error: e.message }, 409);
        throw e;
      }
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
