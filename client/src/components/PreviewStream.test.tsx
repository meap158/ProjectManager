// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewStreamState } from '../../../shared/types';
import { api } from '../api';
import {
  InputQueue,
  PreviewStream,
  modifiersOf,
  parseFeed,
  streamPath,
  toStreamPoint,
} from './PreviewStream';

vi.mock('../api', () => ({
  api: {
    openPreviewStream: vi.fn(),
    previewStreamInput: vi.fn(),
    previewStreamNavigate: vi.fn(),
    resizePreviewStream: vi.fn(),
    closePreviewStream: vi.fn(),
    previewStreamAck: vi.fn(),
  },
}));

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

  it('splits frames off the pushed feed and keeps a partial event for later (PM-727)', () => {
    const state = { url: 'http://127.0.0.1:3000/' } as PreviewStreamState;
    const one = `event: frame\ndata: ${JSON.stringify({ v: 1, state, jpeg: 'AA' })}\n\n`;
    const two = `event: frame\r\ndata: ${JSON.stringify({ v: 2, state, jpeg: null })}\r\n\r\n`;
    const { frames, rest } = parseFeed(`${one}: still here\n\n${two}event: frame\ndata: {"v"`);
    expect(frames.map((f) => [f.v, f.jpeg])).toEqual([
      [1, 'AA'],
      [2, null],
    ]);
    expect(rest).toBe('event: frame\ndata: {"v"');
  });
});

describe('InputQueue (PM-727)', () => {
  afterEach(() => vi.useRealTimers());

  it('sends batches without waiting, numbered, and keeps only the newest focus answer', async () => {
    vi.useFakeTimers();
    const answers: ((v: { editable: boolean | null }) => void)[] = [];
    const send = vi.fn(
      (_id: string, _events: unknown[], _seq: number) =>
        new Promise<{ editable: boolean | null }>((resolve) => answers.push(resolve)),
    );
    const editable = vi.fn();
    const queue = new InputQueue(() => 's1', editable, send);
    queue.push({ type: 'key', kind: 'down', key: 'a' });
    await vi.advanceTimersByTimeAsync(20);
    queue.push({ type: 'key', kind: 'down', key: 'b' });
    await vi.advanceTimersByTimeAsync(20);
    // The second went out while the first was still on its way.
    expect(send.mock.calls.map(([, events, seq]) => [seq, events.length])).toEqual([
      [1, 1],
      [2, 1],
    ]);
    answers[1]?.({ editable: true });
    answers[0]?.({ editable: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(editable.mock.calls).toEqual([[true]]);
  });

  it('merges moves waiting to go and numbers a reopened stream from 1', async () => {
    vi.useFakeTimers();
    let id = 's1';
    const send = vi.fn((_id: string, _events: unknown[], _seq: number) =>
      Promise.resolve({ editable: null }),
    );
    const queue = new InputQueue(
      () => id,
      () => undefined,
      send,
    );
    queue.push({ type: 'mouse', kind: 'move', x: 1, y: 1 });
    queue.push({ type: 'mouse', kind: 'move', x: 2, y: 2 });
    await vi.advanceTimersByTimeAsync(20);
    expect(send.mock.calls[0]?.[1]).toEqual([{ type: 'mouse', kind: 'move', x: 2, y: 2 }]);
    id = 's2';
    queue.push({ type: 'key', kind: 'down', key: 'a' });
    await vi.advanceTimersByTimeAsync(20);
    const [sentTo, , seq] = send.mock.calls[1] ?? [];
    expect([sentTo, seq]).toEqual(['s2', 1]);
  });
});

describe('PreviewStream', () => {
  const state: PreviewStreamState = {
    url: 'http://127.0.0.1:3000/',
    title: 'App',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    width: 800,
    height: 600,
  };

  beforeEach(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    URL.createObjectURL = vi.fn(() => 'blob:frame');
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 400,
      height: 300,
      right: 400,
      bottom: 300,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    vi.mocked(api.openPreviewStream).mockResolvedValue({ id: 's1', state });
    vi.mocked(api.previewStreamInput).mockResolvedValue({ editable: false });
    vi.mocked(api.closePreviewStream).mockResolvedValue(undefined);
    vi.mocked(api.previewStreamAck).mockResolvedValue(undefined);
    // The pushed feed sends one frame, then stays open until the stream is left.
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: frame\ndata: ${JSON.stringify({ v: 3, t: 0, state, jpeg: 'AAAA' })}\n\n`,
              ),
            );
            init.signal?.addEventListener('abort', () =>
              controller.error(new DOMException('aborted', 'AbortError')),
            );
          },
        });
        return Promise.resolve({ ok: true, status: 200, body });
      }),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('shows frames, sends a tap as a click where it landed, and closes on unmount', async () => {
    const onLoaded = vi.fn();
    const view = render(
      <PreviewStream
        tabId="t1"
        target={{ port: 3000, path: '/' }}
        shown
        title="Preview of localhost:3000"
        control={() => undefined}
        onState={() => undefined}
        onLoaded={onLoaded}
      />,
    );
    await waitFor(() => expect(view.container.querySelector('img')).not.toBeNull());
    expect(view.container.querySelector('img')?.getAttribute('src')).toBe(
      'data:image/jpeg;base64,AAAA',
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe('/api/preview-stream/s1/feed');
    expect(onLoaded).toHaveBeenCalledWith('t1');
    // Shown, so acknowledged: the server may send the next frame.
    await waitFor(() => expect(api.previewStreamAck).toHaveBeenCalledWith('s1', 3));
    expect(api.openPreviewStream).toHaveBeenCalledWith(
      expect.objectContaining({ port: 3000, path: '/' }),
    );

    // A touch tap at (100, 75) on a 400x300 panel is (200, 150) in the 800x600 page.
    const panel = screen.getByRole('tabpanel');
    fireEvent.pointerDown(panel, { clientX: 100, clientY: 75, pointerType: 'touch' });
    fireEvent.pointerUp(panel, { clientX: 100, clientY: 75, pointerType: 'touch' });
    await waitFor(() => {
      const sent = vi.mocked(api.previewStreamInput).mock.calls.flatMap(([, events]) => events);
      expect(sent).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'mouse', kind: 'down', x: 200, y: 150, button: 'left' }),
          expect.objectContaining({ type: 'mouse', kind: 'up', x: 200, y: 150 }),
        ]),
      );
    });

    view.unmount();
    expect(api.closePreviewStream).toHaveBeenCalledWith('s1');
  });
});
