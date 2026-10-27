import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { PreviewError, parsePreviewPort } from './preview.js';

// Preview's element picker, the screenshot (PM-311). The app cannot capture a framed page of
// another origin, so this retakes it: a headless Chrome (or Edge) on this computer opens the same
// address at the same viewport size and scroll and returns a PNG. It is a fresh load, without the
// viewer's cookies or open menus, so the dialog says "retaken by ProjectManager".
//  - Only a loopback dev server, by port and path (the preview proxy's rules: 1024+, never this
//    app's own ports); any page navigation that leaves that app is refused.
//  - One browser, started on first use with its profile in this app's data folder, one capture at
//    a time, closed after a few idle minutes and when the server stops.
//  - Over the DevTools protocol with Node's own WebSocket: no new dependency.

const IDLE_MS = 3 * 60_000;
const CAPTURE_TIMEOUT_MS = 25_000;

/** The browser to drive: Chrome, else Edge (every Windows has it), else Chromium on Linux. */
export function findBrowser(env: NodeJS.ProcessEnv = process.env): string | null {
  const candidates =
    process.platform === 'win32'
      ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].flatMap((root) =>
          root
            ? [
                path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
                path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
              ]
            : [],
        )
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  return candidates.find((file) => existsSync(file)) ?? null;
}

export interface CaptureRequest {
  port: number;
  /** Starts with "/": the page's path and query on the app. */
  path: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  /** A scrolled container inside the page, by selector, and how far it was scrolled. */
  inner?: { selector: string; top: number; left: number } | null;
  /** The colour scheme the viewer's page was in (the preview follows the app's theme). */
  dark?: boolean;
  /** The picked element, measured again in the capture so its box lands where it really is. */
  selector?: string | null;
  /**
   * The page as it looked when the owner pressed Add to chat (static HTML from the in-page
   * picker, scripts left out). Rendered with JavaScript off instead of a fresh load, so the shot
   * shows what was on screen: typed text, open menus, loaded data.
   */
  html?: string | null;
}

/** The largest page snapshot accepted (the picker sends nothing bigger). */
export const MAX_SNAPSHOT = 8 * 1024 * 1024;

/** Where the picked element is in the captured image, in CSS pixels (null when not found). */
export type CapturedRect = { x: number; y: number; width: number; height: number } | null;

/** A capture request with every number clamped and the path kept on the app. */
export function normaliseCapture(
  body: CaptureRequest,
  blocked: ReadonlySet<number>,
): CaptureRequest {
  const port = parsePreviewPort(String(body.port), blocked);
  const pathPart = typeof body.path === 'string' && body.path.startsWith('/') ? body.path : '/';
  if (pathPart.startsWith('//')) throw new PreviewError(400, 'Not a path on the app');
  const clamp = (n: unknown, lo: number, hi: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : lo;
  const inner =
    body.inner && typeof body.inner.selector === 'string' && body.inner.selector.length <= 400
      ? {
          selector: body.inner.selector,
          top: clamp(body.inner.top, 0, 1e6),
          left: clamp(body.inner.left, 0, 1e6),
        }
      : null;
  return {
    port,
    path: pathPart.slice(0, 2000),
    width: clamp(body.width, 320, 2560),
    height: clamp(body.height, 240, 2560),
    scrollX: clamp(body.scrollX, 0, 1e6),
    scrollY: clamp(body.scrollY, 0, 1e6),
    inner,
    dark: body.dark === true,
    selector:
      typeof body.selector === 'string' && body.selector.length <= 400 ? body.selector : null,
    html: typeof body.html === 'string' && body.html.length <= MAX_SNAPSHOT ? body.html : null,
  };
}

/** Whether a document request may load: only the app itself (any path), nothing elsewhere. */
export function onTheApp(url: string, port: number): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return true;
    return (
      u.protocol === 'http:' &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) &&
      Number(u.port || 80) === port
    );
  } catch {
    return false;
  }
}

type Pending = (message: { result?: Record<string, unknown>; error?: { message: string } }) => void;

