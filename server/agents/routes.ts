import path from 'node:path';
import { GrokAccounts } from './grokAccounts.js';
import {
  antigravityAccounts,
  switchAntigravityAccount,
  saveAntigravityAccount,
  importAntigravityAccount,
  refreshAntigravityAccount,
  renameAntigravityAccount,
  removeAntigravityAccount,
} from './antigravityAccounts.js';
// HTTP routes for agent CLI sessions and runs. Validation lives here at the
// boundary (pstack boundary-discipline); the supervisor trusts internal types.

import { Hono, type Context } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import {
  AGENT_AUTONOMY,
  WORKSPACE_PRESETS,
  WORKSPACE_PRESET_INFO,
  type CpuBudget,
  type WorkspaceLayout,
} from '../../shared/types.js';
import type { Db } from '../db.js';
import { sessionUsage } from './usage.js';
import { getProjectRow, getSetting, setSetting } from '../store.js';
import { providerStatuses } from './providers.js';
import {
  AUTO_PROVIDERS,
  claudeOffersAuto,
  getPermissions,
  PERMISSION_PROVIDERS,
  setPermissions,
} from './permissions.js';
import { getCpuBudget, setCpuBudget, totalThreads } from './cpuBudget.js';
import { slashCommands, suggestFiles } from './completions.js';
import { findTranscript, readSubagent, readTranscript, transcriptSource } from './transcript.js';
import { readSensors } from './sensors.js';
import { readProviderTranscript } from './providerTranscripts.js';
import { AgentError, AgentSupervisor } from './supervisor.js';
import { removeSessionImages } from '../attachments.js';

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

