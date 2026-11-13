import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Cdp, PreviewCapture } from './previewCapture.js';
import { PreviewError } from './preview.js';
import {
  FEED_WINDOW,
  PreviewStreams,
  Stream,
  feedEvent,
  keyEvent,
  parseInput,
  parseOpen,
  parseSeq,
  parseSize,
  subframeAllowed,
} from './previewStream.js';

const blocked = new Set([5180, 5181]);

function fakeStream(): Stream {
  const cdp = { on() {}, send: async () => ({}), close() {} } as unknown as Cdp;
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
function paint(stream: Stream, jpeg: string): void {
  stream.frameB64 = jpeg;
  stream.bump();
  stream.frameAt = stream.version;
}

async function nextEvent(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const { value } = await reader.read();
  const text = new TextDecoder().decode(value);
  const data = text.split('\n').find((l) => l.startsWith('data: '));
  return data ? (JSON.parse(data.slice(6)) as { v: number; jpeg: string | null }) : text;
}

describe('pushed feed (PM-727)', () => {
  it('sends the current frame at once, then only new pictures, and never past the window', async () => {
    const stream = fakeStream();
    paint(stream, 'A');
    const reader = stream.feed().getReader();
    expect(await nextEvent(reader)).toMatchObject({ jpeg: 'A' });
    // A state change alone sends no picture.
    stream.bump();
    expect(await nextEvent(reader)).toMatchObject({ jpeg: null });
    for (let i = 0; i < FEED_WINDOW; i++) {
      paint(stream, `F${i}`);
      expect(await nextEvent(reader)).toMatchObject({ jpeg: `F${i}` });
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
    expect(await pending).toMatchObject({ jpeg: 'late' });
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
      /^event: frame\ndata: \{"v":7,"t":\d+,"state":\{.*\},"jpeg":"QQ"\}\n\n$/,
    );
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
