import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cdp, PreviewCapture } from './previewCapture.js';
import { PreviewError } from './preview.js';
import {
  FEED_WINDOW,
  PreviewStreams,
  STILL_MS,
  STILL_SLOW_LINK_MS,
  Stream,
  feedEvent,
  imageMime,
  keyEvent,
  parseInput,
  parseOpen,
  parseSeq,
  parseSize,
  streamCursor,
  subframeAllowed,
} from './previewStream.js';

const blocked = new Set([5180, 5181]);

function fakeStream(
  send: (method: string, params?: unknown) => Promise<unknown> = async () => ({}),
): Stream {
  const cdp = { on() {}, send, close() {} } as unknown as Cdp;
  const open = { port: 3000, path: '/', width: 800, height: 600, scale: 1, dark: false };
  const state = {
    url: 'http://127.0.0.1:3000/',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    width: 800,
    height: 600,
  };
  return new Stream('s1', 3000, cdp, 't1', 'http://127.0.0.1:9', () => blocked, open, state);
}

/** A new picture, the way the screencast handler stores one. */
function paint(stream: Stream, image: string): void {
  stream.frameB64 = image;
  stream.bump();
  stream.frameAt = stream.version;
}

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  return data
    ? (JSON.parse(data.slice(6)) as { v: number; image: string | null; mime?: string })
    : text;
}

describe('pushed feed (PM-727)', () => {
  it('sends the current frame at once, then only new pictures, and never past the window', async () => {
    const stream = fakeStream();
    paint(stream, 'A');
    const reader = stream.feed().getReader();
    expect(await nextEvent(reader)).toMatchObject({ image: 'A' });
    // A state change alone sends no picture.
    stream.bump();
    expect(await nextEvent(reader)).toMatchObject({ image: null });
    for (let i = 0; i < FEED_WINDOW; i++) {
      paint(stream, `F${i}`);
      expect(await nextEvent(reader)).toMatchObject({ image: `F${i}` });
    }
    // The window is full: a new picture waits for an acknowledgement.
    paint(stream, 'late');
    const pending = nextEvent(reader);
    const raced = await Promise.race([
      pending,
      new Promise((r) => setTimeout(() => r('waiting'), 300)),
    ]);
    expect(raced).toBe('waiting');
    stream.ack(stream.version);
    expect(await pending).toMatchObject({ image: 'late' });
    await reader.cancel();
  });

  it('a newer feed ends the older one', async () => {
    const stream = fakeStream();
    const first = stream.feed().getReader();
    await first.read();
    stream.feed();
    stream.bump();
    expect((await first.read()).done).toBe(true);
  });

  it('writes server-sent events', () => {
    expect(feedEvent(7, fakeStream().state, 'QQ')).toMatch(
      /^event: frame\ndata: \{"v":7,"t":\d+,"state":\{.*\},"image":"QQ","mime":"image\/jpeg"\}\n\n$/,
    );
  });
});

