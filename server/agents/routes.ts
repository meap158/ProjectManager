// HTTP routes for agent CLI sessions and runs. Validation lives here at the
// boundary (pstack boundary-discipline); the supervisor trusts internal types.

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import type { Db } from '../db.js';
import { getProjectRow } from '../store.js';
import { providerStatuses } from './providers.js';
import { AgentError, AgentSupervisor } from './supervisor.js';

const idParam = z.coerce.number().int().positive();
const offsetParam = z.coerce.number().int().min(0).default(0);

const commandSchema = z.array(z.string().min(1).max(8192)).min(1).max(32);
const envSchema = z.record(z.string(), z.string().max(8192));

const createSessionBody = z
  .object({
    providerId: z.string().min(1).max(40).optional(),
    command: commandSchema.optional(),
    name: z.string().trim().min(1).max(80).optional(),
    cwd: z.string().min(1).max(1024).optional(),
    supervise: z.boolean().optional(),
    env: envSchema.optional(),
  })
  .refine((b) => b.providerId || b.command, { message: 'providerId or command is required' });

const patchSessionBody = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  supervise: z.boolean().optional(),
});

const inputBody = z.object({
  data: z
    .string()
    .min(1)
    .max(64 * 1024),
});

const dispatchBody = z.object({
  providerId: z.string().min(1).max(40).optional(),
  command: commandSchema.optional(),
  prompt: z.string().max(20_000).optional(),
  timeoutMin: z.number().positive().max(240).optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

const validateBody = z.object({
  decision: z.enum(['accepted', 'rejected']),
  moveTo: z.enum(['review', 'done']).optional(),
});

function parseId(c: Context, name = 'id'): number {
  const result = idParam.safeParse(c.req.param(name));
  if (!result.success) throw new AgentError(404, 'Not found');
  return result.data;
}

async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new AgentError(400, 'Request body must be valid JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success)
    throw new AgentError(400, result.error.issues[0]?.message ?? 'Invalid request');
  return result.data;
}

function requireProject(db: Db, c: Context): number {
  const id = parseId(c);
  if (!getProjectRow(db, id)) throw new AgentError(404, 'Project not found');
  return id;
}

export function registerAgentRoutes(app: Hono, db: Db, supervisor: AgentSupervisor): void {
  // ---- Providers ------------------------------------------------------------------------------
  app.get('/agents/providers', async (c) => c.json(await providerStatuses()));

  // ---- Sessions -------------------------------------------------------------------------------
  app.get('/projects/:id/agent-sessions', (c) => {
    const projectId = requireProject(db, c);
    return c.json(supervisor.listSessions(projectId));
  });

  app.post('/projects/:id/agent-sessions', async (c) => {
    const projectId = requireProject(db, c);
    const body = await parseBody(c, createSessionBody);
    try {
      const session = await supervisor.createSession(projectId, body);
      return c.json(session, 201);
    } catch (e) {
      if (e instanceof AgentError) throw e;
      throw new AgentError(400, (e as Error).message);
    }
  });

  app.get('/agent-sessions/:id', (c) => {
    const session = supervisor.getSession(parseId(c));
    if (!session) throw new AgentError(404, 'Session not found');
    return c.json(session);
  });

  app.patch('/agent-sessions/:id', async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, patchSessionBody);
    let session = supervisor.getSession(id);
    if (!session) throw new AgentError(404, 'Session not found');
    if (body.name !== undefined) session = supervisor.renameSession(id, body.name) ?? session;
    if (body.supervise !== undefined)
      session = supervisor.setSupervise(id, body.supervise) ?? session;
    return c.json(session);
  });

  app.post('/agent-sessions/:id/input', async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, inputBody);
    try {
      const { queued, session } = supervisor.sendInput(id, body.data);
      if (!session) throw new AgentError(404, 'Session not found');
      return c.json({ queued, session });
    } catch (e) {
      if (e instanceof AgentError) throw e;
      throw new AgentError(400, (e as Error).message);
    }
  });

  app.get('/agent-sessions/:id/output', (c) => {
    const after = offsetParam.safeParse(c.req.query('after') ?? '0');
    const output = supervisor.readSessionOutput(parseId(c), after.success ? after.data : 0);
    if (!output) throw new AgentError(404, 'Session not found');
    return c.json(output);
  });

  app.post('/agent-sessions/:id/start', (c) => {
    try {
      return c.json(supervisor.startSession(parseId(c)));
    } catch (e) {
      if (e instanceof AgentError) throw e;
      throw new AgentError(400, (e as Error).message);
    }
  });

  app.post('/agent-sessions/:id/stop', async (c) => {
    const session = await supervisor.stopSession(parseId(c));
    if (!session) throw new AgentError(404, 'Session not found');
    return c.json(session);
  });

  app.delete('/agent-sessions/:id', async (c) => {
    if (!(await supervisor.removeSession(parseId(c))))
      throw new AgentError(404, 'Session not found');
    return c.body(null, 204);
  });

  // ---- Runs -----------------------------------------------------------------------------------
  app.get('/projects/:id/agent-runs', (c) => {
    const projectId = requireProject(db, c);
    const cardId = c.req.query('cardId');
    if (cardId !== undefined) {
      const parsed = idParam.safeParse(cardId);
      if (!parsed.success) throw new AgentError(400, 'Invalid cardId');
      return c.json(supervisor.listRuns(projectId, parsed.data));
    }
    return c.json(supervisor.listRuns(projectId));
  });

  app.get('/projects/:id/agent-runs/summary', (c) => {
    const projectId = requireProject(db, c);
    return c.json(supervisor.cardSummaries(projectId));
  });

  app.post('/projects/:id/cards/:cardId/dispatch', async (c) => {
    const projectId = requireProject(db, c);
    const parsed = idParam.safeParse(c.req.param('cardId'));
    if (!parsed.success) throw new AgentError(404, 'Card not found');
    const body = await parseBody(c, dispatchBody);
    try {
      const run = await supervisor.dispatchCard(projectId, parsed.data, body);
      return c.json(run, 201);
    } catch (e) {
      if (e instanceof AgentError) throw e;
      throw new AgentError(400, (e as Error).message);
    }
  });

  app.get('/agent-runs/:id', (c) => {
    const run = supervisor.getRun(parseId(c));
    if (!run) throw new AgentError(404, 'Run not found');
    return c.json(run);
  });

  app.get('/agent-runs/:id/output', (c) => {
    const after = offsetParam.safeParse(c.req.query('after') ?? '0');
    const output = supervisor.readRunOutput(parseId(c), after.success ? after.data : 0);
    if (!output) throw new AgentError(404, 'Run not found');
    return c.json(output);
  });

  app.post('/agent-runs/:id/stop', async (c) => {
    const run = await supervisor.stopRun(parseId(c));
    if (!run) throw new AgentError(404, 'Run not found');
    return c.json(run);
  });

  app.post('/agent-runs/:id/retry', (c) => {
    try {
      return c.json(supervisor.retryRun(parseId(c)), 201);
    } catch (e) {
      if (e instanceof AgentError) throw e;
      throw new AgentError(400, (e as Error).message);
    }
  });

  app.post('/agent-runs/:id/validate', async (c) => {
    const body = await parseBody(c, validateBody);
    try {
      return c.json(supervisor.validateRun(parseId(c), body.decision, body.moveTo));
    } catch (e) {
      if (e instanceof AgentError) throw e;
      throw new AgentError(400, (e as Error).message);
    }
  });

  app.delete('/agent-runs/:id', async (c) => {
    if (!(await supervisor.removeRun(parseId(c)))) throw new AgentError(404, 'Run not found');
    return c.body(null, 204);
  });
}
