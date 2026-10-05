// HTTP routes for agent CLI sessions and runs. Validation lives here at the
// boundary (pstack boundary-discipline); the supervisor trusts internal types.

import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  AGENT_AUTONOMY,
  WORKSPACE_PRESETS,
  WORKSPACE_PRESET_INFO,
  type WorkspaceLayout,
} from '../../shared/types.js';
import type { Db } from '../db.js';
import { sessionUsage } from './usage.js';
import { getProjectRow, getSetting, setSetting } from '../store.js';
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
    terminal: z.enum(['pty', 'pipe']).optional(),
    cardId: z.number().int().positive().optional(),
    prompt: z.string().max(20_000).optional(),
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

const workspaceBody = z
  .object({
    preset: z.enum(WORKSPACE_PRESETS),
    panes: z.array(z.number().int().positive().nullable()).max(4),
    maximized: z.number().int().min(0).max(3).nullable(),
    fontSize: z.number().min(10).max(20).optional(),
  })
  .refine((l) => l.panes.length === WORKSPACE_PRESET_INFO[l.preset].panes, {
    message: 'panes must match the preset',
  });

const DEFAULT_WORKSPACE: WorkspaceLayout = { preset: '1', panes: [null], maximized: null };

const attachCardBody = z.object({
  cardId: z.number().int().positive().nullable(),
  send: z.boolean().optional(),
  prompt: z.string().max(20_000).optional(),
});

const resizeBody = z.object({
  cols: z.number().int().min(20).max(500),
  rows: z.number().int().min(5).max(200),
});

const dispatchBody = z.object({
  providerId: z.string().min(1).max(40).optional(),
  autonomy: z.enum(AGENT_AUTONOMY).optional(),
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

  app.get('/agent-sessions', (c) => c.json(supervisor.listAllSessions()));

  // Token usage per session (?ids=1,2,3), read from the CLIs' own transcripts. Registered before
  // /agent-sessions/:id so "usage" is never taken for an id.
  app.get('/agent-sessions/usage', (c) => {
    const ids = (c.req.query('ids') ?? '')
      .split(',')
      .map(Number)
      .filter((n) => Number.isInteger(n) && n > 0)
      .slice(0, 200);
    return c.json(sessionUsage(db, ids));
  });

  // ---- Workspace layout (persisted server-side so it survives reloads, restarts, reboots) ----
  app.get('/workspace', (c) => {
    const saved = getSetting<WorkspaceLayout>(db, 'workspace');
    const parsed = workspaceBody.safeParse(saved);
    const layout = parsed.success ? parsed.data : DEFAULT_WORKSPACE;
    // Self-heal: panes pointing at deleted sessions become empty.
    const panes = layout.panes.map((id) => (id !== null && supervisor.getSession(id) ? id : null));
    return c.json({ ...layout, panes });
  });

  app.put('/workspace', async (c) => {
    const layout = await parseBody(c, workspaceBody);
    setSetting(db, 'workspace', layout);
    return c.json(layout);
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

  // Attach a Kanban card to an existing session (keeps the agent's context); null detaches.
  app.post('/agent-sessions/:id/card', async (c) => {
    const body = await parseBody(c, attachCardBody);
    const { cardId, ...options } = body;
    return c.json(supervisor.attachCard(parseId(c), cardId, options));
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

  app.post('/agent-sessions/:id/resize', async (c) => {
    const body = await parseBody(c, resizeBody);
    if (!supervisor.resizeSession(parseId(c), body.cols, body.rows)) {
      throw new AgentError(404, 'Session not found');
    }
    return c.json({ ok: true });
  });

  // Live output as server-sent events: `output` events carry { data, nextOffset }, a `state`
  // event reports when the process stops. Resumes from ?after= so reconnects never duplicate.
  app.get('/agent-sessions/:id/stream', (c) => {
    const id = parseId(c);
    const start = offsetParam.safeParse(c.req.query('after') ?? '0');
    if (!supervisor.getSession(id)) throw new AgentError(404, 'Session not found');
    return streamSSE(c, async (stream) => {
      let offset = start.success ? start.data : 0;
      // `pending` makes wake-ups sticky: output that lands while we're busy writing (not yet
      // waiting) must not be lost, or the stream would stall until the next timeout.
      let pending = false;
      let wake: (() => void) | null = null;
      const notify = () => {
        pending = true;
        wake?.();
      };
      const event = `output:session:${id}`;
      supervisor.events.on(event, notify);
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
        notify();
      });
      let lastRunning: boolean | null = null;
      try {
        while (!aborted) {
          pending = false;
          const out = supervisor.readSessionOutput(id, offset);
          if (!out) break; // Session deleted.
          if (out.data) {
            offset = out.nextOffset;
            await stream.writeSSE({
              event: 'output',
              data: JSON.stringify({ data: out.data, nextOffset: offset }),
            });
            continue; // Drain everything available before waiting.
          }
          if (out.running !== lastRunning) {
            lastRunning = out.running;
            await stream.writeSSE({
              event: 'state',
              data: JSON.stringify({ running: out.running, exitCode: out.exitCode }),
            });
          }
          // Wait for new output, or wake periodically to notice state changes / keep alive.
          await new Promise<void>((resolve) => {
            if (pending || aborted) return resolve();
            const timer = setTimeout(resolve, out.running ? 15_000 : 2_000);
            wake = () => {
              clearTimeout(timer);
              resolve();
            };
          });
          wake = null;
        }
      } finally {
        supervisor.events.off(event, notify);
      }
    });
  });

  app.post('/agent-sessions/:id/start', async (c) => {
    try {
      return c.json(await supervisor.startSession(parseId(c)));
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
  app.get('/agent-runs', (c) => c.json(supervisor.listAllRuns()));

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
