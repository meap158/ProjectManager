import { randomBytes } from 'node:crypto';
import { PreviewError, parsePreviewPort } from './preview.js';
import { Cdp, onTheApp, type PreviewCapture } from './previewCapture.js';
import type { PreviewStreamState } from '../shared/types.js';

// Streamed preview (PM-693, docs/BUILT-IN-BROWSER.md). Off this computer (a phone on the LAN, the
// remote listener) the read-only path mode cannot load most apps: its frame has an opaque origin,
// and Chrome sends no cookies at all on the requests such a frame makes, so the LAN and remote
// gates (and Cloudflare Access in front of the remote one) refuse every script, style and image.
// Instead, a headless Chrome on this computer (the capture browser) opens the app on its own
// loopback port, where it works exactly as it does locally, and the viewer sees its screen:
//  - Frames come from Page.startScreencast and are served by long-poll under /api/, so the gates'
//    session checks apply to every one and no WebSocket has to cross the tunnel.
//  - Mouse, wheel and keyboard input arrive as JSON posts and are replayed with Input.dispatch*.
//  - The top-level page may only be the app itself (127.0.0.1, localhost or [::1] on that port,
//    the preview's port rules: 1024+, never this app's own ports); any other main-frame load is
//    refused, so this is not a general web browser. Downloads are denied, file pickers never
//    open, dialogs are answered at once, and links that would open a window open in place.
//  - At most MAX_STREAMS at once (each is a browser tab on this computer); one left unpolled for
//    IDLE_MS is closed.

export const MAX_STREAMS = 4;
const IDLE_MS = 45_000;
const SWEEP_MS = 15_000;
/** How long a frame request waits for something new before answering "nothing yet". */
export const POLL_WAIT_MS = 20_000;
const MAX_EVENTS = 64;
const MAX_TEXT = 10_000;

export type StreamState = PreviewStreamState;

export interface StreamOpen {
  port: number;
  path: string;
  width: number;
  height: number;
  scale: number;
  dark: boolean;
}

/** Modifier bits, as the DevTools protocol numbers them. */
const ALT = 1;
const CTRL = 2;
const META = 4;
const SHIFT = 8;

export type StreamInput =
  | {
      type: 'mouse';
      kind: 'down' | 'up' | 'move';
      x: number;
      y: number;
      button: 'left' | 'middle' | 'right' | 'none';
      buttons: number;
      clickCount: number;
      modifiers: number;
    }
  | { type: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers: number }
  | {
      type: 'key';
      kind: 'down' | 'up';
      key: string;
      code: string;
      keyCode: number;
      modifiers: number;
    }
  | { type: 'text'; text: string };

const num = (n: unknown, lo: number, hi: number, fallback = lo) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
const int = (n: unknown, lo: number, hi: number, fallback = lo) =>
  Math.round(num(n, lo, hi, fallback));

/** A stream request with the port checked, the path kept on the app and every number clamped. */
export function parseOpen(body: unknown, blocked: ReadonlySet<number>): StreamOpen {
  const b = (body ?? {}) as Record<string, unknown>;
  const port = parsePreviewPort(String(b.port ?? ''), blocked);
  const raw = typeof b.path === 'string' ? b.path : '/';
  if (!raw.startsWith('/') || raw.startsWith('//'))
    throw new PreviewError(400, 'Not a path on the app');
  return {
    port,
    path: raw.slice(0, 2000),
    ...parseSize(b),
    dark: b.dark === true,
  };
}

export function parseSize(body: unknown): { width: number; height: number; scale: number } {
  const b = (body ?? {}) as Record<string, unknown>;
  return {
    width: int(b.width, 200, 2560, 1280),
    height: int(b.height, 200, 2560, 800),
    scale: num(b.scale, 1, 2, 1),
  };
}