class Cdp {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listeners = new Set<(method: string, params: Record<string, unknown>) => void>();
  constructor(private ws: WebSocket) {
    ws.addEventListener('message', (e) => {
      const m = JSON.parse(String(e.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
      };
      if (m.id !== undefined) this.pending.get(m.id)?.(m as Parameters<Pending>[0]);
      else if (m.method) for (const l of this.listeners) l(m.method, m.params ?? {});
    });
  }
  static async open(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve(), { once: true });
      ws.addEventListener('error', () => reject(new Error('DevTools connection failed')), {
        once: true,
      });
    });
    return new Cdp(ws);
  }
  send(method: string, params: Record<string, unknown> = {}) {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, (m) => {
        this.pending.delete(id);
        if (m.error) reject(new Error(m.error.message));
        else resolve(m.result ?? {});
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(listener: (method: string, params: Record<string, unknown>) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  close() {
    this.ws.close();
  }
}

/** Every capture browser this process started, closed when it exits. */
const open = new Set<PreviewCapture>();
let exitHook = false;

export class PreviewCapture {
  private browser: ChildProcess | null = null;
  private http: string | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private dataDir: string,
    private browserPath: string | null = findBrowser(),
  ) {
    open.add(this);
    if (!exitHook) {
      exitHook = true;
      process.once('exit', () => {
        for (const capture of open) capture.close();
      });
    }
  }

  get available(): boolean {
    return this.browserPath !== null;
  }

  /** One capture at a time: later ones wait their turn. */
  /**
   * Starts the browser ahead of a capture (when the owner starts marking up a page), so the first
   * screenshot does not wait for it. Closed again after the usual idle time if nothing follows.
   */
  warm(): void {
    if (!this.browserPath) return;
    void this.queue.then(async () => {
      try {
        await this.start();
      } catch {
        return; // A capture will report the problem.
      }
      if (this.idle) clearTimeout(this.idle);
      this.idle = setTimeout(() => this.close(), IDLE_MS);
      this.idle.unref?.();
    });
  }

  capture(request: CaptureRequest): Promise<{ png: Buffer; element: CapturedRect }> {
    const run = this.queue.then(() => this.take(request));
    this.queue = run.catch(() => undefined);
    return run;
  }

  close(): void {
    if (this.idle) clearTimeout(this.idle);
    this.browser?.kill();
    this.browser = null;
    this.http = null;
  }

  private async start(): Promise<string> {
    if (this.http && this.browser && this.browser.exitCode === null) return this.http;
    if (!this.browserPath) throw new PreviewError(502, 'No Chrome or Edge on this computer');
    // A profile per server process: a restart that ended this process without cleanup (the dev
    // watcher does) leaves its browser holding its own folder, and a shared one made the next
    // browser exit at once ("The browser exited"). Folders of processes that are gone go.
    const root = path.join(this.dataDir, 'capture-browser');
    const profile = path.join(root, `p${process.pid}`);
    mkdirSync(profile, { recursive: true });
    for (const name of readdirSync(root)) {
      const pid = /^p(\d+)$/.exec(name)?.[1];
      if (!pid || Number(pid) === process.pid || alive(Number(pid))) continue;
      try {
        rmSync(path.join(root, name), { recursive: true, force: true, maxRetries: 0 });
      } catch {
        // Still held by a browser left over: tried again next start.
      }
    }
    const child = spawn(
      this.browserPath,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${profile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-extensions',
        '--hide-scrollbars',
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    this.browser = child;
    const http = await new Promise<string>((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error('The browser did not start')), 15_000);
      child.stderr!.on('data', (chunk: Buffer) => {
        text += chunk.toString();
        const match = /DevTools listening on ws:\/\/([^/]+)\//.exec(text);
        if (match) {
          clearTimeout(timer);
          resolve(`http://${match[1]}`);
        }
      });
      child.on('exit', () => reject(new Error('The browser exited')));
    });
    child.on('exit', () => {
      if (this.browser === child) {
        this.browser = null;
        this.http = null;
      }
    });
    this.http = http;
    return http;
  }

  private async take(request: CaptureRequest): Promise<{ png: Buffer; element: CapturedRect }> {
    if (this.idle) clearTimeout(this.idle);
    const http = await this.start();
    const target = (await fetch(`${http}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
      r.json(),
    )) as { id: string; webSocketDebuggerUrl: string };
    const cdp = await Cdp.open(target.webSocketDebuggerUrl);
    const timeout = setTimeout(() => cdp.close(), CAPTURE_TIMEOUT_MS);
    try {
      // Every document load is checked: the app's own pages pass, anything else is refused.
      // A snapshot is served as the page itself (its first document request is answered with
      // it), so the capture never waits for the app to build and load the page afresh. The
      // picker wrote the page's address as the base, which is the preview proxy's: styles and
      // images load from the app itself instead.
      let snapshot = request.html
        ? request.html.replace(
            /<base href="[^"]*">/,
            `<base href="http://127.0.0.1:${request.port}${request.path.replace(/"/g, '%22')}">`,
          )
        : null;
      if (snapshot) await cdp.send('Emulation.setScriptExecutionDisabled', { value: true });
      await cdp.send('Fetch.enable', { patterns: [{ resourceType: 'Document' }] });
      cdp.on((method, params) => {
        if (method !== 'Fetch.requestPaused') return;
        const url = String((params.request as { url?: string } | undefined)?.url ?? '');
        if (snapshot && onTheApp(url, request.port)) {
          const body = Buffer.from(snapshot).toString('base64');
          snapshot = null; // Only the first load: anything after it is the app's own.
          void cdp
            .send('Fetch.fulfillRequest', {
              requestId: params.requestId,
              responseCode: 200,
              responseHeaders: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }],
              body,
            })
            .catch(() => undefined);
          return;
        }
        void cdp
          .send(
            onTheApp(url, request.port) ? 'Fetch.continueRequest' : 'Fetch.failRequest',
            onTheApp(url, request.port)
              ? { requestId: params.requestId }
              : { requestId: params.requestId, errorReason: 'BlockedByClient' },
          )
          .catch(() => undefined);
      });
      await cdp.send('Page.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: request.width,
        height: request.height,
        deviceScaleFactor: 1,
        mobile: request.width < 600,
      });
      await cdp.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-color-scheme', value: request.dark ? 'dark' : 'light' }],
      });
      const loaded = new Promise<void>((resolve) => {
        const off = cdp.on((method) => {
          if (method === 'Page.loadEventFired') {
            off();
            resolve();
          }
        });
        setTimeout(resolve, 12_000);
      });
      await cdp.send('Page.navigate', { url: `http://127.0.0.1:${request.port}${request.path}` });
      await loaded;
      // Fonts and the first effects settle: until the fonts are in, at most a second (a snapshot has
      // no scripts, so its fonts and images are all that is left to arrive).
      await Promise.race([
        cdp
          .send('Runtime.evaluate', {
            expression: 'document.fonts.ready.then(() => 1)',
            awaitPromise: true,
          })
          .catch(() => undefined),
        new Promise((r) => setTimeout(r, 1000)),
      ]);
      if (!request.html) await new Promise((r) => setTimeout(r, 400)); // A live page's first effects.
      // The resting page at the viewer's scroll: smooth scrolling, transitions and animations are
      // switched off so a scroll lands at once and scroll-reveal effects show their end state
      // (otherwise the shot catches the page mid-way, and the element's box lands elsewhere).
      const inner = request.inner
        ? `const box = document.querySelector(${JSON.stringify(request.inner.selector)}); if (box) { box.scrollTop = ${request.inner.top}; box.scrollLeft = ${request.inner.left}; }`
        : '';
      await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const still = document.createElement('style');
          still.textContent = '*,*::before,*::after{transition:none!important;animation-duration:0s!important;animation-delay:0s!important;scroll-behavior:auto!important}';
          document.documentElement.append(still);
          window.scrollTo({ left: ${request.scrollX}, top: ${request.scrollY}, behavior: 'instant' });
          ${inner}
          for (const el of document.querySelectorAll('[data-pm-scroll]')) {
            const [top, left] = String(el.getAttribute('data-pm-scroll')).split(',').map(Number);
            el.scrollTop = top || 0;
            el.scrollLeft = left || 0;
          }
        })()`,
      });
      // Scroll-triggered effects run and settle (a snapshot has none).
      await new Promise((r) => setTimeout(r, request.html ? 100 : 450));
      let element: CapturedRect = null;
      if (request.selector) {
        const measured = await cdp.send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector(${JSON.stringify(request.selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, width: r.width, height: r.height }); })()`,
          returnByValue: true,
        });
        const value = (measured.result as { value?: unknown } | undefined)?.value;
        if (typeof value === 'string') {
          const r = JSON.parse(value) as { x: number; y: number; width: number; height: number };
          if ([r.x, r.y, r.width, r.height].every(Number.isFinite) && r.width > 0 && r.height > 0)
            element = r;
        }
      }
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      return { png: Buffer.from(String(shot.data), 'base64'), element };
    } finally {
      clearTimeout(timeout);
      cdp.close();
      await fetch(`${http}/json/close/${target.id}`).catch(() => undefined);
      this.idle = setTimeout(() => this.close(), IDLE_MS);
      this.idle.unref?.();
    }
  }
}

/** Whether a process id is still running (signal 0 only checks; works on Windows too). */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
