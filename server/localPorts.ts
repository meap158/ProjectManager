import type { LocalApp } from '../shared/types.js';
import { run } from './analysis/exec.js';

// Built-in browser (PM-253): which apps are listening on this computer's loopback, so the Preview
// page can list them instead of asking for a port. Read only: it runs `netstat` (Windows) or
// `lsof` (macOS/Linux) with fixed arguments, and on Windows asks WMI for the listeners' command
// lines to attribute them to a project. Nothing here touches a project's files.

export interface Listener {
  port: number;
  pid: number;
  /** The address it is bound to ("127.0.0.1", "0.0.0.0", "::"...), when known. */
  host?: string;
}

/** Windows ephemeral and RPC ports (49152+) are almost never an app someone wants to open. */
const EPHEMERAL_FROM = 49152;
const MIN_PORT = 1024;
/** Operating-system services that listen on loopback but are never an app to preview. */
const SYSTEM_PROCESSES = new Set([
  'svchost.exe',
  'vmms.exe',
  'system',
  'lsass.exe',
  'services.exe',
]);
/** Only sockets another local program could reach through 127.0.0.1 count. */
const LOOPBACK_REACHABLE = new Set(['127.0.0.1', '0.0.0.0', '[::1]', '[::]', '::1', '::', '*']);

/** `netstat -ano` lines: "  TCP    127.0.0.1:5173    0.0.0.0:0    LISTENING    1234". */
export function parseNetstat(output: string): Listener[] {
  const out = new Map<string, Listener>();
  for (const line of output.split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m || !LOOPBACK_REACHABLE.has(m[1]!)) continue;
    const listener = { port: Number(m[2]), pid: Number(m[3]), host: m[1]! };
    out.set(`${listener.port}:${listener.pid}`, listener);
  }
  return [...out.values()];
}

/** `lsof -nP -iTCP -sTCP:LISTEN -Fpn` output: "p1234" then "n127.0.0.1:5173" lines. */
export function parseLsof(output: string): Listener[] {
  const out = new Map<string, Listener>();
  let pid = 0;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith('p')) pid = Number(line.slice(1));
    else if (line.startsWith('n') && pid) {
      const m = /^n(.+):(\d+)$/.exec(line);
      if (m && LOOPBACK_REACHABLE.has(m[1]!))
        out.set(`${m[2]}:${pid}`, { port: Number(m[2]), pid, host: m[1]! });
    }
  }
  return [...out.values()];
}

/** Ports an app could be opened on: not privileged, not ephemeral, not this app's own. */
export function candidates(listeners: Listener[], blocked: ReadonlySet<number>): Listener[] {
  const open = listeners.filter(
    (l) => l.port >= MIN_PORT && l.port < EPHEMERAL_FROM && !blocked.has(l.port),
  );
  // Two programs can share a port when one binds 127.0.0.1 and another a wildcard (0.0.0.0 or ::).
  // A connection to 127.0.0.1 reaches the specific one, so that is the app this list can open; the
  // other is shadowed and would only show the same page twice.
  const byPort = new Map<number, Listener[]>();
  for (const l of open) byPort.set(l.port, [...(byPort.get(l.port) ?? []), l]);
  const picked: Listener[] = [];
  for (const group of byPort.values()) {
    const specific = group.filter((l) => l.host === '127.0.0.1');
    picked.push(...(group.length > 1 && specific.length > 0 ? specific : group));
  }
  return picked.sort((a, b) => a.port - b.port);
}

/** Lower-cases and unifies separators so "S:\\Vibe Coding\\A" matches "s:/vibe coding/a/x.js". */
const normalize = (value: string) => value.replace(/\\/g, '/').toLowerCase();

/** The project whose folder appears in `command`; the longest path wins (nested projects). */
export function projectForCommand(
  command: string,
  projects: { id: number; path: string }[],
): number | null {
  const text = normalize(command);
  let best: { id: number; length: number } | null = null;
  for (const project of projects) {
    const root = normalize(project.path).replace(/\/+$/, '');
    if (root && text.includes(root) && (!best || root.length > best.length)) {
      best = { id: project.id, length: root.length };
    }
  }
  return best?.id ?? null;
}

async function listeners(): Promise<Listener[]> {
  if (process.platform === 'win32') {
    const { stdout } = await run('netstat', ['-ano'], { timeoutMs: 10_000 });
    return parseNetstat(stdout);
  }
  const { stdout } = await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpn'], {
    timeoutMs: 10_000,
  }).catch(() => ({ stdout: '' }));
  return parseLsof(stdout);
}

interface ProcessInfo {
  name: string;
  command: string;
}