describe('picture quality (PM-730)', () => {
  afterEach(() => vi.useRealTimers());

  it('tells the image type from its first bytes', () => {
    expect(imageMime('UklGRlYAAABXRUJQ')).toBe('image/webp');
    expect(imageMime('iVBORw0KGgo')).toBe('image/png');
    expect(imageMime('/9j/4AAQ')).toBe('image/jpeg');
  });

  it('drops a frame identical to the one before', () => {
    const stream = fakeStream();
    stream.onFrame('A');
    const version = stream.version;
    stream.onFrame('A');
    expect(stream.version).toBe(version);
    stream.onFrame('B');
    expect(stream.version).toBe(version + 1);
    stream.end();
  });

  it('restarts the screencast exact once the picture settles, and for motion when it moves', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const cdp = {
      on() {},
      send: async (method: string, params?: { quality?: number }) => {
        if (method === 'Page.startScreencast') starts.push(params?.quality ?? 0);
        return {};
      },
      close() {},
    } as unknown as Cdp;
    const open = { port: 3000, path: '/', width: 800, height: 600, scale: 1, dark: false };
    const stream = new Stream('s1', 3000, cdp, 't1', 'http://127.0.0.1:9', () => blocked, open, {
      ...fakeStream().state,
    });
    stream.onFrame('UklGRmotion');
    await vi.advanceTimersByTimeAsync(STILL_SLOW_LINK_MS + 10);
    // Settled: the screencast restarts in its exact mode, and its first frame is the still.
    expect(starts).toEqual([90]);
    stream.onFrame('UklGRstill');
    expect(stream.frameB64).toBe('UklGRstill');
    expect(stream.frame?.length).toBeGreaterThan(0);
    // A slow change (a blinking caret) keeps the exact mode.
    await vi.advanceTimersByTimeAsync(400);
    stream.onFrame('UklGRcaret');
    expect(starts).toEqual([90]);
    // A fast one means the page moves: motion frames again.
    await vi.advanceTimersByTimeAsync(50);
    stream.onFrame('UklGRmoving');
    await vi.advanceTimersByTimeAsync(0);
    expect(starts).toEqual([90, 70]);
    expect(stream.frameB64).toBe('UklGRmoving');
    stream.end();
  });

  it('never overlaps two screencast restarts, and keeps WebP when Chrome says one is active', async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    let active = false;
    const stream = fakeStream(async (method, params?: unknown) => {
      await new Promise((r) => setTimeout(r, 5));
      if (method === 'Page.stopScreencast') active = false;
      if (method === 'Page.startScreencast') {
        if (active) throw new Error('Screencast is already active');
        active = true;
        calls.push((params as { format: string }).format);
      }
      return {};
    });
    stream.onFrame('UklGRmotion');
    await vi.advanceTimersByTimeAsync(STILL_SLOW_LINK_MS + 1);
    // The still restart is on its way when a click asks for motion frames again.
    void stream.input(parseInput({ events: [{ type: 'key', kind: 'down', key: 'a' }] }));
    void stream.input(parseInput({ events: [{ type: 'key', kind: 'up', key: 'a' }] }));
    await vi.advanceTimersByTimeAsync(200);
    // The next restart (a still once the page settles again) still sends WebP.
    stream.onFrame('UklGRlater');
    await vi.advanceTimersByTimeAsync(STILL_SLOW_LINK_MS + 50);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((f) => f === 'webp')).toBe(true);
    stream.end();
  });

  it('over a fast link, the still comes sooner and is PNG', async () => {
    vi.useFakeTimers();
    const formats: string[] = [];
    const stream = fakeStream(async (method, params?: unknown) => {
      if (method === 'Page.startScreencast') formats.push((params as { format: string }).format);
      return {};
    });
    stream.measure(10, Date.now() + 10_000);
    await vi.advanceTimersByTimeAsync(0);
    formats.length = 0;
    stream.onFrame('UklGRmotion');
    await vi.advanceTimersByTimeAsync(STILL_MS + 10);
    expect(formats).toEqual(['png']);
    stream.end();
  });

  it('over a slow link, holds slow changes of the still to one every 2 s', async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    stream.onFrame('UklGRmotion');
    await vi.advanceTimersByTimeAsync(STILL_SLOW_LINK_MS + 10);
    stream.onFrame('UklGRstill');
    await vi.advanceTimersByTimeAsync(400);
    stream.onFrame('UklGRcaret1');
    await vi.advanceTimersByTimeAsync(400);
    stream.onFrame('UklGRcaret2');
    // Held: the still stays until its 2 s are up, then the newest change shows.
    expect(stream.frameB64).toBe('UklGRstill');
    await vi.advanceTimersByTimeAsync(1_300);
    expect(stream.frameB64).toBe('UklGRcaret2');
    stream.end();
  });

  it('shows the page cursor under the pointer, read at most every 100 ms', async () => {
    vi.useFakeTimers();
    const reads: string[] = [];
    const stream = fakeStream(async (method, params?: unknown) => {
      if (method !== 'Runtime.evaluate') return {};
      const expression = (params as { expression: string }).expression;
      reads.push(expression.slice(-12));
      return { result: { value: expression.includes('(500, 20)') ? 'pointer' : 'url(x)' } };
    });
    const move = (x: number) =>
      stream.input(parseInput({ events: [{ type: 'mouse', kind: 'move', x, y: 20 }] }));
    await move(10);
    await move(500);
    await vi.advanceTimersByTimeAsync(150);
    // At most one read now and one for the last position once the interval is up.
    expect(reads.length).toBeLessThanOrEqual(2);
    expect(reads.at(-1)).toContain('(500, 20)');
    expect(stream.state.cursor).toBe('pointer');
    const before = reads.length;
    // Moves within the interval wait; the last position is read once it is up.
    await move(20);
    await move(30);
    await vi.advanceTimersByTimeAsync(150);
    expect(reads.length).toBeLessThanOrEqual(before + 2);
    expect(reads.at(-1)).toContain('(30, 20)');
    // An image cursor (or anything unknown) shows the arrow.
    expect(stream.state.cursor).toBe('default');
    stream.end();
  });

  it('only passes plain cursor keywords on', () => {
    expect(streamCursor('pointer')).toBe('pointer');
    expect(streamCursor('url(evil.png)')).toBe('default');
    expect(streamCursor(42)).toBe('default');
  });

  it('goes back to motion frames before a click, not for a hover', async () => {
    vi.useFakeTimers();
    const starts: number[] = [];
    const stream = fakeStream(async (method) => {
      if (method === 'Page.startScreencast') starts.push(starts.length);
      return {};
    });
    stream.onFrame('UklGRmotion');
    await vi.advanceTimersByTimeAsync(STILL_SLOW_LINK_MS + 10);
    stream.onFrame('UklGRstill');
    const move = { type: 'mouse', kind: 'move', x: 1, y: 1 } as const;
    await stream.input(parseInput({ events: [move] }));
    expect(starts).toHaveLength(1);
    await stream.input(
      parseInput({
        events: [
          { ...move, kind: 'down' },
          { ...move, kind: 'up' },
        ],
      }),
    );
    expect(starts).toHaveLength(2);
    stream.end();
  });

  it('widens the window while frames arrive on time and narrows it when they queue', () => {
    const stream = fakeStream();
    let t = 1_000_000;
    for (let i = 0; i < 60; i++) stream.measure(300, (t += 40));
    const wide = stream.window;
    expect(wide).toBeGreaterThan(FEED_WINDOW + 3);
    stream.measure(600, (t += 400));
    expect(stream.window).toBeLessThan(wide);
    for (let i = 0; i < 20; i++) stream.measure(900, (t += 400));
    expect(stream.window).toBe(2);
  });
});

