import { describe, expect, it } from 'vitest';
import type { PreviewCapture } from './previewCapture.js';
import { PreviewError } from './preview.js';
import {
  PreviewStreams,
  keyEvent,
  parseInput,
  parseOpen,
  parseSize,
  subframeAllowed,
} from './previewStream.js';

const blocked = new Set([5180, 5181]);

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