/** The input events of one post, validated; anything malformed refuses the whole batch. */
export function parseInput(body: unknown): StreamInput[] {
  const list = (body as { events?: unknown } | null)?.events;
  if (!Array.isArray(list) || list.length === 0 || list.length > MAX_EVENTS)
    throw new PreviewError(400, `Expected 1 to ${MAX_EVENTS} input events`);
  return list.map((raw): StreamInput => {
    const e = (raw ?? {}) as Record<string, unknown>;
    const modifiers = int(e.modifiers, 0, 15, 0);
    const x = num(e.x, 0, 4096, 0);
    const y = num(e.y, 0, 4096, 0);
    if (e.type === 'mouse' && (e.kind === 'down' || e.kind === 'up' || e.kind === 'move')) {
      const button =
        e.button === 'left' || e.button === 'middle' || e.button === 'right' ? e.button : 'none';
      return {
        type: 'mouse',
        kind: e.kind,
        x,
        y,
        button,
        buttons: int(e.buttons, 0, 31, 0),
        clickCount: int(e.clickCount, 0, 3, e.kind === 'move' ? 0 : 1),
        modifiers,
      };
    }
    if (e.type === 'wheel') {
      return {
        type: 'wheel',
        x,
        y,
        deltaX: num(e.deltaX, -10_000, 10_000, 0),
        deltaY: num(e.deltaY, -10_000, 10_000, 0),
        modifiers,
      };
    }
    if (
      e.type === 'key' &&
      (e.kind === 'down' || e.kind === 'up') &&
      typeof e.key === 'string' &&
      e.key.length > 0 &&
      e.key.length <= 32
    ) {
      return {
        type: 'key',
        kind: e.kind,
        key: e.key,
        code: typeof e.code === 'string' ? e.code.slice(0, 32) : '',
        keyCode: int(e.keyCode, 0, 255, 0),
        modifiers,
      };
    }
    if (e.type === 'text' && typeof e.text === 'string' && e.text.length <= MAX_TEXT) {
      return { type: 'text', text: e.text };
    }
    throw new PreviewError(400, 'Unknown input event');
  });
}

/** What a key press sends to the page: the typed text, and the editing command for a shortcut. */
export function keyEvent(input: Extract<StreamInput, { type: 'key' }>): Record<string, unknown> {
  const { key, code, keyCode, modifiers } = input;
  const base = {
    key,
    code,
    modifiers,
    windowsVirtualKeyCode: keyCode,
    nativeVirtualKeyCode: keyCode,
  };
  if (input.kind === 'up') return { type: 'keyUp', ...base };
  const command = modifiers & (CTRL | META) && !(modifiers & ALT);
  const lower = key.toLowerCase();
  // Headless Chrome has no menu accelerators: editing shortcuts need their command named.
  const commands = !command
    ? []
    : lower === 'a'
      ? ['selectAll']
      : lower === 'z'
        ? [modifiers & SHIFT ? 'redo' : 'undo']
        : lower === 'y'
          ? ['redo']
          : [];
  const text = key === 'Enter' ? '\r' : key.length === 1 && !command ? key : undefined;
  return text
    ? { type: 'keyDown', ...base, text, unmodifiedText: text }
    : { type: 'rawKeyDown', ...base, ...(commands.length ? { commands } : {}) };
}

/**
 * A document inside the page (an embedded video, a map) loads as it would locally, except on this
 * computer's own reserved ports: on loopback only 1024+ and never a port in `blocked` (this app's
 * own, and the preview browser's DevTools port).
 */
export function subframeAllowed(url: string, blocked: ReadonlySet<number>): boolean {
  try {
    const u = new URL(url);
    if (u.protocol === 'about:' || u.protocol === 'data:' || u.protocol === 'blob:') return true;
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const loopback =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.startsWith('127.');
    if (!loopback) return true;
    const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
    return port >= 1024 && !blocked.has(port);
  } catch {
    return false;
  }
}

// Links that would open another window open in place instead (a second window would be a tab
// nobody can see), and window.open navigates this tab. Runs before the page's own scripts.
const IN_PLACE = `(() => {
  const go = (u) => { try { if (u) location.assign(new URL(String(u), location.href).href); } catch {} return null; };
  try { Object.defineProperty(window, 'open', { value: go, configurable: true, writable: true }); } catch {}
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest('a[target], area[target]') : null;
    if (a && !['', '_self', '_top', '_parent'].includes(a.getAttribute('target') || '')) a.setAttribute('target', '_self');
  }, true);
  document.addEventListener('submit', (e) => {
    const f = e.target;
    if (f instanceof HTMLFormElement && f.target && !['_self', '_top', '_parent'].includes(f.target)) f.target = '_self';
  }, true);
})();`;