/** Names and command lines for numeric pids. Best effort: missing entries just stay unattributed. */
async function processInfo(pids: number[]): Promise<Map<number, ProcessInfo>> {
  const info = new Map<number, ProcessInfo>();
  if (pids.length === 0) return info;
  const safe = pids.filter((p) => Number.isInteger(p) && p > 0);
  try {
    if (process.platform === 'win32') {
      const filter = safe.map((p) => `ProcessId=${p}`).join(' OR ');
      const { stdout } = await run(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter '${filter}' | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress`,
        ],
        { timeoutMs: 15_000 },
      );
      const parsed: unknown = stdout.trim() ? JSON.parse(stdout) : [];
      const rows = (Array.isArray(parsed) ? parsed : [parsed]) as {
        ProcessId: number;
        Name: string | null;
        CommandLine: string | null;
      }[];
      for (const r of rows) {
        info.set(r.ProcessId, { name: r.Name ?? '', command: r.CommandLine ?? '' });
      }
    } else {
      const { stdout } = await run('ps', ['-o', 'pid=,comm=,args=', '-p', safe.join(',')], {
        timeoutMs: 10_000,
      });
      for (const line of stdout.split('\n')) {
        const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(line);
        if (m) info.set(Number(m[1]), { name: m[2]!, command: m[3]! });
      }
    }
  } catch {
    // Attribution is a convenience; the list still shows the ports.
  }
  return info;
}

/** The title and icon path of an HTML page, read from its head. Pure, so it is easy to test. */
export function readPageMeta(
  html: string,
  port: number,
): { title: string | null; icon: string | null } {
  const head = html.slice(0, 64 * 1024);
  const title =
    /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1]?.replace(/\s+/g, ' ').trim() ?? '';
  let icon: string | null = null;
  // Quote-aware: an inline icon holds `>` and the other kind of quote inside its attribute.
  for (const tag of head.match(/<link\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ?? []) {
    if (!/\brel\s*=\s*["'][^"']*\bicon\b/i.test(tag)) continue;
    const found = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const href = found?.[1] ?? found?.[2];
    if (!href) continue;
    icon = inlineIcon(href) ?? localPath(href, port);
    if (icon) break;
  }
  return { title: title ? title.slice(0, 80) : null, icon: icon ?? '/favicon.ico' };
}

/** Whether a body is a real web page: it has markup a browser would render or run. */
export function looksLikePage(html: string): boolean {
  return /<(title|html|body|head|script|div|main|h[1-6]|p|a|form|img|link)\b/i.test(
    html.slice(0, 64 * 1024),
  );
}

/** Small apps embed their icon in the page (`href="data:image/svg+xml,..."`). That is the icon, as
 * long as it is a plain image and small; it needs no request, so it cannot point anywhere else. */
const INLINE_ICON =
  /^data:image\/(svg\+xml|png|gif|jpeg|webp|avif|x-icon|vnd\.microsoft\.icon)[;,]/i;
const INLINE_ICON_MAX = 32 * 1024;
export function inlineIcon(href: string): string | null {
  const value = href.trim().replace(/&amp;/gi, '&');
  return INLINE_ICON.test(value) && value.length <= INLINE_ICON_MAX ? value : null;
}

/** Where a page's icon may also live when it does not (or wrongly) declare one. */
const ICON_FALLBACKS = ['/favicon.ico', '/favicon.svg', '/favicon.png'];

/** A path on the app itself: an absolute URL only counts when it points back at the same port. */
function localPath(href: string, port: number): string | null {
  if (href.startsWith('//') || href.startsWith('data:')) return null;
  if (href.startsWith('/')) return href;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
    try {
      const url = new URL(href);
      const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
      return loopback && Number(url.port || 80) === port ? `${url.pathname}${url.search}` : null;
    } catch {
      return null;
    }
  }
  return `/${href}`;
}

/** A response that is really an image. A dev server often answers any path with its HTML page
 * (single-page apps do), which must not count as having an icon. */
export function isImageResponse(status: number, contentType: string | null): boolean {
  if (status < 200 || status >= 300) return false;
  const type = (contentType ?? '').toLowerCase().trim();
  return type.startsWith('image/') || type.startsWith('application/x-icon');
}

interface PageMeta {
  title: string | null;
  /** A path on the app that answered with an image, or a small inline image. */
  icon: string | null;
  /** "/" answered with a successful HTML page: the signal for "has a front end". An icon is not
   * needed for that (many dev pages have none, and some use an inline one). */
  web: boolean;
}
const metaCache = new Map<number, PageMeta & { at: number; failed?: boolean }>();
const META_MS = 30_000;
/** A slow or failed answer is asked again after this, not after META_MS. */
const META_RETRY_MS = 5_000;
/** Headers may take a while on a dev server's first request; the body is only read at its start. */
const PAGE_MS = 5_000;
const PAGE_BYTES = 64 * 1024;

/** Asks the app for "/" briefly, then checks that its icon exists. Apps that do not speak HTML
 * (APIs, databases) just have no title or icon, which is what marks them as back ends. */
async function pageMeta(port: number): Promise<PageMeta> {
  const hit = metaCache.get(port);
  if (hit && Date.now() - hit.at < (hit.failed ? META_RETRY_MS : META_MS)) return hit;
  let meta: PageMeta = { title: null, icon: null, web: false };
  let failed = false;
  try {
    // A dev server compiles on its first request, so headers get a generous wait; only the start
    // of the page is read (never a whole multi-hundred-KB document), and then the rest is dropped.
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(PAGE_MS),
    });
    if (
      res.status >= 200 &&
      res.status < 300 &&
      /^text\/html\b/i.test(res.headers.get('content-type') ?? '')
    ) {
      const html = await readStart(res, PAGE_BYTES);
      const found = readPageMeta(html, port);
      // A back end can answer "/" with an HTML content type and an empty body; that is no page.
      if (looksLikePage(html)) {
        meta = { title: found.title, icon: await confirmIcon(port, found.icon), web: true };
      }
    }
  } catch {
    // Not an HTTP app, or too slow. Slow is not the same as "not a web app": remember what was
    // known before instead of demoting an app to a service for one slow answer, and ask again soon.
    failed = true;
    if (hit && !hit.failed) meta = { title: hit.title, icon: hit.icon, web: hit.web };
  }
  metaCache.set(port, { at: Date.now(), failed, ...meta });
  return meta;
}

/** The first `max` bytes of a response as text, then the stream is cancelled. */
async function readStart(res: Response, max: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    while (bytes < max) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

/** The declared icon if it really is an image, else the conventional places, in order. */
async function confirmIcon(port: number, icon: string | null): Promise<string | null> {
  if (icon?.startsWith('data:')) return icon;
  for (const path of new Set([...(icon ? [icon] : []), ...ICON_FALLBACKS])) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: 'manual',
        signal: AbortSignal.timeout(1_500),
      });
      const ok = isImageResponse(res.status, res.headers.get('content-type'));
      await res.body?.cancel();
      if (ok) return path;
    } catch {
      // Try the next place.
    }
  }
  return null;
}

/** Cached for a few seconds: the Preview page polls, and the probes are not free. */
let cache: { at: number; key: string; apps: LocalApp[] } | null = null;
const CACHE_MS = 3_000;

export async function detectLocalApps(
  projects: { id: number; path: string }[],
  blocked: ReadonlySet<number>,
  /** Skip both caches: the Refresh button asks for the state right now. */
  fresh = false,
): Promise<LocalApp[]> {
  if (fresh) {
    cache = null;
    metaCache.clear();
  }
  const key = [...blocked].sort().join(',') + projects.map((p) => `${p.id}=${p.path}`).join('|');
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.apps;
  const found = candidates(await listeners(), blocked);
  const info = await processInfo([...new Set(found.map((l) => l.pid))]);
  const kept = found.filter(
    (l) => !SYSTEM_PROCESSES.has((info.get(l.pid)?.name ?? '').toLowerCase()),
  );
  const metas = await Promise.all(kept.map((l) => pageMeta(l.port)));
  const apps: LocalApp[] = kept.map((l, i) => {
    const p = info.get(l.pid);
    const command = (p?.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return {
      port: l.port,
      pid: l.pid,
      name: p?.name ?? '',
      command,
      projectId: projectForCommand(command, projects),
      title: metas[i]?.title ?? null,
      icon: metas[i]?.icon ?? null,
      web: metas[i]?.web ?? false,
    };
  });
  cache = { at: Date.now(), key, apps };
  return apps;
}

/**
 * Why ProjectManager must not stop this process, or null when it may (PM-270). Pure, so the guards
 * are easy to test: the pid must still be the one listening on that port in a fresh detection (so
 * a stale list can never kill a process that took the pid over), and never this server or the
 * launcher that started it. System services and this app's own ports never reach the list.
 */
export function stopRefusal(
  apps: LocalApp[],
  port: number,
  pid: number,
  protectedPids: ReadonlySet<number>,
): string | null {
  if (protectedPids.has(pid)) return 'That process is ProjectManager itself';
  if (!apps.some((a) => a.port === port && a.pid === pid))
    return `Process ${pid} is no longer listening on port ${port}. Refresh the list.`;
  return null;
}

/** Stops the program listening on a loopback port, with its child processes (PM-270). */
export async function stopLocalApp(
  port: number,
  pid: number,
  projects: { id: number; path: string }[],
  blocked: ReadonlySet<number>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const apps = await detectLocalApps(projects, blocked, true);
  const refusal = stopRefusal(apps, port, pid, new Set([process.pid, process.ppid]));
  if (refusal) return { ok: false, error: refusal };
  try {
    if (process.platform === 'win32') {
      // /T takes its children too (a dev server's workers), like the launcher's cleanup.
      await run('taskkill', ['/pid', String(pid), '/T', '/F'], { timeoutMs: 15_000 });
    } else {
      process.kill(pid, 'SIGTERM');
    }
  } catch (error) {
    return { ok: false, error: `Could not stop process ${pid}: ${(error as Error).message}` };
  } finally {
    cache = null;
    metaCache.delete(port);
  }
  return { ok: true };
}