describe('ordered input (PM-727)', () => {
  afterEach(() => vi.useRealTimers());

  it('reads a sequence number', () => {
    expect(parseSeq({ seq: 3 })).toBe(3);
    expect(parseSeq({ seq: 0 })).toBeNull();
    expect(parseSeq({ seq: 1.5 })).toBeNull();
    expect(parseSeq({})).toBeNull();
  });

  it('runs posts in their numbered order, whatever order they arrive in', async () => {
    const stream = fakeStream();
    const ran: number[] = [];
    const work = (n: number) => async () => {
      await new Promise((r) => setTimeout(r, 5));
      ran.push(n);
    };
    await Promise.all([
      stream.ordered(3, work(3)),
      stream.ordered(2, work(2)),
      stream.ordered(1, work(1)),
    ]);
    expect(ran).toEqual([1, 2, 3]);
  });

  it('runs a post whose predecessor never arrives after a short wait', async () => {
    vi.useFakeTimers();
    const stream = fakeStream();
    const ran: number[] = [];
    await stream.ordered(1, async () => ran.push(1));
    const late = stream.ordered(3, async () => ran.push(3));
    await vi.advanceTimersByTimeAsync(500);
    expect(ran).toEqual([1]);
    await vi.advanceTimersByTimeAsync(600);
    await late;
    expect(ran).toEqual([1, 3]);
  });
});

describe('parseOpen', () => {
  it('keeps the port rules of the preview', () => {
    expect(() => parseOpen({ port: 5180 }, blocked)).toThrow(PreviewError);
    expect(() => parseOpen({ port: 80 }, blocked)).toThrow(PreviewError);
    expect(() => parseOpen({ port: 'x' }, blocked)).toThrow(PreviewError);
    expect(parseOpen({ port: 3000 }, blocked).port).toBe(3000);
  });

  it('only opens a path on the app', () => {
    expect(() => parseOpen({ port: 3000, path: '//evil.example/' }, blocked)).toThrow(PreviewError);
    expect(() => parseOpen({ port: 3000, path: 'http://evil.example/' }, blocked)).toThrow(
      PreviewError,
    );
    expect(parseOpen({ port: 3000, path: '/docs?a=1' }, blocked).path).toBe('/docs?a=1');
    expect(parseOpen({ port: 3000 }, blocked).path).toBe('/');
  });

  it('clamps the size and reads the theme', () => {
    expect(parseSize({ width: 10, height: 99999, scale: 9 })).toEqual({
      width: 200,
      height: 2560,
      scale: 2,
    });
    expect(parseSize({})).toEqual({ width: 1280, height: 800, scale: 1 });
    expect(parseOpen({ port: 3000, dark: true }, blocked).dark).toBe(true);
    expect(parseOpen({ port: 3000, dark: 'yes' }, blocked).dark).toBe(false);
  });
});