const EDITABLE = `(() => { const a = document.activeElement; return !!a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)); })()`;

class Stream {
  version = 0;
  frame: Buffer | null = null;
  lastSeen = Date.now();
  ended = false;
  private waiters = new Set<() => void>();
  private size: { width: number; height: number; scale: number };

  constructor(
    readonly id: string,
    readonly port: number,
    private cdp: Cdp,
    readonly targetId: string,
    /** The browser's DevTools address, to close this tab. */
    readonly http: string,
    private blocked: () => ReadonlySet<number>,
    open: StreamOpen,
    public state: StreamState,
  ) {
    this.size = { width: open.width, height: open.height, scale: open.scale };
  }

  /** Wakes every frame request waiting on this stream. */
  bump(): void {
    this.version++;
    for (const wake of this.waiters) wake();
    this.waiters.clear();
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.bump();
    this.cdp.close();
  }

  /** Resolves when there is something newer than `after`, the stream ends, or the wait is up. */
  wait(after: number, ms: number, signal?: AbortSignal): Promise<void> {
    this.lastSeen = Date.now();
    if (this.version > after || this.ended) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  send(method: string, params: Record<string, unknown> = {}) {
    if (this.ended) throw new PreviewError(404, 'This preview has closed');
    return this.cdp.send(method, params);
  }

  async setup(open: StreamOpen): Promise<void> {
    const cdp = this.cdp;
    cdp.on((method, params) => void this.onEvent(method, params));
    // Every main-frame document load is checked: the app's own pages pass, anything else is
    // refused. Frames inside the page (an embedded video, a map) load as they would locally.
    await this.send('Fetch.enable', { patterns: [{ resourceType: 'Document' }] });
    await this.send('Page.enable');
    await this.send('Page.addScriptToEvaluateOnNewDocument', { source: IN_PLACE });
    await this.send('Page.setInterceptFileChooserDialog', { enabled: true }).catch(() => undefined);
    await this.send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => undefined);
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => undefined);
    await this.theme(open.dark);
    await this.resize(this.size);
    await this.send('Page.navigate', { url: `http://127.0.0.1:${open.port}${open.path}` });
  }

  async theme(dark: boolean): Promise<void> {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }],
    });
  }

  async resize(size: { width: number; height: number; scale: number }): Promise<void> {
    this.size = size;
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: size.scale,
      mobile: size.width < 600,
    });
    await this.send('Page.stopScreencast').catch(() => undefined);
    await this.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 70,
      maxWidth: Math.round(size.width * size.scale),
      maxHeight: Math.round(size.height * size.scale),
      everyNthFrame: 1,
    });
    this.state = { ...this.state, width: size.width, height: size.height };
    this.bump();
  }

  private async onEvent(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      if (method === 'Fetch.requestPaused') {
        const url = String((params.request as { url?: string } | undefined)?.url ?? '');
        const main = params.frameId === this.targetId;
        const allowed = main
          ? onTheApp(url, this.port)
          : subframeAllowed(url, new Set([...this.blocked(), Number(new URL(this.http).port)]));
        await this.send(
          allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest',
          allowed
            ? { requestId: params.requestId }
            : { requestId: params.requestId, errorReason: 'BlockedByClient' },
        );
      } else if (method === 'Page.screencastFrame') {
        // Acknowledge at once, or Chrome stops sending; only the newest frame is kept.
        void this.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(
          () => undefined,
        );
        this.frame = Buffer.from(String(params.data), 'base64');
        this.bump();
      } else if (method === 'Page.javascriptDialogOpening') {
        // Nobody can see a dialog here: alerts are dismissed, confirms and prompts declined.
        const type = String(params.type);
        await this.send('Page.handleJavaScriptDialog', {
          accept: type === 'alert' || type === 'beforeunload',
        });
      } else if (method === 'Page.frameStartedLoading' && params.frameId === this.targetId) {
        this.state = { ...this.state, loading: true };
        this.bump();
      } else if (
        (method === 'Page.frameNavigated' && !(params.frame as { parentId?: string }).parentId) ||
        (method === 'Page.navigatedWithinDocument' && params.frameId === this.targetId) ||
        method === 'Page.loadEventFired' ||
        (method === 'Page.frameStoppedLoading' && params.frameId === this.targetId)
      ) {
        await this.refresh(
          method === 'Page.loadEventFired' || method === 'Page.frameStoppedLoading',
        );
      }
    } catch {
      // The tab closed mid-event: the stream ends through the socket.
    }
  }

  /** Reads the address, title and history again after a navigation. */
  async refresh(loaded = false): Promise<void> {
    const history = (await this.send('Page.getNavigationHistory')) as {
      currentIndex: number;
      entries: { url: string; title: string }[];
    };
    const entry = history.entries[history.currentIndex];
    this.state = {
      ...this.state,
      url: entry?.url ?? this.state.url,
      title: entry?.title ?? this.state.title,
      // The tab starts on about:blank, which is not a page to go back to.
      canGoBack: history.entries
        .slice(0, history.currentIndex)
        .some((e) => e.url !== 'about:blank'),
      canGoForward: history.currentIndex < history.entries.length - 1,
      loading: loaded ? false : this.state.loading,
    };
    this.bump();
  }

  async step(delta: -1 | 1): Promise<void> {
    const history = (await this.send('Page.getNavigationHistory')) as {
      currentIndex: number;
      entries: { id: number; url: string }[];
    };
    const entry = history.entries[history.currentIndex + delta];
    if (entry && entry.url !== 'about:blank')
      await this.send('Page.navigateToHistoryEntry', { entryId: entry.id });
  }

  /** Replays a batch in order; says whether a text field has focus after a click. */
  async input(events: StreamInput[]): Promise<{ editable: boolean | null }> {
    let clicked = false;
    for (const e of events) {
      if (e.type === 'mouse') {
        await this.send('Input.dispatchMouseEvent', {
          type:
            e.kind === 'down' ? 'mousePressed' : e.kind === 'up' ? 'mouseReleased' : 'mouseMoved',
          x: e.x,
          y: e.y,
          button: e.button,
          buttons: e.buttons,
          clickCount: e.clickCount,
          modifiers: e.modifiers,
        });
        if (e.kind === 'up') clicked = true;
      } else if (e.type === 'wheel') {
        await this.send('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: e.x,
          y: e.y,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          modifiers: e.modifiers,
        });
      } else if (e.type === 'key') {
        await this.send('Input.dispatchKeyEvent', keyEvent(e));
      } else {
        await this.send('Input.insertText', { text: e.text });
      }
    }
    if (!clicked) return { editable: null };
    const result = await this.send('Runtime.evaluate', {
      expression: EDITABLE,
      returnByValue: true,
    });
    return { editable: (result.result as { value?: unknown } | undefined)?.value === true };
  }
}