/** Output events to one terminal are at most this far apart while the process runs (~60/s). */
const STREAM_BATCH_MS = 16;

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
  // Global agent permissions + per-CLI overrides (Settings). Applied at each session launch.
  // With whether the installed Claude Code offers auto mode (asked once, from its --help).
  app.get('/agents/permissions', async (c) =>
    c.json({ ...getPermissions(db), claudeAuto: await claudeOffersAuto('claude') }),
  );

  app.put('/agents/permissions', async (c) => {
    const level = z.enum(['cli', 'read', 'edit', 'full']);
    const body = await parseBody(
      c,
      z.object({
        global: level,
        providers: z
          .record(z.string(), z.union([level, z.literal('auto'), z.literal('inherit')]))
          .refine((r) => Object.keys(r).every((id) => PERMISSION_PROVIDERS.includes(id)), {
            message: 'Unknown agent CLI',
          })
          // Auto mode is Claude Code's own: no other CLI has it.
          .refine(
            (r) =>
              Object.entries(r).every(([id, v]) => v !== 'auto' || AUTO_PROVIDERS.includes(id)),
            { message: 'Only Claude Code has an auto mode' },
          ),
      }),
    );
    return c.json(setPermissions(db, body));
  });

  // CPU budget for agent processes (Settings): applied at once to everything running.
  const budgetWithGovernor = (budget: CpuBudget): CpuBudget => {
    const stats = supervisor.cpuGovernorStats();
    return {
      ...budget,
      // The governor's own reading of the machine, so it and the agents' share are one sample.
      usagePercent: stats?.machinePercent ?? budget.usagePercent,
      agentPercent: stats?.agentPercent ?? null,
      allowedThreads: stats?.allowedThreads ?? null,
    };
  };
  app.get('/agents/cpu-budget', (c) => c.json(budgetWithGovernor(getCpuBudget(db))));

  app.put('/agents/cpu-budget', async (c) => {
    const body = await parseBody(
      c,
      z.object({ threads: z.number().int().min(1).max(totalThreads()) }),
    );
    const budget = setCpuBudget(db, body.threads);
    void supervisor.refreshCpuBudget();
    return c.json(budgetWithGovernor(budget));
  });

  // CPU temperature and fan speeds beside the budget (PM-113). Read-only, briefly cached.
  app.get('/agents/sensors', async (c) => c.json(await readSensors()));

  app.get('/agents/providers', async (c) => {
    const refresh = c.req.query('refresh');
    return c.json(await providerStatuses(refresh !== undefined));
  });

  // ---- Agent installs (Settings: one-click CLI installs) ---------------------------------------
  // The recipe is public (review before consent); only this POST executes anything.

  app.post('/agents/providers/:providerId/install', async (c) => {
    try {
      return c.json(await supervisor.startInstall(c.req.param('providerId')), 201);
    } catch (e) {
      if (e instanceof AgentError) throw e;
      throw new AgentError(400, (e as Error).message);
    }
  });

  app.get('/agent-installs', (c) => c.json(supervisor.listInstalls()));

  app.get('/agent-installs/:id/output', (c) => {
    const after = offsetParam.safeParse(c.req.query('after') ?? '0');
    const output = supervisor.readInstallOutput(parseId(c), after.success ? after.data : 0);
    if (!output) throw new AgentError(404, 'Install not found');
    return c.json(output);
  });

  app.delete('/agent-installs/:id', async (c) => {
    if (!(await supervisor.removeInstall(parseId(c))))
      throw new AgentError(404, 'Install not found');
    return c.body(null, 204);
  });

  // ---- Codex accounts (PM-164: saved auth.json profiles + automatic usage-limit rotation) ----
  app.get('/agents/antigravity-accounts', async (c) => c.json(await antigravityAccounts()));
  const grokService = supervisor.dataDir ? new GrokAccounts(supervisor.dataDir) : null;
  const grokAccounts = () => {
    if (!grokService) throw new AgentError(400, 'Account storage is unavailable');
    return grokService;
  };
  const grokId = (id: string) =>
    z
      .string()
      .regex(/^grok_[a-f0-9]{32}$/)
      .parse(id);
  const grokBody = async (c: Context): Promise<unknown> => {
    try {
      return await c.req.json();
    } catch {
      throw new AgentError(400, 'Request body must be valid JSON.');
    }
  };
  app.get('/agents/grok-accounts', (c) =>
    c.json(grokAccounts().state(c.req.query('refresh') === 'stale')),
  );
  app.post('/agents/grok-accounts', async (c) => {
    const body = z
      .object({
        name: z.string().trim().max(160).optional(),
        authJson: z.string().max(65536).optional(),
      })
      .parse(await grokBody(c));
    return c.json(
      await (body.authJson !== undefined
        ? grokAccounts().import(body.authJson, body.name)
        : grokAccounts().saveCurrent(body.name)),
    );
  });
  app.post('/agents/grok-accounts/usage', async (c) => c.json(await grokAccounts().refresh()));
  app.post('/agents/grok-accounts/:id/usage', async (c) =>
    c.json(
      await grokAccounts().refresh(
        c.req.param('id') === 'default' ? 'default' : grokId(c.req.param('id')),
      ),
    ),
  );
  app.put('/agents/grok-accounts/active', async (c) => {
    const body = z.object({ accountId: z.string() }).parse(await grokBody(c));
    return c.json(await grokAccounts().switch(grokId(body.accountId)));
  });
  app.patch('/agents/grok-accounts/:id', async (c) => {
    const body = z.object({ name: z.string().trim().min(1).max(160) }).parse(await grokBody(c));
    return c.json(await grokAccounts().rename(grokId(c.req.param('id')), body.name));
  });
  app.delete('/agents/grok-accounts/:id', async (c) =>
    c.json(await grokAccounts().remove(grokId(c.req.param('id')))),
  );
  app.post('/agents/antigravity-accounts/:id/usage', async (c) =>
    c.json(
      await refreshAntigravityAccount(
        z
          .string()
          .regex(/^(default|acct_[a-f0-9]{24})$/)
          .parse(c.req.param('id')),
      ),
    ),
  );
  app.patch('/agents/antigravity-accounts/:id', async (c) => {
    const { name } = z
      .object({ name: z.string().trim().min(1).max(160) })
      .parse(await c.req.json());
    return c.json(
      await renameAntigravityAccount(
        z
          .string()
          .regex(/^acct_[a-f0-9]{24}$/)
          .parse(c.req.param('id')),
        name,
      ),
    );
  });
  app.delete('/agents/antigravity-accounts/:id', async (c) =>
    c.json(
      await removeAntigravityAccount(
        z
          .string()
          .regex(/^acct_[a-f0-9]{24}$/)
          .parse(c.req.param('id')),
      ),
    ),
  );
  app.post('/agents/antigravity-accounts', async (c) => {
    const body = z
      .object({
        name: z.string().trim().max(160).optional(),
        authJson: z.string().max(65536).optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await (body.authJson
        ? importAntigravityAccount(body.authJson, body.name)
        : saveAntigravityAccount(body.name)),
    );
  });
  app.post('/agents/antigravity-accounts/usage', async (c) =>
    c.json(await antigravityAccounts(true)),
  );
  app.put('/agents/antigravity-accounts/active', async (c) => {
    const { accountId } = z
      .object({
        accountId: z
          .string()
          .regex(/^acct_[a-zA-Z0-9_-]+$/)
          .max(200),
      })
      .parse(await c.req.json());
    return c.json(await switchAntigravityAccount(accountId));
  });
  // ?refresh=stale (the accounts panel): also re-read missing or old usage in the background.
  app.get('/agents/codex-accounts', (c) =>
    c.json(supervisor.codexAccountsState(c.req.query('refresh') === 'stale')),
  );
  app.post('/agents/codex-accounts/:accountId/usage', async (c) => {
    const id = z.union([z.literal('default'), z.string().uuid()]).parse(c.req.param('accountId'));
    return c.json(await supervisor.refreshCodexAccountsUsage(id));
  });
  app.post('/agents/codex-accounts/usage', async (c) =>
    c.json(await supervisor.refreshCodexAccountsUsage()),
  );

  app.post('/agents/codex-accounts', async (c) => {
    const body = await parseBody(
      c,
      z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          authJson: z
            .string()
            .min(2)
            .max(64 * 1024)
            .optional(),
          saveCurrent: z.boolean().optional(),
        })
        .refine((b) => b.saveCurrent || (b.name && b.authJson), {
          message: 'Provide name and authJson, or saveCurrent: true',
        }),
    );
    if (body.saveCurrent) {
      return c.json(supervisor.saveCurrentCodexAccount(body.name), 201);
    }
    return c.json(supervisor.importCodexAccount(body.name!, body.authJson!), 201);
  });

  app.put('/agents/codex-accounts/active', async (c) => {
    const body = await parseBody(
      c,
      z.object({ activeProfileId: z.string().trim().min(1).max(64).nullable() }),
    );
    return c.json(supervisor.setActiveCodexAccount(body.activeProfileId));
  });

  app.put('/agents/codex-accounts/auto-switch', async (c) => {
    const body = await parseBody(c, z.object({ autoSwitch: z.boolean() }));
    return c.json(supervisor.setCodexAutoSwitch(body.autoSwitch));
  });

  app.put('/agents/codex-accounts/order', async (c) => {
    const body = await parseBody(
      c,
      z.object({ ids: z.array(z.string().trim().min(1).max(64)).max(200) }),
    );
    return c.json(supervisor.setCodexAccountOrder(body.ids));
  });

  app.put('/agents/codex-accounts/:accountId/auto-switch', async (c) => {
    const body = await parseBody(c, z.object({ eligible: z.boolean() }));
    return c.json(
      supervisor.setCodexAccountAutoSwitchEligible(c.req.param('accountId'), body.eligible),
    );
  });

  app.patch('/agents/codex-accounts/:accountId', async (c) => {
    const body = await parseBody(c, z.object({ name: z.string().trim().min(1).max(80) }));
    return c.json(supervisor.renameCodexAccount(c.req.param('accountId'), body.name));
  });

  app.delete('/agents/codex-accounts/:accountId', (c) =>
    c.json(supervisor.removeCodexAccount(c.req.param('accountId'))),
  );

  // ---- Claude accounts (PM-169: saved .credentials.json profiles) -----------------------------
  app.get('/agents/claude-accounts', (c) => c.json(supervisor.claudeAccountsState()));

  app.post('/agents/claude-accounts', async (c) => {
    const body = await parseBody(
      c,
      z
        .object({
          name: z.string().trim().min(1).max(80).optional(),
          authJson: z
            .string()
            .min(2)
            .max(64 * 1024)
            .optional(),
          saveCurrent: z.boolean().optional(),
        })
        .refine((b) => b.saveCurrent || (b.name && b.authJson), {
          message: 'Provide name and authJson, or saveCurrent: true',
        }),
    );
    if (body.saveCurrent) {
      return c.json(supervisor.saveCurrentClaudeAccount(body.name), 201);
    }
    return c.json(supervisor.importClaudeAccount(body.name!, body.authJson!), 201);
  });

  app.put('/agents/claude-accounts/active', async (c) => {
    const body = await parseBody(
      c,
      z.object({ activeProfileId: z.string().trim().min(1).max(64).nullable() }),
    );
    return c.json(supervisor.setActiveClaudeAccount(body.activeProfileId));
  });

  app.put('/agents/claude-accounts/auto-switch', async (c) => {
    const body = await parseBody(c, z.object({ autoSwitch: z.boolean() }));
    return c.json(supervisor.setClaudeAutoSwitch(body.autoSwitch));
  });

  app.patch('/agents/claude-accounts/:accountId', async (c) => {
    const body = await parseBody(c, z.object({ name: z.string().trim().min(1).max(80) }));
    return c.json(supervisor.renameClaudeAccount(c.req.param('accountId'), body.name));
  });

  app.delete('/agents/claude-accounts/:accountId', (c) =>
    c.json(supervisor.removeClaudeAccount(c.req.param('accountId'))),
  );

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

  // Plan usage limits (5-hour / weekly) the CLIs record locally; no tokens spent (PM-17).
  app.get('/agent-limits', (c) => {
    const current = (state: ReturnType<AgentSupervisor['codexAccountsState']>) =>
      state.accounts.find((a) => a.id === state.activeProfileId) ?? state.defaultAccount;
    const codexAccount = current(supervisor.codexAccountsState(true));
    const claudeAccount = current(supervisor.claudeAccountsState());
    const decorate = (account: typeof codexAccount) =>
      account?.limits
        ? {
            ...account.limits,
            accountEmail: account.email,
            accountName: 'name' in account ? account.name : null,
            accountPlan: account.plan,
          }
        : null;
    const claude = decorate(claudeAccount);
    const codex = decorate(codexAccount);
    return c.json([claude, codex].filter((value) => value !== null));
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

  // Chat view (mobile): the CLI's own transcript, read incrementally from `after`.
  app.get('/agent-sessions/:id/transcript', async (c) => {
    const resume = supervisor.sessionResume(parseId(c));
    if (!resume) throw new AgentError(404, 'Session not found');
    const after = c.req.query('after');
    const offset = after === undefined ? undefined : Number(after);
    if (offset !== undefined && (!Number.isSafeInteger(offset) || offset < 0))
      throw new AgentError(400, 'Invalid offset');
    if (
      resume.providerId === 'opencode' ||
      resume.providerId === 'grok' ||
      resume.providerId === 'antigravity'
    ) {
      const id = parseId(c);
      const session = supervisor.getSession(id);
      if (!session) throw new AgentError(404, 'Session not found');
      let resumeJson = resume.resumeJson;
      const running = session.status === 'running';
      // A new OpenCode / Antigravity session: its conversation gets pinned once it exists.
      if (!resumeJson && running && resume.providerId !== 'grok') {
        await supervisor.pinConversation(id);
        resumeJson = supervisor.sessionResume(id)?.resumeJson ?? null;
        // Nothing sent yet: an empty chat, not "started before pinning" (the first message
        // starts the conversation, and the next poll finds it).
        if (!resumeJson) return c.json({ supported: true, items: [], next: 0, reset: false });
      }
      return c.json(
        await readProviderTranscript(resume.providerId, resumeJson, session.cwd, offset),
      );
    }
    const source = transcriptSource(resume.providerId, resume.resumeJson, resume.codexHome);
    const file = source ? await findTranscript(source) : null;
    if (!file) return c.json({ supported: !!source, items: [], next: 0, reset: false });
    return c.json({ supported: true, ...(await readTranscript(file, resume.providerId, offset)) });
  });

  // A Claude subagent's own steps (PM-123), for the Agent/Task tool call that started it.
  app.get('/agent-sessions/:id/subagent', async (c) => {
    const resume = supervisor.sessionResume(parseId(c));
    if (!resume) throw new AgentError(404, 'Session not found');
    const source = transcriptSource(resume.providerId, resume.resumeJson, resume.codexHome);
    const file = source?.providerId === 'claude' ? await findTranscript(source) : null;
    const items = file ? await readSubagent(file, c.req.query('tool') ?? '') : null;
    return c.json({ items });
  });

  // Composer suggestions (PM-117): the CLI's slash commands, and project files for @-mentions
  // (matched here, so a phone never downloads a whole file list).
  app.get('/agent-sessions/:id/commands', async (c) => {
    const session = supervisor.getSession(parseId(c));
    if (!session) throw new AgentError(404, 'Session not found');
    return c.json(await slashCommands(session.providerId, session.cwd));
  });
  app.get('/agent-sessions/:id/files', async (c) => {
    const session = supervisor.getSession(parseId(c));
    if (!session) throw new AgentError(404, 'Session not found');
    const q = (c.req.query('q') ?? '').slice(0, 200);
    return c.json(await suggestFiles(session.cwd, q));
  });

  // What the session shows right now, as text: the chat view's live strip when the CLI asks.
  app.get('/agent-sessions/:id/screen', (c) => {
    const id = parseId(c);
    if (!supervisor.getSession(id)) throw new AgentError(404, 'Session not found');
    // The whole screen (bounded by the terminal's size): a menu with wrapped descriptions on a
    // narrow terminal ran past 1,600 characters, cutting off its question and first option.
    return c.json({ text: supervisor.sessionScreen(id, 12_000) ?? '' });
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
              data: JSON.stringify({
                data: out.data,
                nextOffset: offset,
                terminalSize: out.terminalSize,
              }),
            });
            // Batch bursts to about a frame: a busy TUI emits hundreds of tiny chunks a second,
            // and each would otherwise cost an event, a JSON.parse and a terminal write. The
            // first chunk after idle goes out at once; only what follows waits.
            if (out.running) await new Promise((resolve) => setTimeout(resolve, STREAM_BATCH_MS));
            continue; // Drain everything available before waiting.
          }
          if (out.running !== lastRunning) {
            lastRunning = out.running;
            await stream.writeSSE({
              event: 'state',
              data: JSON.stringify({
                running: out.running,
                exitCode: out.exitCode,
                logBytes: out.logBytes,
                nextOffset: out.nextOffset,
              }),
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

  app.post('/agent-sessions/:id/restart', async (c) =>
    c.json(await supervisor.restartSession(parseId(c))),
  );
  app.post('/agent-sessions/:id/auto-continue', async (c) => {
    const body = await parseBody(c, z.object({ enabled: z.boolean() }));
    return c.json(supervisor.setAutoContinue(parseId(c), body.enabled));
  });
  // "Try again" on the usage-limit notice (PM-58): continue once now, into an empty prompt.
  app.post('/agent-sessions/:id/continue-now', (c) => c.json(supervisor.continueNow(parseId(c))));
  app.post('/agent-sessions/:id/codex-account', async (c) => {
    const body = await parseBody(
      c,
      z.object({
        profileId: z.string().trim().min(1).max(64).nullable(),
        continuePrompt: z.boolean().optional(),
      }),
    );
    return c.json(
      await supervisor.switchSessionCodexAccount(parseId(c), body.profileId, {
        continuePrompt: body.continuePrompt,
        setGlobal: true,
      }),
    );
  });

  app.post('/agent-sessions/:id/stop', async (c) => {
    const session = await supervisor.stopSession(parseId(c));
    if (!session) throw new AgentError(404, 'Session not found');
    return c.json(session);
  });

  app.delete('/agent-sessions/:id', async (c) => {
    const id = parseId(c);
    if (!(await supervisor.removeSession(id))) throw new AgentError(404, 'Session not found');
    // Images sent into the session (PM-54) go with it.
    if (supervisor.dataDir) removeSessionImages(path.join(supervisor.dataDir, 'attachments'), id);
    return c.body(null, 204);
  });

  // ---- Runs -----------------------------------------------------------------------------------
  app.get('/agent-runs', (c) => c.json(supervisor.listAllRuns()));

  app.patch('/agent-runs/:id', async (c) => {
    const body = await parseBody(c, z.object({ name: z.string().trim().min(1).max(80) }));
    const run = supervisor.renameRun(parseId(c), body.name);
    if (!run) throw new AgentError(404, 'Run not found');
    return c.json(run);
  });

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

  app.post('/agent-runs/:id/resolve-unknown', async (c) => {
    const body = await parseBody(
      c,
      z.object({ nonce: z.string().uuid(), confirmation: z.literal('worker-stopped') }).strict(),
    );
    return c.json(await supervisor.resolveUnknownRun(parseId(c), body.nonce));
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
