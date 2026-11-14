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
//  - Frames come from Page.startScreencast and are pushed on one event stream under /api/ (PM-727),
//    so the gates' session checks apply and no WebSocket has to cross the tunnel. Only the newest
//    frame is ever sent, at most FEED_FPS a second, and no more than FEED_WINDOW frames the viewer
//    has not acknowledged yet: a slow link drops frames instead of falling behind. Long-poll
//    (one frame per request) stays as the fallback for a connection that buffers the stream.
//  - Mouse, wheel and keyboard input arrive as JSON posts and are replayed with Input.dispatch*.
//    The viewer sends them without waiting for the previous post; a sequence number puts them
//    back in order here, so keys and clicks never interleave.
//  - The top-level page may only be the app itself (127.0.0.1, localhost or [::1] on that port,
//    the preview's port rules: 1024+, never this app's own ports); any other main-frame load is
//    refused, so this is not a general web browser. Downloads are denied, file pickers never
//    open, dialogs are answered at once, and links that would open a window open in place.
//  - At most MAX_STREAMS at once (each is a browser tab on this computer); one left unpolled for
//    IDLE_MS is closed.
//  - Picture quality (PM-730): streams have a browser of their own launched at a fixed 2x device
//    scale (without it, Chrome sends 1x frames whatever scale a tab asks for, and a high-density
//    screen shows them blurred). Frames are WebP where Chrome can encode it (about 40% smaller than
//    JPEG at the same rate). While the picture moves, frames come at the viewer's full scale only
//    over a link that has shown it keeps up, else at 1x; once the picture has been still for
//    STILL_MS, one exact still at full scale replaces the last frame (PNG over a fast link, WebP
//    90 otherwise). A frame identical to the one before is never sent.

export const MAX_STREAMS = 4;
const IDLE_MS = 45_000;
const SWEEP_MS = 15_000;
/** How long a frame request waits for something new before answering "nothing yet". */
export const POLL_WAIT_MS = 20_000;
const MAX_EVENTS = 64;
const MAX_TEXT = 10_000;
/** The pushed feed's limits (PM-727): frames a second, unacknowledged frames, heartbeat. */
export const FEED_FPS = 60;
export const FEED_WINDOW = 4;
/**
 * The window adapts to delay (PM-730): it grows while frames arrive about as fast as the quickest
 * recently seen (nothing queues), and shrinks once they take QUEUE_MS longer (a queue is forming).
 * A slow link keeps its picture current; a fast one far away is not held to 4 frames a round trip.
 */
const WINDOW_MIN = 2;
const WINDOW_MAX = 30;
const QUEUE_MS = 60;
const MIN_DELIVERY_SPAN_MS = 10_000;
/** With no acknowledgement for this long, one more frame goes out (a lost ack never stalls it). */
const FEED_ACK_WAIT_MS = 2_000;
const FEED_HEARTBEAT_MS = 15_000;
/** Timers on Windows fire up to ~15 ms late: a frame this early counts as on time. */
const FEED_SLACK_MS = 4;
/** An input post whose predecessor never arrives runs after this long anyway. */
const INPUT_GAP_MS = 1_000;
/**
 * The stream browser's switches (PM-730): render at 2x, so frames can match the viewer's screen,
 * and scroll without animation. Wheel turns arrive merged, and Chrome animated each merged jump
 * for up to 2 s after the hand stopped; the viewer's own device already smooths its wheel.
 */
export const STREAM_BROWSER_ARGS = ['--force-device-scale-factor=2', '--disable-smooth-scrolling'];
const RENDER_SCALE = 2;
const MOTION_QUALITY = 70;
/** The picture counts as settled after this long without a new frame, and gets an exact still. */
export const STILL_MS = 300;
/** A still replaced this soon by a new frame doubles the wait before the next (up to the max). */
const STILL_BUSY_MS = 1_500;
const STILL_MAX_MS = 5_000;
/** A change this long after the frame before is slow (a caret, a clock): the still mode stays. */
const SLOW_CHANGE_MS = 250;
/** Over a slow link the picture must be still this long before its still. */
export const STILL_SLOW_LINK_MS = 1_000;
/** Over a slow link, slow changes in the exact mode go at most this often. */
const SLOW_LINK_EXACT_MS = 2_000;
/**
 * A link counts as fast while frames reach the viewer and come back acknowledged within FAST_MS
 * on average, and slow again past SLOW_MS. Motion frames switch scale at most every SWITCH_MS.
 */
