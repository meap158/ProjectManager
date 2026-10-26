import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { LineCounter, isNode, parseDocument } from 'yaml';
import { z } from 'zod';
import type { SopInfo, SopReport, SopResult } from '../shared/types.js';
import type { Db } from './db.js';
import { getProjectRow, listProjectFolders, listSopWaivers } from './store.js';

// Our SOPs (PM-316): the shared standard every project's agent instructions carry. They are data
// (server/sops.default.yml, or the owner's edited copy in data/sops.yml), each with read-only
// checks from a small fixed vocabulary run against a project folder. There is no "run a command"
// check, so an edited file can only read files and ask git what it tracks, never execute anything
// or write inside a project. The report is shared by the Settings tab and the agents' tools.

const run = promisify(execFile);
const MAX_READ = 1 << 20;
const MAX_FILE = 256 * 1024;

// ---- The file ---------------------------------------------------------------------------------

const relPath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) => !path.isAbsolute(p) && !p.split(/[\\/]/).includes('..'),
    'Paths stay inside the project (no absolute paths or ..)',
  );
const paths = z.union([relPath, z.array(relPath).min(1).max(20)]);
const regex = z
  .string()
  .min(1)
  .max(300)
  .superRefine((r, ctx) => {
    try {
      new RegExp(r, 'im');
    } catch (e) {
      ctx.addIssue({ code: 'custom', message: `Not a valid regex: ${(e as Error).message}` });
    }
  });
const fail = z.string().min(1).max(300).optional();
const check = z.union([
  z.object({ file_exists: paths, fail }).strict(),
  z.object({ file_missing: paths, fail }).strict(),
  z
    .object({
      untracked: z.array(z.string().min(1).max(200)).min(1).max(30),
      except: regex.optional(),
      not_git: z.enum(['pass', 'na']).optional(),
      fail,
    })
    .strict(),
  z.object({ file_contains: paths, pattern: regex, fail }).strict(),
  z.object({ root_files: regex, contains: regex.optional(), fail }).strict(),
]);
const condition = z.union([
  z.enum(['runnable', 'has_ui']),
  z.object({ file_exists: paths }).strict(),
]);
const text = (max: number) => z.string().trim().min(1).max(max);
const sopSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'Ids are lowercase letters, digits and dashes'),
    title: text(80),
    short: text(16),
    summary: text(300),
    why: text(600),
    how: text(400),
    fix: text(600),
    pass: text(200).optional(),
    enabled: z.boolean().optional(),
    applies_when: z.array(condition).min(1).max(5).optional(),
    checks: z.array(check).min(1).max(12),
  })
  .strict();
const fileSchema = z
  .object({ version: z.literal(1), sops: z.array(sopSchema).max(40) })
  .strict()
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.sops.forEach((s, i) => {
      if (seen.has(s.id))
        ctx.addIssue({
          code: 'custom',
          path: ['sops', i, 'id'],
          message: `Duplicate id "${s.id}"`,
        });
      seen.add(s.id);
    });
  });
export type SopDef = z.infer<typeof sopSchema>;
type Check = z.infer<typeof check>;

/** A file that does not parse or validate, with where (1-based line and column) when known. */
export class SopFileError extends Error {}

/** Parses and validates an SOP file. Throws SopFileError naming the line of the first problem. */
export function parseSops(source: string): SopDef[] {
  if (source.length > MAX_FILE) throw new SopFileError('The file is larger than 256 KB');
  const lines = new LineCounter();
  const doc = parseDocument(source, { lineCounter: lines, prettyErrors: false });
  const at = (offset: number | undefined) => {
    if (offset === undefined) return '';
    const { line, col } = lines.linePos(offset);
    return `Line ${line}, column ${col}: `;
  };
  if (doc.errors.length) {
    const e = doc.errors[0]!;
    throw new SopFileError(`${at(e.pos[0])}${e.message.split('\n')[0]}`);
  }
  const parsed = fileSchema.safeParse(doc.toJS());
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    // The deepest node on the issue's path that exists, for its line.
    let node: unknown = null;
    for (let n = issue.path.length; n >= 0 && !isNode(node); n--)
      node = doc.getIn(issue.path.slice(0, n) as (string | number)[], true);
    const where = isNode(node) && node.range ? at(node.range[0]) : '';
    const name = issue.path.length ? `${issue.path.join('.')}: ` : '';
    // A union says only "Invalid input"; say what is allowed there instead.
    const parent = issue.path.at(-2);
    const message =
      issue.code === 'invalid_union' && parent === 'checks'
        ? 'Not a check this file knows. Use one of file_exists, file_missing, untracked, file_contains or root_files, with only its own options'
        : issue.code === 'invalid_union' && parent === 'applies_when'
          ? 'Use runnable, has_ui or { file_exists: path }'
          : issue.message;
    throw new SopFileError(`${where}${name}${message}`);
  }
  return parsed.data.sops;
}

