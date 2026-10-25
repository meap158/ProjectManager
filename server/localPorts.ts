import type { LocalApp } from '../shared/types.js';
import { run } from './analysis/exec.js';

// Built-in browser (PM-253): which apps are listening on this computer's loopback, so the Preview
// page can list them instead of asking for a port. Read only: it runs `netstat` (Windows) or
// `lsof` (macOS/Linux) with fixed arguments, and on Windows asks WMI for the listeners' command
// lines to attribute them to a project. Nothing here touches a project's files.

export interface Listener {
  port: number;
  pid: number;
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
    const listener = { port: Number(m[2]), pid: Number(m[3]) };
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
        out.set(`${m[2]}:${pid}`, { port: Number(m[2]), pid });
    }
  }
  return [...out.values()];
}

/** Ports an app could be opened on: not privileged, not ephemeral, not this app's own. */
export function candidates(listeners: Listener[], blocked: ReadonlySet<number>): Listener[] {
  return listeners
    .filter((l) => l.port >= MIN_PORT && l.port < EPHEMERAL_FROM && !blocked.has(l.port))
    .sort((a, b) => a.port - b.port);
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
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["'][^"']*\bicon\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    icon = localPath(href, port);
    if (icon) break;
  }
  return { title: title ? title.slice(0, 80) : null, icon: icon ?? '/favicon.ico' };
}

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

const metaCache = new Map<number, { at: number; title: string | null; icon: string | null }>();
const META_MS = 30_000;

/** Asks the app for "/" briefly. Apps that don't speak HTML just have no title or icon. */
async function pageMeta(port: number): Promise<{ title: string | null; icon: string | null }> {
  const hit = metaCache.get(port);
  if (hit && Date.now() - hit.at < META_MS) return hit;
  let meta: { title: string | null; icon: string | null } = { title: null, icon: null };
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      redirect: 'manual',
      headers: { accept: 'text/html' },
      signal: AbortSignal.timeout(1_500),
    });
    if (/^text\/html\b/i.test(res.headers.get('content-type') ?? '')) {
      meta = readPageMeta(await res.text(), port);
    }
  } catch {
    // Not an HTTP app, or too slow: the list still shows the port.
  }
  metaCache.set(port, { at: Date.now(), ...meta });
  return meta;
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
    };
  });
  cache = { at: Date.now(), key, apps };
  return apps;
}