/** Every streamed preview of this server, sharing the capture browser. */
export class PreviewStreams {
  private streams = new Map<string, Stream>();
  private sweeper: ReturnType<typeof setInterval> | null = null;

  constructor(
    private capture: PreviewCapture,
    private blocked: () => ReadonlySet<number>,
    private now: () => number = Date.now,
  ) {}

  get available(): boolean {
    return this.capture.available;
  }

  get count(): number {
    return this.streams.size;
  }

  async open(body: unknown): Promise<{ id: string; state: StreamState }> {
    const request = parseOpen(body, this.blocked());
    if (!this.capture.available) throw new PreviewError(502, 'No Chrome or Edge on this computer');
    // A new one past the cap replaces the one used least recently.
    while (this.streams.size >= MAX_STREAMS) {
      const oldest = [...this.streams.values()].sort((a, b) => a.lastSeen - b.lastSeen)[0]!;
      await this.close(oldest.id);
    }
    const http = await this.capture.acquire();
    // The hold passes to the stream once it is registered; close() releases it from then on.
    let owned = false;
    let targetId: string | null = null;
    try {
      const target = (await fetch(`${http}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
        r.json(),
      )) as { id: string; webSocketDebuggerUrl: string };
      targetId = target.id;
      const cdp = await Cdp.open(target.webSocketDebuggerUrl);
      const id = randomBytes(16).toString('base64url');
      const stream = new Stream(id, request.port, cdp, target.id, http, this.blocked, request, {
        url: `http://127.0.0.1:${request.port}${request.path}`,
        title: '',
        loading: true,
        canGoBack: false,
        canGoForward: false,
        width: request.width,
        height: request.height,
      });
      stream.lastSeen = this.now();
      this.streams.set(id, stream);
      owned = true;
      void cdp.closed.then(() => this.close(id));
      try {
        await stream.setup(request);
      } catch (error) {
        await this.close(id);
        throw error;
      }
      this.sweep();
      console.log(`[preview] streaming localhost:${request.port}${request.path}`);
      return { id, state: stream.state };
    } catch (error) {
      if (!owned) {
        if (targetId) await fetch(`${http}/json/close/${targetId}`).catch(() => undefined);
        this.capture.release();
      }
      if (error instanceof PreviewError) throw error;
      throw new PreviewError(
        502,
        `The preview browser could not open the page: ${(error as Error).message}`,
      );
    }
  }