/** The default set's file (the compiled server lives in dist/server; the YAML stays in server/). */
function defaultFile(): string {
  const file = fileURLToPath(new URL('./sops.default.yml', import.meta.url));
  return file.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(path.dirname(file), '../../server/sops.default.yml')
    : file;
}

export interface SopSet {
  sops: SopDef[];
  /** The owner's edited copy is in use (data/sops.yml). */
  custom: boolean;
  /** The edited copy does not validate, so the defaults are in use; the owner should fix it. */
  error: string | null;
}

/** The SOPs in use: the owner's copy in the data folder when there is one, else the defaults. */
export class SopStore {
  readonly file: string | null;
  private cache: { key: string; set: SopSet } | null = null;
  /** The shipped defaults, re-read when the file changes (an update, or an edit in development). */
  private defaults: { mtime: number; sops: SopDef[] } | null = null;

  constructor(dataDir: string | null) {
    this.file = dataDir ? path.join(dataDir, 'sops.yml') : null;
  }

  defaultSource(): string {
    return readFileSync(defaultFile(), 'utf8');
  }

  private defaultSops(): SopDef[] {
    const mtime = statSync(defaultFile()).mtimeMs;
    if (this.defaults?.mtime !== mtime)
      this.defaults = { mtime, sops: parseSops(this.defaultSource()) };
    return this.defaults.sops;
  }

  current(): SopSet {
    const custom = this.file !== null && existsSync(this.file);
    const key = `${statSync(defaultFile()).mtimeMs}:${custom ? statSync(this.file!).mtimeMs : ''}`;
    if (this.cache?.key === key) return this.cache.set;
    let set: SopSet = { sops: this.defaultSops(), custom: false, error: null };
    if (custom) {
      try {
        set = { sops: parseSops(readFileSync(this.file!, 'utf8')), custom: true, error: null };
      } catch (e) {
        set = { sops: this.defaultSops(), custom: true, error: (e as Error).message };
      }
    }
    this.cache = { key, set };
    return set;
  }

  /** The text the editor shows: the owner's copy, or the defaults to start one from. */
  source(): { yaml: string; custom: boolean } {
    if (this.file && existsSync(this.file))
      return { yaml: readFileSync(this.file, 'utf8'), custom: true };
    return { yaml: this.defaultSource(), custom: false };
  }

  /** Validates, then saves the owner's copy. Throws SopFileError and leaves the old copy. */
  save(source: string): void {
    if (!this.file) throw new SopFileError('No data folder to save SOPs in');
    parseSops(source);
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, source.replace(/\r\n/g, '\n'));
    this.cache = null;
  }

  /** Back to the defaults: removes the owner's copy. */
  reset(): void {
    if (this.file) rmSync(this.file, { force: true });
    this.cache = null;
  }
}

// ---- Checks -----------------------------------------------------------------------------------

/** One project's folder, with what checks ask more than once read only once. */
class Folder {
  private files = new Map<string, Promise<string | null>>();
  private rootNames: Promise<string[]> | null = null;
  constructor(readonly root: string) {}

