import { OrchestratorService } from './orchestrator/service.js';
import { registerOrchestratorRoutes } from './orchestrator/routes.js';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { BOARD_PRESETS, CARD_STATUSES } from '../shared/types.js';
import type { DirectoryEntry, DirectoryListing, LanStatus } from '../shared/types.js';
import { LAN_HEADER } from './lan.js';
import type { Db } from './db.js';
import { Scanner } from './scanner.js';
import * as store from './store.js';
import { AgentError, AgentSupervisor } from './agents/supervisor.js';
import { registerAgentRoutes } from './agents/routes.js';
import { registerBoardMcp } from './boardMcp.js';
import { pullRequests } from './pullRequests.js';
import { openInFileManager } from './openFolder.js';
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
});
const themeBody = z.object({ theme: z.enum(['system', 'light', 'dark']) });
type ThemePreference = z.infer<typeof themeBody>['theme'];
const projectOrderBody = z.object({ order: z.array(z.number().int().positive()).max(5000) });

const updateCardBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().max(20_000),
    status: z.enum(CARD_STATUSES),
    position: z.number().finite(),
  })
  .partial();

class HttpError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 415,
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
    dataDir?: string;
    /** Run interactive sessions in the session host so they survive server restarts. */
    agentHost?: boolean;
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
  registerOrchestratorRoutes(app, orchestrator);
  // Card images live beside the agent logs: <dataDir>/attachments/<cardId>/.
  const attachmentsRoot = path.join(path.dirname(logDir), 'attachments');
  registerAttachmentRoutes(app, db, attachmentsRoot);
  registerSessionImageRoutes(app, db, attachmentsRoot);
  registerBoardMcp(app, db, attachmentsRoot);

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

  app.get('/projects/:id/pull-requests', async (c) => {
    const project = store.getProjectRow(db, parseId(c));
    if (!project) throw new HttpError(404, 'Project not found');
    return c.json(await pullRequests(project.path));
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
    if (!store.deleteProject(db, id)) throw new HttpError(404, 'Project not found');
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

  app.patch('/cards/:id', async (c) => {
    const id = parseId(c);
    const body = await parseBody(c, updateCardBody);
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
