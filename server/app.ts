import { OrchestratorService } from './orchestrator/service.js';
import { registerOrchestratorRoutes } from './orchestrator/routes.js';
import { OrchestratorChat } from './orchestrator/chat.js';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compress } from 'hono/compress';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BOARD_PRESETS, CARD_STATUSES, SHORTCUT_IDS } from '../shared/types.js';
import type {
  DirectoryEntry,
  DirectoryListing,
  LanStatus,
  RemoteConfig,
  RemoteStatus,
  ShortcutOverrides,
} from '../shared/types.js';
import { LAN_HEADER } from './lan.js';
import { FileAccessError, listFolder, previewFile, readRaw } from './projectFiles.js';
import { REMOTE_HEADER } from './remote.js';
import type { Db } from './db.js';
import { Scanner } from './scanner.js';
import * as store from './store.js';
import { AgentError, AgentSupervisor } from './agents/supervisor.js';
import { registerAgentRoutes } from './agents/routes.js';
import { registerBoardMcp } from './boardMcp.js';
import {
  parsePullRequestNumber,
  pullRequestAction,
  pullRequestActionBody,
  PullRequestActionError,
  pullRequests,
} from './pullRequests.js';
import { openInFileManager } from './openFolder.js';
import { GH_LOGIN, ghAccountSettingKey, isLoggedIn } from './ghAccount.js';
import { getGitIdentity, gitIdentitySettingKey, validateGitIdentity } from './gitIdentity.js';
import {
  registerAttachmentRoutes,
  registerSessionImageRoutes,
  removeAttachments,
} from './attachments.js';

const idParam = z.coerce.number().int().positive();

const createProjectBody = z.object({
  path: z.string().trim().min(1, 'Folder path is required'),
  name: z.string().trim().max(120).optional(),
});
const createProjectsBatchBody = z.object({
  paths: z.array(z.string().trim().min(1, 'Folder path is required')).min(1).max(50),
});
const updateProjectBody = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    boardPreset: z.enum(BOARD_PRESETS).optional(),
  })
  .refine((b) => b.name !== undefined || b.boardPreset !== undefined, {
    message: 'Nothing to update',
  });
const createCardBody = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().max(20_000).default(''),
  status: z.enum(CARD_STATUSES).default('backlog'),
  issueUrl: z
    .string()
    .regex(
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*$/,
      'Use a GitHub issue URL',
    )
    .nullable()
    .optional(),
});
const themeBody = z.object({ theme: z.enum(['system', 'light', 'dark']) });
type ThemePreference = z.infer<typeof themeBody>['theme'];
const projectOrderBody = z.object({ order: z.array(z.number().int().positive()).max(5000) });
/** Modifiers in a fixed order, then one key ("Alt+Shift+C", "Ctrl+ArrowDown", "?"). */
const shortcutCombo = z
  .string()
  .max(40)
  .regex(/^(?:Ctrl\+)?(?:Alt\+)?(?:Shift\+)?(?:Meta\+)?[^+\s]{1,20}$/);
const shortcutsBody = z.object({
  overrides: z.partialRecord(z.enum(SHORTCUT_IDS), shortcutCombo.nullable()),
});

const updateCardBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000),
    status: z.enum(CARD_STATUSES),
    position: z.number().finite(),
    // 0 moves the card to no project ("All projects"); a real id assigns it.
    projectId: z.number().int().min(0),
    issueUrl: z
      .string()
      .regex(
        /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/[1-9]\d*$/,
        'Use a GitHub issue URL',
      )
      .nullable(),
  })
  .partial();

class HttpError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 413 | 415,
    message: string,
  ) {
    super(message);
  }
}

async function parseBody<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON');
  }
  const result = schema.safeParse(json);
  if (!result.success)
    throw new HttpError(400, result.error.issues[0]?.message ?? 'Invalid request');
  return result.data;
}

function parseId(c: Context, name = 'id'): number {
  const result = idParam.safeParse(c.req.param(name));
  if (!result.success) throw new HttpError(404, 'Not found');
  return result.data;
}

export type AppWithAgents = Hono & {
  supervisor: AgentSupervisor;
  scanner: Scanner;
  orchestrator: OrchestratorService;
};

