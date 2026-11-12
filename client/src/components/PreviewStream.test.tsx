// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { modifiersOf, streamPath, toStreamPoint } from './PreviewStream';

describe('streamed preview helpers', () => {
  it('maps a point on the shown image into the stream viewport', () => {
    const box = { left: 100, top: 50, width: 400, height: 300 };
    const size = { width: 800, height: 600 };
    expect(toStreamPoint(300, 200, box, size)).toEqual({ x: 400, y: 300 });
    expect(toStreamPoint(0, 0, box, size)).toEqual({ x: 0, y: 0 });
    expect(toStreamPoint(9999, 9999, box, size)).toEqual({ x: 800, y: 600 });
  });

  it('numbers modifiers as the DevTools protocol does', () => {
    const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(modifiersOf(none)).toBe(0);
    expect(modifiersOf({ ...none, ctrlKey: true, shiftKey: true })).toBe(10);
    expect(modifiersOf({ ...none, altKey: true, metaKey: true })).toBe(5);
  });

  it('reads the path of the page the browser is on', () => {
    expect(streamPath('http://127.0.0.1:3000/docs?a=1#b')).toBe('/docs?a=1#b');
    expect(streamPath('about:blank')).toBeNull();
    expect(streamPath('not a url')).toBeNull();
  });
});