  /** Inside the project only (the schema already refuses .. and absolute paths). */
  private at(rel: string): string {
    return path.join(this.root, ...rel.split(/[\\/]/));
  }
  async exists(rel: string): Promise<boolean> {
    try {
      await stat(this.at(rel));
      return true;
    } catch {
      return false;
    }
  }
  /** The first megabyte of a file, or null when it is missing. */
  read(rel: string): Promise<string | null> {
    let pending = this.files.get(rel);
    if (!pending) {
      pending = (async () => {
        try {
          const handle = await open(this.at(rel), 'r');
          try {
            const buffer = Buffer.alloc(MAX_READ);
            const { bytesRead } = await handle.read(buffer, 0, MAX_READ, 0);
            return buffer.subarray(0, bytesRead).toString('utf8');
          } finally {
            await handle.close();
          }
        } catch {
          return null;
        }
      })();
      this.files.set(rel, pending);
    }
    return pending;
  }
  names(): Promise<string[]> {
    return (this.rootNames ??= readdir(this.root, { withFileTypes: true }).then(
      (entries) => entries.filter((e) => e.isFile()).map((e) => e.name),
      () => [],
    ));
  }
  /** Tracked paths matching the pathspecs, or null when the folder is not a git repository. */
  async tracked(specs: string[]): Promise<string[] | null> {
    try {
      const { stdout } = await run('git', ['ls-files', '--', ...specs], {
        cwd: this.root,
        timeout: 15_000,
        windowsHide: true,
        maxBuffer: 1 << 22,
      });
      return stdout.split('\n').filter(Boolean);
    } catch {
      return null;
    }
  }
}