const FAST_MS = 120;
const SLOW_MS = 250;
const SWITCH_MS = 3_000;
/** Going back to 1x this soon after going sharp means the link cannot carry it: retry much later. */
const SHARP_FAILED_MS = 10_000;
const SHARP_RETRY_MS = 60_000;
const WEBP_MAX_PIXELS = 1_100_000;

/** An encoded image's type, from its first base64 characters. */
export function imageMime(base64: string): string {
  if (base64.startsWith('UklGR')) return 'image/webp';
  if (base64.startsWith('iVBOR')) return 'image/png';
  return 'image/jpeg';
}
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

/** An input post's sequence number (1, 2, ...), or null for a post sent without one. */
export function parseSeq(body: unknown): number | null {
  const seq = (body as { seq?: unknown } | null)?.seq;
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

/** One frame of the pushed feed, as a server-sent event (`image` is base64, null: state only). */
export function feedEvent(version: number, state: StreamState, image: string | null): string {
  const data = image
    ? { v: version, t: Date.now(), state, image, mime: imageMime(image) }
    : { v: version, t: Date.now(), state, image: null };
  return `event: frame\ndata: ${JSON.stringify(data)}\n\n`;
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

/**
 * The cursor a browser would show at (x, y) (PM-730): the element's own, else a text cursor over
 * a text field or selectable text, a hand over a link, the arrow otherwise. Read-only.
 */
export function cursorAt(x: number, y: number): string {
  return `((x, y) => {
  const el = document.elementFromPoint(x, y);
  if (!el) return 'default';
  const style = getComputedStyle(el);
  const own = (style.cursor || 'auto').split(',').pop().trim();
  if (own !== 'auto') return own;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return 'text';
  if (el.tagName === 'INPUT' && !/^(button|submit|reset|checkbox|radio|range|color|file|image)$/i.test(el.type)) return 'text';
  if (el.closest('a[href]')) return 'pointer';
  const at = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
  if (at && at.startContainer.nodeType === 3 && style.userSelect !== 'none') {
    const range = document.createRange();
    range.selectNodeContents(at.startContainer);
    for (const r of range.getClientRects())
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return 'text';
  }
  return 'default';
})(${Math.round(x)}, ${Math.round(y)})`;
}

/** CSS cursor keywords the viewer may show; anything else (an image cursor) shows the arrow. */
const CURSORS = new Set([
  'default',
  'pointer',
  'text',
  'vertical-text',
  'move',
  'grab',
  'grabbing',
  'crosshair',
  'not-allowed',
  'no-drop',
  'wait',
  'progress',
  'help',
  'context-menu',
  'cell',
  'copy',
  'alias',
  'zoom-in',
  'zoom-out',
  'all-scroll',
  'col-resize',
  'row-resize',
  'n-resize',
  'e-resize',
  's-resize',
  'w-resize',
  'ne-resize',
  'nw-resize',
  'se-resize',
  'sw-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'none',
]);

export function streamCursor(raw: unknown): string {
  return typeof raw === 'string' && CURSORS.has(raw) ? raw : 'default';
}

/** The cursor is read at most this often while the pointer moves (the last position always). */
const CURSOR_EVERY_MS = 100;

/** One streamed preview: a browser tab on this computer (exported for tests). */
export class Stream {
  version = 0;
  /** The newest frame as Chrome sent it (base64), for the pushed feed. */
  frameB64: string | null = null;
  /** The version at which the frame last changed (a state change alone keeps the picture). */
  frameAt = 0;
  lastSeen = Date.now();
  ended = false;
  private waiters = new Set<() => void>();
  /** The pushed feed (PM-727): which one is current, what it sent and what the viewer has shown. */
  private feedGen = 0;
  private sent: { v: number; at: number; still: boolean }[] = [];
  /** Whether the current frame is a still (stills are not timed: they are larger by design). */
  private frameIsStill = false;
  private acked = 0;
  private ackAt = 0;
  /** Long-poll's copy of the frame as bytes, made only when it asks (PM-730). */
  private bytes: { of: string; buffer: Buffer } | null = null;
  /** The last screencast frame, to drop an identical one (a still makes Chrome send one). */
  private lastCast: string | null = null;
  /** The still (PM-730): asked for ('waiting' its first frame) or on screen ('shown'). */
  private stillMode: 'off' | 'waiting' | 'shown' = 'off';
  private castChain: Promise<void> = Promise.resolve();
  private castWaiting = false;
  private lastFrameAt = 0;
  /** A slow change waiting its turn over a slow link (see SLOW_LINK_EXACT_MS). */
  private heldExact: string | null = null;
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
  private stillTimer: ReturnType<typeof setTimeout> | null = null;
  private stillWait = STILL_MS;
  private stillAt = 0;
  /** Average time from sending a frame to its acknowledgement (null: not measured yet). */
  private delivery: number | null = null;
  /** Whether motion frames come at the viewer's full scale (a proven fast link) or at 1x. */
  private sharpMotion = false;
  private switchedAt = 0;
  private sharpBlockedUntil = 0;
  /** The feed's window in frames, and recent delivery times to find the quickest. */
  window = FEED_WINDOW;
  private deliveries: { at: number; ms: number }[] = [];
  private shrunkAt = 0;
  private webp = true;
  /** Input posts in order: the next sequence number to run and the posts waiting for their turn. */
  private inputNext = 1;
  private inputTurns = new Map<number, () => void>();
  private inputChain: Promise<unknown> = Promise.resolve();
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
    this.wake();
  }

  private wake(): void {
    for (const wake of [...this.waiters]) wake();
    this.waiters.clear();
  }

  /** Resolves on the next bump or acknowledgement, abort, or after `ms`. */
  private nap(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.ended || signal?.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, Math.max(0, ms));
      this.waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** The viewer has shown frame `version`; frames up to it no longer count against the window. */
  ack(version: number, held = 0): void {
    if (version <= this.acked) return;
    const now = Date.now();
    const shown = this.sent.find((s) => s.v === version);
    // `held`: how long the viewer kept the acknowledgement before sending it (it sends one at a
    // time), which is not the link's delay.
    if (shown && !shown.still) {
      // The window grows only while it is what holds frames back, never untested.
      const full = this.sent.length >= Math.floor(this.window) - 1;
      const frames = full ? this.sent.filter((s) => s.v <= version).length : 0;
      this.measure(Math.max(0, now - shown.at - held), now, frames);
    }
    this.acked = version;
    this.ackAt = now;
    this.sent = this.sent.filter((s) => s.v > version);
    this.wake();
  }

  /** The newest frame as bytes, for long-poll. */
  get frame(): Buffer | null {
    if (!this.frameB64) return null;
    if (this.bytes?.of !== this.frameB64)
      this.bytes = { of: this.frameB64, buffer: Buffer.from(this.frameB64, 'base64') };
    return this.bytes.buffer;
  }

  get frameMime(): string {
    return this.frameB64 ? imageMime(this.frameB64) : 'image/jpeg';
  }

  /**
   * One frame's delivery time (sent to acknowledged): motion frames go sharp over a link that keeps
   * up and back to 1x over one that does not, at most once every SWITCH_MS.
   */
  measure(ms: number, now = Date.now(), frames = 1): void {
    this.deliveries.push({ at: now, ms });
    while (this.deliveries.length && now - this.deliveries[0]!.at > MIN_DELIVERY_SPAN_MS)
      this.deliveries.shift();
    const quickest = Math.min(...this.deliveries.map((d) => d.ms));
    if (ms <= quickest + QUEUE_MS) {
      // One frame more per window's worth delivered on time (an acknowledgement covers `frames`).
      this.window = Math.min(WINDOW_MAX, this.window + frames / this.window);
    } else if (now - this.shrunkAt >= quickest) {
      // At most once a round trip: the frames already on their way were sent under the old window.
      this.window = Math.max(WINDOW_MIN, this.window * 0.7);
      this.shrunkAt = now;
    }
    this.delivery = this.delivery === null ? ms : this.delivery * 0.7 + ms * 0.3;
    if (now - this.switchedAt < SWITCH_MS || now < this.sharpBlockedUntil) return;
    const sharp = this.sharpMotion ? this.delivery <= SLOW_MS : this.delivery <= FAST_MS;
    if (sharp === this.sharpMotion) return;
    if (!sharp && now - this.switchedAt < SHARP_FAILED_MS)
      this.sharpBlockedUntil = now + SHARP_RETRY_MS;
    this.sharpMotion = sharp;
    this.switchedAt = now;
    void this.cast().catch(() => undefined);
  }

  /**
   * The pushed feed (PM-727): server-sent events, the newest frame each time, paced by FEED_FPS
   * and FEED_WINDOW. It pulls one event at a time, so nothing queues here either. A newer feed
   * for the same stream ends this one.
   */
  feed(signal?: AbortSignal): ReadableStream<Uint8Array> {
    const gen = ++this.feedGen;
    this.sent = [];
    this.acked = 0;
    this.ackAt = Date.now();
    const encoder = new TextEncoder();
    const gap = 1000 / FEED_FPS;
    let after = 0;
    let started = false;
    let lastSent = 0;
    let lastWrite = Date.now();
    let cancelled = false;
    const live = () => !cancelled && !this.ended && !signal?.aborted && gen === this.feedGen;
    const next = async (): Promise<string | null> => {
      // The first event goes out at once, so the viewer can tell the stream is not buffered.
      if (!started) {
        started = true;
        after = this.version;
        lastSent = lastWrite = Date.now();
        return feedEvent(this.version, this.state, this.frameB64);
      }
      while (live()) {
        const now = Date.now();
        this.lastSeen = now;
        const inFlight = this.sent.length;
        const limit = Math.floor(this.window);
        const windowOpen = inFlight < limit || now - this.ackAt >= FEED_ACK_WAIT_MS;
        if (this.version > after && windowOpen && now - lastSent >= gap - FEED_SLACK_MS) {
          // The picture goes only when it changed; a state change alone sends just the state.
          const jpeg = this.frameAt > after ? this.frameB64 : null;
          after = this.version;
          lastSent = lastWrite = now;
          if (jpeg) {
            this.sent.push({ v: after, at: now, still: this.frameIsStill });
            // A frame sent past a full window restarts the wait for an acknowledgement.
            if (inFlight >= limit) this.ackAt = now;
          }
          return feedEvent(after, this.state, jpeg);
        }
        if (now - lastWrite >= FEED_HEARTBEAT_MS) {
          lastWrite = now;
          return ': still here\n\n';
        }
        const until = Math.min(
          lastWrite + FEED_HEARTBEAT_MS,
          this.version > after && windowOpen
            ? lastSent + gap
            : this.version > after
              ? this.ackAt + FEED_ACK_WAIT_MS
              : Infinity,
        );
        await this.nap(until - now, signal);
      }
      return null;
    };
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const chunk = await next();
          if (chunk === null) controller.close();
          else controller.enqueue(encoder.encode(chunk));
        },
        cancel: () => {
          cancelled = true;
          this.wake();
        },
      },
      { highWaterMark: 0 },
    );
  }

  /**
   * Runs one input post in its sequence order: post n waits for n-1 to finish (or INPUT_GAP_MS,
   * if n-1 never arrives). A post without a number runs after whatever is running.
   */
  async ordered<T>(seq: number | null, run: () => Promise<T>): Promise<T> {
    if (seq !== null) {
      while (seq > this.inputNext && !this.ended) {
        const turn = new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), INPUT_GAP_MS);
          this.inputTurns.set(seq, () => {
            clearTimeout(timer);
            resolve(true);
          });
        });
        if (!(await turn)) this.inputNext = Math.max(this.inputNext, seq);
        this.inputTurns.delete(seq);
      }
    }
    const result = this.inputChain.then(run);
    this.inputChain = result.catch(() => undefined);
    try {
      return await result;
    } finally {
      if (seq !== null && seq >= this.inputNext) {
        this.inputNext = seq + 1;
        this.inputTurns.get(this.inputNext)?.();
      }
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    if (this.stillTimer) clearTimeout(this.stillTimer);
    if (this.cursorTimer) clearTimeout(this.cursorTimer);
    this.dropHeld();
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
    // The page always renders at 2x (the stream browser's switch makes that real pixels); the
    // screencast and stills scale it down to what the viewer's screen shows.
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: RENDER_SCALE,
      mobile: size.width < 600,
    });
    await this.cast();
    this.state = { ...this.state, width: size.width, height: size.height };
    this.bump();
  }

  /**
   * (Re)starts the screencast. For motion: at the viewer's own scale over a fast link, else 1x.
   * For a still: exact (PNG) over a fast link, else WebP 90, always at the viewer's full scale.
   * Chrome sends the current picture as soon as a screencast starts, which is the still.
   * Restarts run one at a time ("Screencast is already active" otherwise), and one already
   * waiting covers later asks: it reads the settings when it runs.
   */
  private cast(): Promise<void> {
    if (this.castWaiting) return this.castChain;
    this.castWaiting = true;
    const run = this.castChain.then(() => {
      this.castWaiting = false;
      return this.restartCast();
    });
    this.castChain = run.catch(() => undefined);
    return run;
  }

  private async restartCast(): Promise<void> {
    const still = this.stillMode !== 'off';
    const scale = this.sharpMotion || still ? this.size.scale : 1;
    const params = {
      quality: still ? 90 : MOTION_QUALITY,
      maxWidth: Math.round(this.size.width * scale),
      maxHeight: Math.round(this.size.height * scale),
      everyNthFrame: 1,
    };
    await this.send('Page.stopScreencast').catch(() => undefined);
    if (still && this.sharpMotion) {
      await this.send('Page.startScreencast', { format: 'png', ...params });
      return;
    }
    // WebP keeps up only to about a megapixel (measured: 27 fps at 1280x800, 7 at 2560x1600), but
    // over a slow link its smaller frames count for more than its rate: JPEG only for large
    // frames over a fast one.
    if (
      this.webp &&
      (still || !this.sharpMotion || params.maxWidth * params.maxHeight <= WEBP_MAX_PIXELS)
    ) {
      try {
        await this.send('Page.startScreencast', { format: 'webp', ...params });
        return;
      } catch (e) {
        // An older browser without WebP frames; any other failure is not about the format.
        if (/already active/i.test((e as Error).message)) throw e;
        this.webp = false;
      }
    }
    await this.send('Page.startScreencast', { format: 'jpeg', ...params });
  }

  /** A new screencast frame: identical ones are dropped, and a still is planned for when it settles. */
  onFrame(data: string): void {
    if (data === this.lastCast) return;
    this.lastCast = data;
    const now = Date.now();
    const gap = now - this.lastFrameAt;
    this.lastFrameAt = now;
    if (this.stillMode === 'shown' && gap >= SLOW_CHANGE_MS) {
      // A slow change (a blinking caret, a clock) keeps the exact frames: nothing is moving.
      // Over a slow link they go at most every SLOW_LINK_EXACT_MS (the newest waiting), or a
      // blinking caret's full-size frames would fill the link and hold back the viewer's typing.
      this.frameIsStill = true;
      if (this.sharpMotion || now - this.stillAt >= SLOW_LINK_EXACT_MS) {
        this.stillAt = now;
        this.show(data);
      } else {
        this.heldExact = data;
        this.heldTimer ??= setTimeout(
          () => {
            this.heldTimer = null;
            const held = this.heldExact;
            this.heldExact = null;
            if (held && this.stillMode === 'shown' && !this.ended) {
              this.stillAt = Date.now();
              this.show(held);
            }
          },
          this.stillAt + SLOW_LINK_EXACT_MS - now,
        );
        this.heldTimer.unref?.();
      }
      return;
    }
    if (this.stillMode === 'waiting') {
      // The first frame of the still screencast: the settled picture, exact.
      this.stillMode = 'shown';
      this.frameIsStill = true;
      this.stillAt = Date.now();
      this.show(data);
      return;
    }
    if (this.stillMode === 'shown') {
      // The page started moving after its still: back to motion frames. A still replaced this
      // soon means the page keeps moving on its own (an animation): wait longer next time. One
      // that lasted resets the wait.
      this.stillWait =
        now - this.stillAt < STILL_BUSY_MS ? Math.min(STILL_MAX_MS, this.stillWait * 2) : STILL_MS;
      this.toMotion();
    }
    this.frameIsStill = false;
    this.show(data);
    if (this.stillTimer) clearTimeout(this.stillTimer);
    // Over a slow link a full-size still costs a good part of a second: short pauses (between
    // keys, mid-scroll) do not get one, or the next frames would queue behind it.
    const wait = this.sharpMotion ? this.stillWait : Math.max(this.stillWait, STILL_SLOW_LINK_MS);
    this.stillTimer = setTimeout(() => void this.still().catch(() => undefined), wait);
    this.stillTimer.unref?.();
  }

  private show(data: string): void {
    this.frameB64 = data;
    this.bump();
    this.frameAt = this.version;
  }

  /** The picture has settled: the screencast restarts in its exact mode for one frame. */
  async still(): Promise<void> {
    this.stillTimer = null;
    if (this.ended || this.stillMode !== 'off') return;
    this.stillMode = 'waiting';
    await this.cast();
  }

  private dropHeld(): void {
    if (this.heldTimer) clearTimeout(this.heldTimer);
    this.heldTimer = null;
    this.heldExact = null;
  }

  /** Back to motion frames (input is coming, or the page changed after its still). */
  private toMotion(): void {
    if (this.stillMode === 'off') return;
    this.stillMode = 'off';
    this.dropHeld();
    void this.cast().catch(() => undefined);
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
        this.onFrame(String(params.data));
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
  /**
   * Wheel turns and pointer moves waiting to go (PM-730). Chrome takes ~25 ms to answer each one
   * and the viewer sends one every few ms, so replaying them one by one built a queue: the page
   * kept scrolling after the hand stopped. While one is on its way, the next ones merge here
   * (wheel deltas add up, the newest position wins) and go as one when it answers.
   */
  private motion: {
    move: Extract<StreamInput, { type: 'mouse' }> | null;
    wheel: Extract<StreamInput, { type: 'wheel' }> | null;
  } = { move: null, wheel: null };
  private motionRun: Promise<void> | null = null;
  /** The cursor under the pointer (PM-730): where to read it next, and when it was last read. */
  private cursorPoint: { x: number; y: number } | null = null;
  private cursorTimer: ReturnType<typeof setTimeout> | null = null;
  private cursorReadAt = 0;

  private queueMotion(
    e: Extract<StreamInput, { type: 'mouse' }> | Extract<StreamInput, { type: 'wheel' }>,
  ): void {
    if (e.type === 'mouse') this.motion.move = e;
    else {
      const w = this.motion.wheel;
      this.motion.wheel =
        w && w.modifiers === e.modifiers
          ? { ...e, deltaX: w.deltaX + e.deltaX, deltaY: w.deltaY + e.deltaY }
          : e;
    }
    this.motionRun ??= this.drainMotion();
  }

  private async drainMotion(): Promise<void> {
    // Runs once motionRun is set, and clears it in the same step as its last check: cleared
    // later, a move arriving in between found a drain that had already finished, and waited.
    await Promise.resolve();
    try {
      while (!this.ended && (this.motion.move || this.motion.wheel)) {
        const { move, wheel } = this.motion;
        this.motion = { move: null, wheel: null };
        if (move) {
          await this.dispatchMouse(move);
          this.noteCursor(move.x, move.y);
        }
        if (wheel)
          await this.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: wheel.x,
            y: wheel.y,
            deltaX: wheel.deltaX,
            deltaY: wheel.deltaY,
            modifiers: wheel.modifiers,
          });
      }
    } finally {
      this.motionRun = null;
    }
  }

  /** The pointer moved: read the cursor there, at most every CURSOR_EVERY_MS (the last always). */
  private noteCursor(x: number, y: number): void {
    this.cursorPoint = { x, y };
    if (this.cursorTimer) return;
    const due = Math.max(0, this.cursorReadAt + CURSOR_EVERY_MS - Date.now());
    this.cursorTimer = setTimeout(() => void this.readCursor(), due);
    this.cursorTimer.unref?.();
  }

  private async readCursor(): Promise<void> {
    const point = this.cursorPoint;
    this.cursorPoint = null;
    this.cursorReadAt = Date.now();
    try {
      if (!point || this.ended) return;
      const result = await this.send('Runtime.evaluate', {
        expression: cursorAt(point.x, point.y),
        returnByValue: true,
      });
      const cursor = streamCursor((result.result as { value?: unknown } | undefined)?.value);
      if (cursor !== (this.state.cursor ?? 'default')) {
        this.state = { ...this.state, cursor };
        this.bump();
      }
    } catch {
      // The page is navigating: the next move reads it again.
    } finally {
      this.cursorTimer = null;
      // A move during the read: read again once the interval is up.
      const next = this.cursorPoint as { x: number; y: number } | null;
      if (next && !this.ended) this.noteCursor(next.x, next.y);
    }
  }

  /** Waits until every merged move and wheel turn has gone (before a click or key, in order). */
  async settleMotion(): Promise<void> {
    while (this.motionRun) await this.motionRun.catch(() => undefined);
  }

  private dispatchMouse(e: Extract<StreamInput, { type: 'mouse' }>) {
    return this.send('Input.dispatchMouseEvent', {
      type: e.kind === 'down' ? 'mousePressed' : e.kind === 'up' ? 'mouseReleased' : 'mouseMoved',
      x: e.x,
      y: e.y,
      button: e.button,
      buttons: e.buttons,
      clickCount: e.clickCount,
      modifiers: e.modifiers,
    });
  }

  async input(events: StreamInput[]): Promise<{ editable: boolean | null }> {
    let clicked = false;
    // Changes the viewer makes are not the page changing on its own: the still comes promptly.
    // Clicks, keys and wheel turns switch the screencast back to motion frames first (the browser
    // runs commands in order); a hover alone keeps the still until the page really changes.
    this.stillWait = STILL_MS;
    if (events.some((e) => !(e.type === 'mouse' && e.kind === 'move'))) this.toMotion();
    for (const e of events) {
      if ((e.type === 'mouse' && e.kind === 'move') || e.type === 'wheel') {
        this.queueMotion(e);
        continue;
      }
      await this.settleMotion();
      if (e.type === 'mouse') {
        await this.dispatchMouse(e);
        if (e.kind === 'up') clicked = true;
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
  ): Promise<{
    version: number;
    frame: Buffer | null;
    mime: string;
    state: StreamState;
  } | null> {
    const stream = this.get(id);
    await stream.wait(after, waitMs, signal);
    if (stream.ended) throw new PreviewError(404, 'This preview has closed; open it again');
    if (stream.version <= after) return null;
    return {
      version: stream.version,
      frame: stream.frame,
      mime: stream.frameMime,
      state: stream.state,
    };
  }

  /** The pushed feed of one stream (PM-727). */
  feed(id: string, signal?: AbortSignal): ReadableStream<Uint8Array> {
    return this.get(id).feed(signal);
  }

  ack(id: string, body: unknown): void {
    const b = body as { version?: unknown; held?: unknown } | null;
    const v = b?.version;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      throw new PreviewError(400, 'Expected a frame version');
    this.get(id).ack(v, num(b?.held, 0, 10_000, 0));
  }

  async input(id: string, body: unknown) {
    const events = parseInput(body);
    const stream = this.get(id);
    return stream.ordered(parseSeq(body), () => stream.input(events));
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