  get(id: string): Stream {
    const stream = this.streams.get(id);
    if (!stream || stream.ended)
      throw new PreviewError(404, 'This preview has closed; open it again');
    stream.lastSeen = this.now();
    return stream;
  }

  /** The newest frame once it is newer than `after` (null: nothing new within the wait). */
  async frame(
    id: string,
    after: number,
    signal?: AbortSignal,
    waitMs = POLL_WAIT_MS,
  ): Promise<{ version: number; frame: Buffer | null; state: StreamState } | null> {
    const stream = this.get(id);
    await stream.wait(after, waitMs, signal);
    if (stream.ended) throw new PreviewError(404, 'This preview has closed; open it again');
    if (stream.version <= after) return null;
    return { version: stream.version, frame: stream.frame, state: stream.state };
  }

  async input(id: string, body: unknown) {
    const events = parseInput(body);
    return this.get(id).input(events);
  }

  async navigate(id: string, body: unknown): Promise<void> {
    const stream = this.get(id);
    const b = (body ?? {}) as { action?: unknown; path?: unknown };
    if (b.action === 'back') return stream.step(-1);
    if (b.action === 'forward') return stream.step(1);
    if (b.action === 'reload') {
      await stream.send('Page.reload');
      return;
    }
    if (b.action === 'go' && typeof b.path === 'string') {
      if (!b.path.startsWith('/') || b.path.startsWith('//'))
        throw new PreviewError(400, 'Not a path on the app');
      await stream.send('Page.navigate', {
        url: `http://127.0.0.1:${stream.port}${b.path.slice(0, 2000)}`,
      });
      return;
    }
    throw new PreviewError(400, 'Unknown navigation');
  }

  async resize(id: string, body: unknown): Promise<void> {
    const stream = this.get(id);
    const dark = (body as { dark?: unknown } | null)?.dark;
    if (typeof dark === 'boolean') await stream.theme(dark);
    await stream.resize(parseSize(body));
  }

  async close(id: string): Promise<void> {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    stream.end();
    // A browser that is gone took the tab with it, so a failed close is fine.
    await fetch(`${stream.http}/json/close/${stream.targetId}`).catch(() => undefined);
    this.capture.release();
  }

  closeAll(): void {
    for (const id of [...this.streams.keys()]) void this.close(id);
  }

  /** Streams nobody has polled for a while are closed; the sweep stops when none are left. */
  private sweep(): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => {
      const now = this.now();
      for (const s of [...this.streams.values()])
        if (now - s.lastSeen > IDLE_MS) void this.close(s.id);
      if (this.streams.size === 0 && this.sweeper) {
        clearInterval(this.sweeper);
        this.sweeper = null;
      }
    }, SWEEP_MS);
    this.sweeper.unref?.();
  }
}