const list = (p: string | string[]) => (Array.isArray(p) ? p : [p]);
const re = (r: string) => new RegExp(r, 'im');
const named = (files: string[]) =>
  `${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${files.length - 3} more` : ''}`;
const fill = (message: string | undefined, fallback: string, files: string[] = []) =>
  (message ?? fallback).replace('{files}', named(files));

const MANIFESTS = [
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pubspec.yaml',
];
async function runnable(f: Folder): Promise<boolean> {
  for (const m of MANIFESTS) if (await f.exists(m)) return true;
  return (await f.names()).some((n) => /\.(csproj|sln)$/i.test(n));
}
async function hasUi(f: Folder): Promise<boolean> {
  const pkg = await f.read('package.json');
  if (pkg && /"(react|vue|svelte|next|@angular\/core|solid-js|preact|electron)"\s*:/.test(pkg))
    return true;
  for (const dir of ['', 'public/', 'client/', 'src/', 'web/', 'app/'])
    if (await f.exists(`${dir}index.html`)) return true;
  return false;
}

type Outcome = Omit<SopResult, 'waiver'>;

/** One check: null when it passes, else the gap (or "does not apply" for not_git: na). */
async function runCheck(f: Folder, c: Check): Promise<Outcome | null> {
  const gap = (detail: string): Outcome => ({ state: 'fail', detail });
  if ('file_exists' in c) {
    const want = list(c.file_exists);
    for (const p of want) if (await f.exists(p)) return null;
    return gap(fill(c.fail, `No ${want.join(' or ')}`));
  }
  if ('file_missing' in c) {
    const present: string[] = [];
    for (const p of list(c.file_missing)) if (await f.exists(p)) present.push(p);
    return present.length ? gap(fill(c.fail, `${named(present)} should not exist`, present)) : null;
  }
  if ('untracked' in c) {
    const files = await f.tracked(c.untracked);
    if (files === null)
      return c.not_git === 'na' ? { state: 'na', detail: 'Not a git repository' } : null;
    const allowed = c.except ? re(c.except) : null;
    const bad = files.filter((file) => !allowed?.test(file));
    return bad.length ? gap(fill(c.fail, `Tracked: {files}`, bad)) : null;
  }
  if ('file_contains' in c) {
    for (const p of list(c.file_contains)) {
      const body = await f.read(p);
      if (body === null) continue;
      return re(c.pattern).test(body) ? null : gap(fill(c.fail, `${p} does not mention it`));
    }
    return gap(fill(c.fail, `No ${list(c.file_contains).join(' or ')}`));
  }
  const names = (await f.names()).filter((n) => re(c.root_files).test(n));
  if (!names.length) return gap(fill(c.fail, 'No matching file at the project root'));
  if (!c.contains) return null;
  for (const n of names) {
    const body = await f.read(n);
    if (body !== null && re(c.contains).test(body)) return null;
  }
  return gap(fill(c.fail, '{files}: no match', names));
}

async function applies(f: Folder, sop: SopDef): Promise<boolean> {
  if (!sop.applies_when) return true;
  for (const cond of sop.applies_when) {
    if (cond === 'runnable' ? await runnable(f) : cond === 'has_ui' ? await hasUi(f) : false)
      return true;
    if (typeof cond === 'object')
      for (const p of list(cond.file_exists)) if (await f.exists(p)) return true;
  }
  return false;
}

const NOT_APPLY: Record<string, string> = {
  runnable: 'Nothing to run (no app manifest)',
  has_ui: 'No user interface found',
};

/** Runs every enabled SOP on one folder; a missing folder is reported once per SOP. */
export async function checkProject(sops: SopDef[], root: string): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {};
  const enabled = sops.filter((s) => s.enabled !== false);
  const f = new Folder(root);
  if (!(await f.exists('.'))) {
    for (const sop of enabled) out[sop.id] = { state: 'na', detail: 'Folder not found' };
    return out;
  }
  await Promise.all(
    enabled.map(async (sop) => {
      try {
        if (!(await applies(f, sop))) {
          const first = sop.applies_when?.find((c) => typeof c === 'string');
          out[sop.id] = { state: 'na', detail: NOT_APPLY[first ?? ''] ?? 'Does not apply' };
          return;
        }
        for (const c of sop.checks) {
          const result = await runCheck(f, c);
          if (result) {
            out[sop.id] = result;
            return;
          }
        }
        out[sop.id] = { state: 'pass', detail: sop.pass ?? 'Meets it' };
      } catch (e) {
        out[sop.id] = { state: 'fail', detail: `Check failed: ${(e as Error).message}` };
      }
    }),
  );
  return out;
}

// ---- Reports ----------------------------------------------------------------------------------

export const sopInfo = (sops: SopDef[]): SopInfo[] =>
  sops
    .filter((s) => s.enabled !== false)
    .map(({ id, title, short, summary, why, how, fix }) => ({
      id,
      title,
      short,
      summary,
      why,
      how,
      fix,
    }));

/**
 * The report for some projects (all when `projectIds` is omitted): each SOP's result per project,
 * with waivers merged in. Shared by the Settings tab and the agents' tools, so both see the same.
 */
export async function sopReport(
  db: Db,
  set: SopSet,
  projectIds?: readonly number[],
): Promise<SopReport> {
  const folders = listProjectFolders(db).filter((f) => !projectIds || projectIds.includes(f.id));
  const waivers = listSopWaivers(db);
  const info = sopInfo(set.sops);
  const projects: SopReport['projects'] = [];
  // A few at a time: each check is a handful of file reads and at most one git call.
  for (let i = 0; i < folders.length; i += 6) {
    projects.push(
      ...(await Promise.all(
        folders.slice(i, i + 6).map(async (folder) => {
          const checked = await checkProject(set.sops, folder.path);
          const own = waivers.get(folder.id);
          const results: Record<string, SopResult> = {};
          for (const sop of info) {
            const result = checked[sop.id]!;
            const waiver = own?.get(sop.id);
            results[sop.id] = !waiver
              ? result
              : result.state === 'fail'
                ? { ...result, state: 'waived', waiver }
                : { ...result, waiver };
          }
          const name = getProjectRow(db, folder.id)?.name ?? folder.path;
          return { id: folder.id, name, results };
        }),
      )),
    );
  }
  projects.sort((a, b) => a.name.localeCompare(b.name));
  // Waivers whose SOP is gone (renamed or deleted in the file): kept, but listed so none vanish.
  const ids = new Set(info.map((s) => s.id));
  const orphaned: SopReport['orphanedWaivers'] = [];
  for (const [projectId, own] of waivers)
    for (const sopId of own.keys())
      if (!ids.has(sopId) && (!projectIds || projectIds.includes(projectId)))
        orphaned.push({ projectId, sopId });
  return {
    sops: info,
    projects,
    checkedAt: new Date().toISOString(),
    custom: set.custom,
    fileError: set.error,
    orphanedWaivers: orphaned,
  };
}

/** The text of a card that asks an agent to bring one project up to an SOP. */
export function sopCardText(sop: SopInfo, detail: string): { title: string; description: string } {
  return {
    title: `SOP: ${sop.title}`,
    description: [
      `Bring this project up to our "${sop.title}" SOP (Settings > SOPs in ProjectManager).`,
      '',
      `What it asks: ${sop.summary}`,
      `Why: ${sop.why}`,
      `Found: ${detail}`,
      `How it is checked: ${sop.how}`,
      `How to fix: ${sop.fix}`,
      '',
      'Follow the project AGENTS.md and its existing conventions. Commit with a reference to this card.',
    ].join('\n'),
  };
}