describe('parseInput', () => {
  it('refuses an empty or oversized batch and unknown events', () => {
    expect(() => parseInput({ events: [] })).toThrow(PreviewError);
    expect(() => parseInput(null)).toThrow(PreviewError);
    const many = Array.from({ length: 65 }, () => ({ type: 'text', text: 'a' }));
    expect(() => parseInput({ events: many })).toThrow(PreviewError);
    expect(() => parseInput({ events: [{ type: 'eval', code: '1' }] })).toThrow(PreviewError);
    expect(() => parseInput({ events: [{ type: 'key', kind: 'down', key: '' }] })).toThrow(
      PreviewError,
    );
    expect(() => parseInput({ events: [{ type: 'text', text: 'x'.repeat(10_001) }] })).toThrow(
      PreviewError,
    );
  });

  it('clamps coordinates and fills defaults', () => {
    const [move, wheel] = parseInput({
      events: [
        { type: 'mouse', kind: 'move', x: -5, y: 99999, button: 'weird' },
        { type: 'wheel', x: 10, y: 10, deltaY: 1e9 },
      ],
    });
    expect(move).toMatchObject({ x: 0, y: 4096, button: 'none', clickCount: 0 });
    expect(wheel).toMatchObject({ deltaX: 0, deltaY: 10_000 });
  });
});

describe('keyEvent', () => {
  const key = (k: string, modifiers = 0, kind: 'down' | 'up' = 'down') =>
    keyEvent({ type: 'key', kind, key: k, code: '', keyCode: 0, modifiers });

  it('names editing commands for shortcuts', () => {
    expect(key('a', 2)).toMatchObject({ type: 'rawKeyDown', commands: ['selectAll'] });
    expect(key('z', 2)).toMatchObject({ commands: ['undo'] });
    expect(key('Z', 2 | 8)).toMatchObject({ commands: ['redo'] });
    expect(key('a', 4)).toMatchObject({ commands: ['selectAll'] });
    expect(key('a', 2 | 1)).not.toHaveProperty('commands');
  });

  it('types Enter and characters, and sends nothing typed for other keys', () => {
    expect(key('Enter')).toMatchObject({ type: 'keyDown', text: '\r' });
    expect(key('x')).toMatchObject({ type: 'keyDown', text: 'x' });
    expect(key('Backspace')).toMatchObject({ type: 'rawKeyDown' });
    expect(key('Backspace')).not.toHaveProperty('text');
    expect(key('Enter', 0, 'up')).toMatchObject({ type: 'keyUp' });
  });
});

describe('subframeAllowed', () => {
  it('loads the web but never reserved loopback ports', () => {
    expect(subframeAllowed('https://www.youtube.com/embed/x', blocked)).toBe(true);
    expect(subframeAllowed('about:blank', blocked)).toBe(true);
    expect(subframeAllowed('http://127.0.0.1:5180/', blocked)).toBe(false);
    expect(subframeAllowed('http://localhost:5181/x', blocked)).toBe(false);
    expect(subframeAllowed('http://[::1]:5180/', blocked)).toBe(false);
    expect(subframeAllowed('http://p3000.localhost:5180/', blocked)).toBe(false);
    expect(subframeAllowed('http://127.0.0.1/', blocked)).toBe(false);
    expect(subframeAllowed('http://127.0.0.1:3001/', blocked)).toBe(true);
    expect(subframeAllowed('file:///C:/Windows/win.ini', blocked)).toBe(false);
    expect(subframeAllowed('chrome://settings', blocked)).toBe(false);
  });
});

describe('PreviewStreams', () => {
  it('gives the browser back when a stream fails to open', async () => {
    let holds = 0;
    const capture = {
      available: true,
      acquire: async () => {
        holds++;
        return 'http://127.0.0.1:1';
      },
      release: () => {
        holds--;
      },
    } as unknown as PreviewCapture;
    const streams = new PreviewStreams(capture, () => blocked);
    await expect(streams.open({ port: 3000 })).rejects.toMatchObject({ status: 502 });
    expect(holds).toBe(0);
    expect(streams.count).toBe(0);
  });

  it('refuses a bad request before touching the browser', async () => {
    let asked = false;
    const capture = {
      available: true,
      acquire: async () => {
        asked = true;
        return 'http://127.0.0.1:1';
      },
      release: () => undefined,
    } as unknown as PreviewCapture;
    const streams = new PreviewStreams(capture, () => blocked);
    await expect(streams.open({ port: 5180 })).rejects.toMatchObject({ status: 403 });
    expect(asked).toBe(false);
    await expect(streams.frame('nope', 0)).rejects.toMatchObject({ status: 404 });
  });
});
