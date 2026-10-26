import { GrokAccountError } from './agents/grokAccounts.js';
import { jsonEtag } from './jsonEtag.js';
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
  PreviewLaunch,
  DirectoryEntry,
  DirectoryListing,
  FilePin,
  SopAuditor,
  SopReport,
  LanStatus,
  RemoteConfig,
  RemoteStatus,
  ShortcutOverrides,
} from '../shared/types.js';
import { LAN_HEADER } from './lan.js';
import { openEntry, renameEntry } from './projectFileActions.js';
import {
  DEFAULT_FOLDER_LIMIT,
  FileAccessError,
  folderInfo,
  listFolder,
  previewFile,
  rawEtag,
  rawMeta,
  readRaw,
} from './projectFiles.js';
import { PreviewError, parsePreviewPort, proxyPreview } from './preview.js';
import { PreviewCapture, normaliseCapture, type CaptureRequest } from './previewCapture.js';
import { SopFileError, SopStore, checkProject, sopCardText, sopInfo, sopReport } from './sops.js';
import { config } from './config.js';
import { detectLocalApps, stopLocalApp } from './localPorts.js';
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

const PREVIEW_LAUNCHES_KEY = 'preview-quick-launches';
const previewLaunchesBody = z.object({
  launches: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(60),
        port: z.number().int().min(1024).max(65535),
        path: z.string().max(200).startsWith('/').default('/'),
        projectId: z.number().int().positive().nullable().default(null),
      }),
    )
    .max(30),
});

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
  // Polled reads revalidate instead of re-downloading (after compress: hashes the plain body).
  app.use('*', jsonEtag);

  app.onError((error, c) => {
    if (error instanceof GrokAccountError) return c.json({ error: error.message }, 400);
    if (c.req.path.includes('/agents/grok-accounts') && error instanceof z.ZodError)
      return c.json({ error: 'Invalid Grok account request.' }, 400);
    if (error instanceof HttpError) return c.json({ error: error.message }, error.status);
    if (error instanceof AgentError) return c.json({ error: error.message }, error.status);
    if (error instanceof PreviewError) return c.json({ error: error.message }, error.status);
    console.error('[api]', error);
    return c.json({ error: 'Internal server error' }, 500);
  });

  app.get('/health', (c) => c.json({ ok: true }));

  // Built-in browser (PM-253, docs/BUILT-IN-BROWSER.md): a read-only view of a dev server on this
  // computer's loopback. This app's own ports are refused so the proxy can't loop into the API.
  const previewHandler = async (c: Context) => {
    const hostPort = Number(/:(\d+)$/.exec(c.req.header('host') ?? '')?.[1]);
    const blocked = new Set<number>([config.port, config.port + 100]);
    for (const own of [hostPort, options.lan?.status().port, options.remote?.status().port]) {
      if (own) blocked.add(own);
    }
    const port = parsePreviewPort(c.req.param('port') ?? '', blocked);
    const prefix = `/api/preview/${port}`;
    const rest = new URL(c.req.url).pathname.slice(prefix.length) || '/';
    console.log('[preview]', port, rest);
    return proxyPreview(c.req.raw, port, rest, new URL(c.req.url).search);
  };
  // Apps listening on this computer (detected) and the saved quick launches (PM-253).
  const ownPorts = () => {
    const blocked = new Set<number>([config.port, config.port + 100]);
    for (const own of [options.lan?.status().port, options.remote?.status().port]) {
      if (own) blocked.add(own);
    }
    return blocked;
  };
  app.get('/local-apps', async (c) => {
    const projects = store
      .listProjects(db, (id) => scanner.state(id))
      .map((p) => ({
        id: p.id,
        path: p.path,
      }));
    return c.json({
      apps: await detectLocalApps(projects, ownPorts(), c.req.query('fresh') === '1'),
    });
  });
  // Stops the program on a listed port (PM-270). It ends a process on this computer, so only this
  // computer may ask (the LAN and remote listeners get 403), and only for the pid a fresh detection
  // still sees on that port: never this server, its launcher, its own ports or system services.
  app.post('/local-apps/:port/stop', async (c) => {
    if (c.req.header(LAN_HEADER) || c.req.header(REMOTE_HEADER))
      throw new HttpError(
        403,
        'Programs can only be stopped on the computer running ProjectManager',
      );
    const port = Number(c.req.param('port'));
    const { pid } = await parseBody(c, z.object({ pid: z.number().int().positive() }));
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new HttpError(400, 'Bad port');
    const projects = store
      .listProjects(db, (id) => scanner.state(id))
      .map((p) => ({ id: p.id, path: p.path }));
    const result = await stopLocalApp(port, pid, projects, ownPorts());
    if (!result.ok) throw new HttpError(409, result.error);
    return c.json({ ok: true });
  });
  app.get('/preview-launches', (c) =>
    c.json({ launches: store.getSetting<PreviewLaunch[]>(db, PREVIEW_LAUNCHES_KEY) ?? [] }),
  );
  app.put('/preview-launches', async (c) => {
    const parsed = previewLaunchesBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) throw new HttpError(400, 'Quick launches need a name and a port');
    store.setSetting(db, PREVIEW_LAUNCHES_KEY, parsed.data.launches);
    return c.json({ launches: parsed.data.launches });
  });
  // The element picker's screenshot (PM-311): a headless browser retakes the page the owner picked
  // from, at the same size and scroll. Read-only like the preview, so every listener may ask.
  const capture = new PreviewCapture(
    options.dataDir ?? path.join(os.tmpdir(), 'projectmanager-capture'),
  );
  app.post('/preview-capture', async (c) => {
    if (!capture.available) throw new PreviewError(502, 'No Chrome or Edge on this computer');
    const body = (await c.req.json().catch(() => null)) as CaptureRequest | null;
    if (!body || typeof body !== 'object')
      throw new PreviewError(400, 'Expected a capture request');
    const { png, element } = await capture.capture(normaliseCapture(body, ownPorts()));
    return c.body(new Uint8Array(png), 200, {
      'content-type': 'image/png',
      'cache-control': 'no-store',
      // Where the picked element is in this image (measured in the capture), for its box.
      ...(element ? { 'x-pm-element': JSON.stringify(element) } : {}),
    });
  });
  app.get('/preview/:port', previewHandler);
  app.get('/preview/:port/*', previewHandler);

  registerAgentRoutes(app, db, supervisor);
  // The SOPs (PM-316) are data: server/sops.default.yml, or the owner's copy in data/sops.yml.
  // One store, shared by Settings > SOPs and the agents' audit tools.
  const sopStore = new SopStore(options.dataDir ?? null);
  const orchestrator = new OrchestratorService(db, supervisor, options.dataDir ?? null, () =>
    store.listProjects(db, (id) => scanner.state(id)),
  );
  const orchestratorChat = new OrchestratorChat(
    db,
    supervisor,
    orchestrator,
    () => store.listProjects(db, (id) => scanner.state(id)),
    options.dataDir ?? null,
    sopStore,
  );
  registerOrchestratorRoutes(app, orchestrator, orchestratorChat);
  // Card images live beside the agent logs: <dataDir>/attachments/<cardId>/.
  const attachmentsRoot = path.join(path.dirname(logDir), 'attachments');
  registerAttachmentRoutes(app, db, attachmentsRoot);
  registerSessionImageRoutes(app, db, attachmentsRoot);
  registerBoardMcp(app, db, attachmentsRoot, orchestratorChat, sopStore);

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

  // The folder previewer (PM-286): entries with sizes and times, one level or the whole tree below.
  app.get('/projects/:id/folder-info', async (c) => {
    const root = projectRoot(c);
    const limit = Number.parseInt(c.req.query('limit') ?? '', 10);
    return c.json(
      await fileErrors(() =>
        folderInfo(root, c.req.query('path') ?? '', {
          recursive: c.req.query('recursive') === '1',
          limit: Number.isFinite(limit) ? limit : DEFAULT_FOLDER_LIMIT,
        }),
      ),
    );
  });

  app.get('/projects/:id/file', async (c) => {
    const root = projectRoot(c);
    return c.json(await fileErrors(() => previewFile(root, c.req.query('path') ?? '')));
  });

  // The Files context menu (PM-259): rename, open in the system app, reveal in the file manager.
  // These change files or start programs on the host, so only this computer may ask: requests
  // through the LAN or remote listener are refused, like open-folder.
  const hostOnly = (c: Context) => {
    if (c.req.header(LAN_HEADER) || c.req.header(REMOTE_HEADER))
      throw new HttpError(
        403,
        'Files can only be renamed or opened on the computer running ProjectManager',
      );
  };
  app.post('/projects/:id/files/rename', async (c) => {
    hostOnly(c);
    const root = projectRoot(c);
    const { path: rel, name } = await parseBody(
      c,
      z.object({ path: z.string().min(1).max(4096), name: z.string().max(300) }),
    );
    return c.json({ path: await fileErrors(() => renameEntry(root, rel, name)) });
  });
  app.post('/projects/:id/files/open', async (c) => {
    const { path: rel, mode } = await parseBody(
      c,
      z.object({ path: z.string().max(4096), mode: z.enum(['open', 'reveal', 'run']) }),
    );
    // "Run in terminal" also answers a remote session (owner's decision): it is signed in through
    // Cloudflare Access and an authenticator code, and can already run commands in its agent
    // terminals. Never a LAN device, and opening or revealing stays on this computer.
    if (!(mode === 'run' && c.req.header(REMOTE_HEADER))) hostOnly(c);
    const root = projectRoot(c);
    await fileErrors(() => openEntry(root, rel, mode));
    return c.body(null, 204);
  });

  // Pinned files and folders (PM-284). Reading is open to every listener; changing pins writes to
  // this app's own database only (never the project), but like the other Files actions it answers
  // on this computer only, so a phone or tunnel session cannot rearrange them.
  const pinsHostOnly = (c: Context) => {
    if (c.req.header(LAN_HEADER) || c.req.header(REMOTE_HEADER))
      throw new HttpError(403, 'Pins can only be changed on the computer running ProjectManager');
  };
  const pinError = <T>(run: () => T): T => {
    try {
      return run();
    } catch (error) {
      throw new HttpError(400, (error as Error).message);
    }
  };
  // SOPs (PM-316): our shared standard, checked read-only against every project folder. Waivers
  // record a deliberate exception and live here, never in the project.
  app.get('/sops', async (c) => {
    const report: SopReport = await sopReport(db, sopStore.current());
    return c.json(report);
  });
  // The editable file. Saving changes the audit standard, so only this computer may change it;
  // a file that does not validate is refused with the line of the first problem.
  const sopsHostOnly = (c: Context) => {
    if (c.req.header(LAN_HEADER) || c.req.header(REMOTE_HEADER))
      throw new HttpError(403, 'SOPs can only be edited on the computer running ProjectManager');
  };
  app.get('/sops/file', (c) => {
    const { yaml, custom } = sopStore.source();
    return c.json({ yaml, custom, path: sopStore.file });
  });
  app.put('/sops/file', async (c) => {
    sopsHostOnly(c);
    const { yaml } = await parseBody(c, z.object({ yaml: z.string().max(256 * 1024) }));
    try {
      sopStore.save(yaml);
    } catch (e) {
      if (e instanceof SopFileError) throw new HttpError(400, e.message);
      throw e;
    }
    return c.body(null, 204);
  });
  app.delete('/sops/file', (c) => {
    sopsHostOnly(c);
    sopStore.reset();
    return c.body(null, 204);
  });
  // Who can run an audit of a project: its running sessions, and the chat of every orchestrator
  // whose scope includes it. Without a project: every orchestrator chat (each audits its scope).
  app.get('/sops/sessions', (c) => {
    const raw = c.req.query('projectId');
    const projectId = raw ? Number(raw) : null;
    if (projectId !== null && !Number.isInteger(projectId))
      throw new HttpError(400, 'Expected a project id');
    const instances = new Map(orchestrator.state().instances.map((i) => [i.id, i]));
    const sessions: SopAuditor[] = [];
    for (const s of supervisor.listAllSessions()) {
      if (s.status !== 'running') continue;
      if (s.orchestratorId) {
        const instance = instances.get(s.orchestratorId);
        if (!instance) continue;
        const all = instance.projectIds.length === 0;
        if (projectId !== null && !all && !instance.projectIds.includes(projectId)) continue;
        sessions.push({
          id: s.id,
          name: instance.name,
          terminal: s.terminal,
          kind: 'orchestrator',
          scope: all ? 'All projects' : `${instance.projectIds.length} projects`,
          lastInputAt: s.lastInputAt ?? null,
        });
      } else if (projectId !== null && s.projectId === projectId) {
        sessions.push({
          id: s.id,
          name: s.name,
          terminal: s.terminal,
          kind: 'session',
          scope: 'This project',
          lastInputAt: s.lastInputAt ?? null,
        });
      }
    }
    // Orchestrators first, then the most recently messaged.
    sessions.sort(
      (a, b) =>
        Number(b.kind === 'orchestrator') - Number(a.kind === 'orchestrator') ||
        (b.lastInputAt ?? '').localeCompare(a.lastInputAt ?? ''),
    );
    return c.json({ sessions });
  });
  const sopFor = (c: Context) => {
    const sop = sopStore
      .current()
      .sops.find((s) => s.enabled !== false && s.id === c.req.param('sopId'));
    if (!sop) throw new HttpError(404, 'No such SOP');
    return sop;
  };
  app.put('/projects/:id/sops/:sopId/waiver', async (c) => {
    const sop = sopFor(c);
    projectRoot(c);
    const { reason } = await parseBody(c, z.object({ reason: z.string().trim().min(1).max(500) }));
    store.setSopWaiver(db, parseId(c), sop.id, reason);
    return c.body(null, 204);
  });
  app.delete('/projects/:id/sops/:sopId/waiver', (c) => {
    const sop = sopFor(c);
    if (!store.removeSopWaiver(db, parseId(c), sop.id)) throw new HttpError(404, 'No waiver');
    return c.body(null, 204);
  });
  // The text of a card for a gap, from a fresh check, for the board's new-card dialog (PM-322).
  app.get('/projects/:id/sops/:sopId/draft', async (c) => {
    const sop = sopFor(c);
    const result = (await checkProject([sop], projectRoot(c)))[sop.id]!;
    if (result.state !== 'fail') throw new HttpError(409, 'This project already meets that SOP');
    return c.json(sopCardText(sopInfo([sop])[0]!, result.detail));
  });
  // A card asking an agent to bring this project up to the SOP, from a fresh check.
  app.post('/projects/:id/sops/:sopId/card', async (c) => {
    const sop = sopFor(c);
    const root = projectRoot(c);
    const result = (await checkProject([sop], root))[sop.id]!;
    if (result.state !== 'fail') throw new HttpError(409, 'This project already meets that SOP');
    const info = sopInfo([sop])[0]!;
    const card = store.insertCard(db, parseId(c), {
      ...sopCardText(info, result.detail),
      status: 'todo',
    });
    return c.json(card, 201);
  });
  app.get('/projects/:id/file-pins', (c) => {
    const root = projectRoot(c);
    const pins: FilePin[] = store.listFilePinRows(db, parseId(c)).map((row) => {
      // What is there now: a plain stat inside the project (the path was validated when pinned).
      let kind: FilePin['kind'] = null;
      try {
        const stats = statSync(path.join(root, ...row.path.split('/')));
        kind = stats.isDirectory() ? 'dir' : stats.isFile() ? 'file' : null;
      } catch {
        // Missing here: shown dimmed, with a remove action.
      }
      return {
        id: row.id,
        path: row.path,
        scope: row.project_id === null ? 'all' : 'project',
        kind,
      };
    });
    return c.json({ pins });
  });
  app.post('/projects/:id/file-pins', async (c) => {
    pinsHostOnly(c);
    const root = projectRoot(c);
    const { path: raw, scope } = await parseBody(
      c,
      z.object({ path: z.string().max(4096), scope: z.enum(['project', 'all']) }),
    );
    const clean = pinError(() => store.cleanPinPath(raw));
    // Pinning something that is not there would only make a dead row: refuse it for this project.
    if (!existsSync(path.join(root, ...clean.split('/'))))
      throw new HttpError(404, 'That file or folder is not in this project');
    const added = pinError(() => store.addFilePin(db, scope === 'all' ? null : parseId(c), clean));
    return c.json({ id: added.id }, 201);
  });
  app.delete('/file-pins/:id', (c) => {
    pinsHostOnly(c);
    if (!store.removeFilePin(db, parseId(c))) throw new HttpError(404, 'Pin not found');
    return c.body(null, 204);
  });
  app.post('/file-pins/:id/move', async (c) => {
    pinsHostOnly(c);
    const { direction } = await parseBody(c, z.object({ direction: z.enum(['up', 'down']) }));
    store.moveFilePin(db, parseId(c), direction);
    return c.body(null, 204);
  });

  // Bytes for image previews and a previewed page's own styles and images. Never runnable on
  // this origin: a sandbox CSP and nosniff, so an .html or .svg can't script the app.
  app.get('/projects/:id/raw', async (c) => {
    const root = projectRoot(c);
    const requested = c.req.query('path') ?? '';
    // A validator, so a browser that has the file asks "changed?" and gets an empty 304 (thumbnails
    // are shown again and again, over the LAN and the tunnel too).
    const meta = await fileErrors(() => rawMeta(root, requested));
    const etag = rawEtag(meta);
    const headers = {
      'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
      'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-cache',
      etag,
      'last-modified': new Date(meta.mtimeMs).toUTCString(),
    };
    if (c.req.header('if-none-match') === etag) return c.body(null, 304, headers);
    const { bytes, type } = await fileErrors(() => readRaw(root, requested));
    return c.body(new Uint8Array(bytes), 200, { ...headers, 'content-type': type });
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
