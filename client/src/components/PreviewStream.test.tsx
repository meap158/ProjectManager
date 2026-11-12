// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreviewStreamState } from '../../../shared/types';
import { api } from '../api';
import { PreviewStream, modifiersOf, streamPath, toStreamPoint } from './PreviewStream';

vi.mock('../api', () => ({
  api: {
    openPreviewStream: vi.fn(),
    previewStreamInput: vi.fn(),
    previewStreamNavigate: vi.fn(),
    resizePreviewStream: vi.fn(),
    closePreviewStream: vi.fn(),
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
    let served = false;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        if (!served) {
          served = true;
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: new Headers({
              'x-pm-version': '1',
              'x-pm-state': encodeURIComponent(JSON.stringify(state)),
            }),
            blob: () => Promise.resolve(new Blob(['jpeg'])),
          });
        }
        // The next poll waits until the stream is left.
        return new Promise((_, reject) =>
          init.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        );
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
    expect(onLoaded).toHaveBeenCalledWith('t1');
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