export function createApp(
  db: Db,
  options: {
    allowedHosts?: string[];
    /** Opt-in LAN listener control (server/lan.ts); absent in tests. */
    lan?: {
      status(): LanStatus;
      setEnabled(enabled: boolean): Promise<LanStatus>;
      newCode(): LanStatus;
      signOut(id?: string): LanStatus;
    };
    /** Opt-in Cloudflare Tunnel listener control (server/remote.ts); absent in tests. */
    remote?: {
      status(): RemoteStatus;
      configure(input: RemoteConfig): Promise<RemoteStatus>;
      beginTotp(): RemoteStatus;
      confirmTotp(code: string): Promise<RemoteStatus>;
      setEnabled(enabled: boolean): Promise<RemoteStatus>;
      signOut(id?: string): RemoteStatus;
    };
    dataDir?: string;
    /** Run interactive sessions in the session host so they survive server restarts. */
    agentHost?: boolean;
    /** Apply Settings → CPU budget to agent processes (index.ts; tests leave it off). */
    cpuBudget?: boolean;
  } = {},
): AppWithAgents {
  const scanner = new Scanner(db);
  // Agent sessions/runs persist in SQLite + log files; the supervisor relaunches
  // supervised work after restarts and reboots (Quil-style). Tests pass a temp
  // dataDir; production passes config.dataDir from index.ts.
  const logDir = path.join(
    options.dataDir ?? path.join(os.tmpdir(), 'projectmanager-agent-logs'),
    'agent-logs',
  );
  const supervisor = new AgentSupervisor(db, logDir, {
    host: options.agentHost ?? false,
    cpuBudget: options.cpuBudget ?? false,
    ...(options.dataDir ? { dataDir: options.dataDir } : {}),
  });
  const app = new Hono().basePath('/api');
  const allowedHosts = new Set(options.allowedHosts ?? ['localhost', '127.0.0.1', '[::1]']);

  // This API can read any folder on the machine, so it only answers same-machine requests:
  //  - Host check blocks DNS-rebinding attacks from web pages.
  //  - Requiring JSON on writes blocks cross-site form posts (CORS is never enabled).
  app.use('*', async (c, next) => {
    const host = (c.req.header('host') ?? '').replace(/:\d+$/, '');
    if (!allowedHosts.has(host)) throw new HttpError(403, 'Forbidden host');
    if (!['GET', 'HEAD', 'DELETE'].includes(c.req.method)) {
      if (!c.req.header('content-type')?.includes('application/json')) {
        throw new HttpError(415, 'Content-Type must be application/json');
      }
    }
    await next();
  });

  // Shrink repeated dashboard payloads over LAN; event streams must flush immediately.
  app.use('*', compress({ threshold: 2048, contentTypeFilter: /^application\/json(?:;|$)/i }));

  app.onError((error, c) => {
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (error instanceof AgentError) return c.json({ error: error.message }, error.status);
    console.error('[api]', error);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  registerAgentRoutes(app, db, supervisor);
  const orchestrator = new OrchestratorService(db, supervisor, options.dataDir ?? null, () =>
    store.listProjects(db, (id) => scanner.state(id)),
  );
  const orchestratorChat = new OrchestratorChat(
    db,
    supervisor,
    orchestrator,
    () => store.listProjects(db, (id) => scanner.state(id)),
    options.dataDir ?? null,
  );
  registerOrchestratorRoutes(app, orchestrator, orchestratorChat);
  // Card images live beside the agent logs: <dataDir>/attachments/<cardId>/.
  const attachmentsRoot = path.join(path.dirname(logDir), 'attachments');
  registerAttachmentRoutes(app, db, attachmentsRoot);
  registerSessionImageRoutes(app, db, attachmentsRoot);
  registerBoardMcp(app, db, attachmentsRoot, orchestratorChat);

  // ---- Projects -------------------------------------------------------------------------------

  app.get('/projects', (c) => c.json(store.listProjects(db, (id) => scanner.state(id))));

  app.post('/projects', async (c) => {
    const body = await parseBody(c, createProjectBody);
    const folder = resolveFolder(body.path);
    const existing = store.findProjectByPath(db, folder);
    if (existing) throw new HttpError(409, `Already tracking this folder as "${existing.name}"`);
    const id = store.insertProject(db, body.name || path.basename(folder) || folder, folder);
    scanner.start(id);
    return c.json(store.getProject(db, id, scanner.state(id)), 201);
  });

  // Track several folders in one request. Per-folder failures (missing folder,
  // already tracked) are reported in `skipped` instead of failing the whole batch.
  app.post('/projects/batch', async (c) => {
    const body = await parseBody(c, createProjectsBatchBody);
    const added: NonNullable<ReturnType<typeof store.getProject>>[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const seen = new Set<string>();
    for (const raw of body.paths) {
      const input = raw.trim();
      if (!input || seen.has(input.toLowerCase())) continue;
      seen.add(input.toLowerCase());
      let folder: string;
      try {
        folder = resolveFolder(input);
      } catch (e) {
        skipped.push({
          path: input,
          reason: e instanceof HttpError ? e.message : 'Invalid folder',
        });
        continue;
      }
      const existing = store.findProjectByPath(db, folder);
      if (existing) {
        skipped.push({ path: input, reason: `Already tracking this folder as "${existing.name}"` });
        continue;
      }
      const id = store.insertProject(db, path.basename(folder) || folder, folder);
      scanner.start(id);
      const created = store.getProject(db, id, scanner.state(id));
      if (created) added.push(created);
    }
    return c.json({ added, skipped }, 201);
  });

  // The gh account chosen for a project in the Pull requests tab (null: automatic, i.e. the
  // repo owner's account when it is logged in, else gh's active one). See server/ghAccount.ts.
  const ghAccountOverride = (projectId: number) =>
    store.getSetting<string>(db, ghAccountSettingKey(projectId));

  app.put('/projects/:id/pull-requests/account', async (c) => {
    const project = store.getProjectRow(db, parseId(c));
    if (!project) throw new HttpError(404, 'Project not found');
    const { account } = await parseBody(
      c,
      z.object({ account: z.string().regex(GH_LOGIN, 'Not a GitHub login').nullable() }),
    );
    if (account === null) store.deleteSetting(db, ghAccountSettingKey(project.id));
    else {
      if (!(await isLoggedIn(account)))
        throw new HttpError(400, `${account} is not logged in to gh. Run gh auth login first.`);
      store.setSetting(db, ghAccountSettingKey(project.id), account);
    }
    return c.json({ override: account });
  });

  // The commit author agents use in a project's sessions and runs (PM-186). With the gh account
  // above it is the project's git identity; neither is written to the project folder.
  app.get('/projects/:id/git-identity', (c) => {
    const project = store.getProjectRow(db, parseId(c));
    if (!project) throw new HttpError(404, 'Project not found');
    return c.json(getGitIdentity(db, project.id));
  });

  app.put('/projects/:id/git-identity', async (c) => {
    const project = store.getProjectRow(db, parseId(c));
    if (!project) throw new HttpError(404, 'Project not found');
    const body = await parseBody(
      c,
      z.object({ name: z.string().max(200).nullable(), email: z.string().max(300).nullable() }),
    );
    const checked = validateGitIdentity(body);
    if (!checked.ok) throw new HttpError(400, checked.error);
    if (checked.value.name === null) store.deleteSetting(db, gitIdentitySettingKey(project.id));
    else store.setSetting(db, gitIdentitySettingKey(project.id), checked.value);
    return c.json(checked.value);
  });

  // ---- Files tab (PM-252): read-only tree and previews --------------------------------------
  const projectRoot = (c: Context) => {
    const project = store.getProjectRow(db, parseId(c));
    if (!project) throw new HttpError(404, 'Project not found');
    return project.path;
  };
  const fileErrors = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      if (error instanceof FileAccessError) throw new HttpError(error.status, error.message);
      throw error;
    }
  };

  app.get('/projects/:id/tree', async (c) => {
    const root = projectRoot(c);
    return c.json(await fileErrors(() => listFolder(root, c.req.query('path') ?? '')));
  });

  app.get('/projects/:id/file', async (c) => {
    const root = projectRoot(c);
    return c.json(await fileErrors(() => previewFile(root, c.req.query('path') ?? '')));
  });

  // Bytes for image previews and a previewed page's own styles and images. Never runnable on
  // this origin: a sandbox CSP and nosniff, so an .html or .svg can't script the app.
  app.get('/projects/:id/raw', async (c) => {
    const root = projectRoot(c);
    const { bytes, type } = await fileErrors(() => readRaw(root, c.req.query('path') ?? ''));
    return c.body(new Uint8Array(bytes), 200, {
      'content-type': type,
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-cache',
    });
  });

  app.get('/projects/:id/pull-requests', async (c) => {
    const project = store.getProjectRow(db, parseId(c));
    if (!project) throw new HttpError(404, 'Project not found');
    const state = c.req.query('state') ?? 'open';
    if (state !== 'open' && state !== 'closed')
      throw new HttpError(400, 'state must be open or closed');
    return c.json(await pullRequests(project.path, state, ghAccountOverride(project.id)));
  });

  // Act on one pull request (merge, close, branches…) through gh in the project folder. The
  // number and the action are validated here; pullRequests.ts re-reads the PR before acting.
  app.post('/projects/:id/pull-requests/:number/actions', async (c) => {
    const project = store.getProjectRow(db, parseId(c));
    if (!project) throw new HttpError(404, 'Project not found');
    const number = parsePullRequestNumber(c.req.param('number'));
    if (number === null) throw new HttpError(400, 'Pull request number must be a positive integer');
    const body = await parseBody(c, pullRequestActionBody);
    try {
      return c.json(
        await pullRequestAction(project.path, number, body, ghAccountOverride(project.id)),
      );
    } catch (error) {
      if (error instanceof PullRequestActionError)
        return c.json({ error: error.message }, error.status);
      throw error;
    }
  });

  app.get('/projects/:id', (c) => {
    const id = parseId(c);
    const project = store.getProject(db, id, scanner.state(id));
    if (!project) throw new HttpError(404, 'Project not found');
    return c.json(project);
  });

  app.patch('/projects/:id', async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, updateProjectBody);
    if (!store.getProjectRow(db, id)) throw new HttpError(404, 'Project not found');
    if (body.name !== undefined) store.renameProject(db, id, body.name);
    if (body.boardPreset !== undefined) store.setBoardPreset(db, id, body.boardPreset);
    return c.json(store.getProject(db, id, scanner.state(id)));
  });

  app.delete('/projects/:id', async (c) => {
    const id = parseId(c);
    // Only removes tracking data; files on disk are never touched.
    if (!store.getProjectRow(db, id)) throw new HttpError(404, 'Project not found');
    await supervisor.stopHostedProjectRuns(id);
    if (!store.deleteProject(db, id)) {
      if (store.getProjectRow(db, id))
        throw new HttpError(
          409,
          'Project still has active hosted workers; stop them before removing it',
        );
      throw new HttpError(404, 'Project not found');
    }
    store.deleteSetting(db, ghAccountSettingKey(id));
    store.deleteSetting(db, gitIdentitySettingKey(id));
    scanner.forget(id);
    await supervisor.onProjectDeleted(id);
    return c.body(null, 204);
  });

  app.post('/projects/:id/scan', (c) => {
    const id = parseId(c);
    const row = store.getProjectRow(db, id);
    if (!row) throw new HttpError(404, 'Project not found');
    if (!existsSync(row.path)) throw new HttpError(409, 'Folder no longer exists on disk');
    scanner.start(id);
    return c.json(store.getProject(db, id, scanner.state(id)), 202);
  });

  // Opens the project folder in the OS file manager. Uses the stored path, never request data.
  app.post('/projects/:id/open-folder', (c) => {
    // A window opening on this computer would surprise whoever tapped it on their phone.
    if (c.req.header(LAN_HEADER))
      throw new HttpError(403, 'Folders open on the computer running ProjectManager');
    const row = store.getProjectRow(db, parseId(c));
    if (!row) throw new HttpError(404, 'Project not found');
    if (!existsSync(row.path)) throw new HttpError(409, 'Folder no longer exists on disk');
    openInFileManager(row.path);
    return c.body(null, 204);
  });

  // ---- Cards ----------------------------------------------------------------------------------

  app.get('/projects/:id/cards', (c) => {
    const id = parseId(c);
    if (!store.getProjectRow(db, id)) throw new HttpError(404, 'Project not found');
    return c.json(store.listCards(db, id));
  });

  app.post('/projects/:id/cards', async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, createCardBody);
    if (!store.getProjectRow(db, id)) throw new HttpError(404, 'Project not found');
    return c.json(store.insertCard(db, id, body), 201);
  });

  app.get('/cards', (c) => c.json(store.listAllCards(db)));
  app.get('/cards/in-flight', (c) => c.json(store.listCardsInFlight(db)));

  // A card that belongs to no project (the "All projects" save target, PM-138).
  app.post('/cards', async (c) => {
    const body = await parseBody(c, createCardBody);
    return c.json(store.insertCard(db, 0, body), 201);
  });

  app.patch('/cards/:id', async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, updateCardBody);
    if (
      body.projectId !== undefined &&
      body.projectId > 0 &&
      !store.getProjectRow(db, body.projectId)
    )
      throw new HttpError(404, 'Project not found');
    const card = store.updateCard(db, id, body);
    if (!card) throw new HttpError(404, 'Card not found');
    return c.json(card);
  });

  app.delete('/cards/:id', (c) => {
    const id = parseId(c);
    if (!store.deleteCard(db, id)) throw new HttpError(404, 'Card not found');
    // A deleted card's images go with it (no orphaned files in the data folder).
    removeAttachments(attachmentsRoot, id);
    return c.body(null, 204);
  });

  // ---- LAN access (opt-in; server/lan.ts) --------------------------------------------------------
  // Only this computer may see or change LAN settings: requests arriving through the LAN
  // listener are marked by its gate and refused here, so a LAN device can't read the key,
  // turn access off for others, or re-key.
  const lanOnly = (c: Context) => {
    if (c.req.header(LAN_HEADER))
      throw new HttpError(403, 'LAN settings can only be changed on this computer');
    if (!options.lan) throw new HttpError(404, 'LAN access is not available');
    return options.lan;
  };
  app.get('/lan', (c) => c.json(lanOnly(c).status()));
  app.put('/lan', async (c) => {
    const lan = lanOnly(c);
    const { enabled } = await parseBody(c, z.object({ enabled: z.boolean() }));
    return c.json(await lan.setEnabled(enabled));
  });
  app.post('/lan/new-code', (c) => c.json(lanOnly(c).newCode()));
  app.delete('/lan/devices/:id', (c) => c.json(lanOnly(c).signOut(c.req.param('id'))));
  app.delete('/lan/devices', (c) => c.json(lanOnly(c).signOut()));

  // ---- Remote access through a Cloudflare Tunnel (opt-in; server/remote.ts) ---------------------
  // Same rule as LAN, stricter: the Cloudflare details, the authenticator secret and the session
  // list are answered on this computer only. Requests through the remote listener carry both
  // markers and are refused here, so enrolment can never happen from the internet.
  const remoteOnly = (c: Context) => {
    if (c.req.header(LAN_HEADER) || c.req.header(REMOTE_HEADER))
      throw new HttpError(403, 'Remote access settings can only be changed on this computer');
    if (!options.remote) throw new HttpError(404, 'Remote access is not available');
    return options.remote;
  };
  const failAsBadRequest = async <T>(run: () => T | Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : 'Request failed');
    }
  };
  app.get('/remote', (c) => c.json(remoteOnly(c).status()));
  app.put('/remote/config', async (c) => {
    const remote = remoteOnly(c);
    const body = await parseBody(
      c,
      z.object({
        team: z.string().max(63),
        aud: z.string().max(64),
        hostname: z.string().max(253),
        emails: z.array(z.string().max(254)).max(20),
      }),
    );
    return c.json(await failAsBadRequest(() => remote.configure(body)));
  });
  app.post('/remote/totp', (c) => c.json(remoteOnly(c).beginTotp()));
  app.post('/remote/totp/confirm', async (c) => {
    const remote = remoteOnly(c);
    const { code } = await parseBody(c, z.object({ code: z.string().max(16) }));
    return c.json(await failAsBadRequest(() => remote.confirmTotp(code)));
  });
  app.put('/remote', async (c) => {
    const remote = remoteOnly(c);
    const { enabled } = await parseBody(c, z.object({ enabled: z.boolean() }));
    return c.json(await failAsBadRequest(() => remote.setEnabled(enabled)));
  });
  app.delete('/remote/sessions/:id', (c) => c.json(remoteOnly(c).signOut(c.req.param('id'))));
  app.delete('/remote/sessions', (c) => c.json(remoteOnly(c).signOut()));

  // ---- Preferences ------------------------------------------------------------------------------
  // The colour theme lives in the database as well as the browser: browser storage is tied to the
  // exact origin, so a launcher port fallback (5180 → 5181) or a cleared browser would lose it.

  app.get('/preferences/theme', (c) =>
    // null until first saved: the client then uploads its browser copy instead of being reset.
    c.json({ theme: store.getSetting<ThemePreference>(db, 'theme') ?? null }),
  );

  app.put('/preferences/theme', async (c) => {
    const { theme } = await parseBody(c, themeBody);
    store.setSetting(db, 'theme', theme);
    return c.json({ theme });
  });

  // The sidebar's "Custom order": the full list of project ids, in the order the user arranged.
  app.get('/preferences/project-order', (c) =>
    c.json({ order: store.getSetting<number[]>(db, 'project_order') ?? [] }),
  );

  app.put('/preferences/project-order', async (c) => {
    const { order } = await parseBody(c, projectOrderBody);
    const unique = [...new Set(order)];
    store.setSetting(db, 'project_order', unique);
    return c.json({ order: unique });
  });

  // Keyboard shortcuts (PM-244): only the keys changed from the defaults (the client owns those).
  app.get('/preferences/shortcuts', (c) =>
    c.json({ overrides: store.getSetting<ShortcutOverrides>(db, 'shortcuts') ?? {} }),
  );

  app.put('/preferences/shortcuts', async (c) => {
    const { overrides } = await parseBody(c, shortcutsBody);
    store.setSetting(db, 'shortcuts', overrides);
    return c.json({ overrides });
  });

  // ---- Folder browser (for the "Add project" dialog) -----------------------------------------

  app.get('/fs/browse', (c) => {
    const requested = c.req.query('path');
    return c.json(browse(db, requested ? resolveFolder(requested) : os.homedir()));
  });

  return Object.assign(app, { supervisor, scanner, orchestrator });
}

function resolveFolder(input: string): string {
  const expanded = input.startsWith('~') ? path.join(os.homedir(), input.slice(1)) : input;
  if (!path.isAbsolute(expanded)) throw new HttpError(400, 'Use an absolute folder path');
  let resolved: string;
  try {
    resolved = realpathSync.native(path.resolve(expanded));
    if (!statSync(resolved).isDirectory()) throw new Error('not a directory');
  } catch {
    throw new HttpError(400, `Folder not found: ${input}`);
  }
  return resolved;
}

const HIDDEN_DIRS = new Set(['$RECYCLE.BIN', 'System Volume Information', 'node_modules']);

function browse(db: Db, dir: string): DirectoryListing {
  // One query for all tracked paths: the picker marks entries that are already
  // tracked so they can't be queued again. Case-insensitive like findProjectByPath.
  const tracked = new Set(
    (db.prepare('SELECT path FROM projects').all() as { path: string }[]).map((r) =>
      r.path.toLowerCase(),
    ),
  );
  const trackedName = (folder: string): string | null =>
    store.findProjectByPath(db, folder)?.name ?? null;
  let entries: DirectoryEntry[];
  try {
    entries = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !HIDDEN_DIRS.has(d.name))
      .map((d) => {
        const full = path.join(dir, d.name);
        return {
          name: d.name,
          path: full,
          isGitRepo: existsSync(path.join(full, '.git')),
          isTracked: tracked.has(full.toLowerCase()),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  } catch {
    throw new HttpError(403, `Cannot read folder: ${dir}`);
  }
  const parent = path.dirname(dir);
  return {
    path: dir,
    parent: parent === dir ? null : parent,
    entries,
    roots: filesystemRoots(),
    home: os.homedir(),
    trackedAs: trackedName(dir),
  };
}

function filesystemRoots(): string[] {
  if (process.platform !== 'win32') return ['/'];
  const roots: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const drive = `${String.fromCharCode(code)}:\\`;
    if (existsSync(drive)) roots.push(drive);
  }
  return roots;
}
