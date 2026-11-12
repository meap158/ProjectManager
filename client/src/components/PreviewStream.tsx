import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { PreviewStreamState } from '../../../shared/types';
import { api } from '../api';
import type { PreviewTarget } from './previewTabs';

// Streamed preview (PM-693, docs/BUILT-IN-BROWSER.md). Off this computer the Preview shows a
// headless browser on this computer (server/previewStream.ts) instead of the read-only path mode,
// which cannot load most apps there. Frames arrive by long-poll as JPEG images; pointer, wheel and
// keyboard input go back as small JSON batches. Nothing of the app runs in this page: it is an
// image, so the app can never reach ProjectManager's origin.
//
// A tab that is not shown stops polling; the server closes a stream nobody polls for a while, and
// coming back reopens it on the page it was on.

export type StreamAction = 'back' | 'forward' | 'reload';

/** What the workspace can ask of a streamed tab: back, forward and reload act on its browser. */
export interface StreamControl {
  run(action: StreamAction): void;
}

/** Modifier bits as the DevTools protocol numbers them: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export function modifiersOf(e: {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}): number {
  return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
}

/** A point on the shown image, in the stream's CSS pixels. */
export function toStreamPoint(
  clientX: number,
  clientY: number,
  box: { left: number; top: number; width: number; height: number },
  size: { width: number; height: number },
): { x: number; y: number } {
  const x = ((clientX - box.left) / Math.max(1, box.width)) * size.width;
  const y = ((clientY - box.top) / Math.max(1, box.height)) * size.height;
  return {
    x: Math.round(Math.min(size.width, Math.max(0, x))),
    y: Math.round(Math.min(size.height, Math.max(0, y))),
  };
}

/** The path of a page address on this computer ("/docs?a=1"); null if it is not one. */
export function streamPath(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' ? `${u.pathname}${u.search}${u.hash}` : null;
  } catch {
    return null;
  }
}

const BUTTONS = ['left', 'middle', 'right'] as const;
/** A touch that moves this far is a scroll, not a tap. */
const TAP_SLOP = 8;
const MOVE_EVERY_MS = 50;

type Pending = Record<string, unknown> & { type: string; kind?: string };

/**
 * Sends input in order, one request at a time. Moves waiting to go are merged into the newest, so
 * a slow connection never builds a backlog of pointer positions.
 */
class InputQueue {
  private pending: Pending[] = [];
  private busy = false;
  constructor(
    private id: () => string | null,
    private onEditable: (editable: boolean) => void,
  ) {}

  push(event: Pending): void {
    const last = this.pending[this.pending.length - 1];
    if (
      event.type === 'mouse' &&
      event.kind === 'move' &&
      last?.type === 'mouse' &&
      last.kind === 'move'
    )
      this.pending[this.pending.length - 1] = event;
    else if (event.type === 'wheel' && last?.type === 'wheel')
      this.pending[this.pending.length - 1] = {
        ...event,
        deltaX: Number(last.deltaX) + Number(event.deltaX),
        deltaY: Number(last.deltaY) + Number(event.deltaY),
      };
    else this.pending.push(event);
    void this.flush();
  }

  private async flush(): Promise<void> {
    if (this.busy) return;
    const id = this.id();
    if (!id || this.pending.length === 0) return;
    this.busy = true;
    const batch = this.pending.splice(0, 64);
    try {
      const { editable } = await api.previewStreamInput(id, batch);
      if (editable !== null) this.onEditable(editable);
    } catch {
      // A closed stream reopens through the frame loop; input sent meanwhile is dropped.
    } finally {
      this.busy = false;
      if (this.pending.length) void this.flush();
    }
  }
}

const isDark = () => document.documentElement.dataset.theme === 'dark';

export function PreviewStream({
  tabId,
  target,
  shown,
  title,
  control,
  onState,
  onLoaded,
}: {
  tabId: string;
  target: PreviewTarget;
  /** The shown tab polls; the others wait. */
  shown: boolean;
  title: string;
  control: (tabId: string, control: StreamControl | null) => void;
  onState: (tabId: string, state: PreviewStreamState | null) => void;
  onLoaded: (tabId: string) => void;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<HTMLTextAreaElement>(null);
  const idRef = useRef<string | null>(null);
  const stateRef = useRef<PreviewStreamState | null>(null);
  /** The page to reopen on: where the stream last was, else the tab's own address. */
  const pathRef = useRef(target.path);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const touch = useRef<{
    x: number;
    y: number;
    lastY: number;
    lastX: number;
    moved: boolean;
  } | null>(null);
  const lastMove = useRef(0);
  const queue = useRef<InputQueue | null>(null);
  queue.current ??= new InputQueue(
    () => idRef.current,
    (editable) => {
      // On a touch screen the keyboard opens only for a text field; elsewhere keys always go.
      if (editable) keysRef.current?.focus({ preventScroll: true });
      else if (matchMedia('(pointer: coarse)').matches) keysRef.current?.blur();
    },
  );

  const report = (state: PreviewStreamState) => {
    // Every frame carries the state; only a change reaches the workspace (and re-renders it).
    const before = stateRef.current;
    if (before && JSON.stringify(before) === JSON.stringify(state)) return;
    stateRef.current = state;
    const path = streamPath(state.url);
    if (path) pathRef.current = path;
    onState(tabId, state);
  };

  // A new address typed for this tab (same port) navigates the open stream.
  useEffect(() => {
    const id = idRef.current;
    if (!id || target.path === pathRef.current) return;
    pathRef.current = target.path;
    void api.previewStreamNavigate(id, { action: 'go', path: target.path }).catch((e: Error) => {
      setError(e.message);
    });
  }, [target.path]);

  // Open, then poll frames while shown. Leaving (or hiding the tab) stops polling; unmounting
  // closes the stream.
  useEffect(() => {
    if (!shown) return;
    const box = boxRef.current;
    if (!box) return;
    const abort = new AbortController();
    let urlToRevoke: string | null = null;
    let loadedOnce = false;
    const run = async () => {
      setError(null);
      if (!idRef.current) {
        const opened = await api.openPreviewStream({
          port: target.port,
          path: pathRef.current,
          width: Math.max(200, Math.round(box.clientWidth)),
          height: Math.max(200, Math.round(box.clientHeight)),
          scale: Math.min(2, window.devicePixelRatio || 1),
          dark: isDark(),
        });
        if (abort.signal.aborted) {
          void api.closePreviewStream(opened.id).catch(() => undefined);
          return;
        }
        idRef.current = opened.id;
        report(opened.state);
      }
      let after = 0;
      while (!abort.signal.aborted && idRef.current) {
        const res = await fetch(`/api/preview-stream/${idRef.current}/frame?after=${after}`, {
          signal: abort.signal,
          cache: 'no-store',
        });
        if (res.status === 404) {
          // Closed for idleness or replaced by a newer stream: open again where it was.
          idRef.current = null;
          return run();
        }
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(data?.error ?? `The preview stopped (${res.status})`);
        }
        const version = Number(res.headers.get('x-pm-version'));
        if (Number.isFinite(version) && version > 0) after = version;
        const state = res.headers.get('x-pm-state');
        if (state) report(JSON.parse(decodeURIComponent(state)) as PreviewStreamState);
        if (res.status === 200) {
          const url = URL.createObjectURL(await res.blob());
          if (abort.signal.aborted) {
            URL.revokeObjectURL(url);
            return;
          }
          setImage(url);
          if (urlToRevoke) URL.revokeObjectURL(urlToRevoke);
          urlToRevoke = url;
          if (!loadedOnce) {
            loadedOnce = true;
            onLoaded(tabId);
          }
        }
      }
    };
    run().catch((e: Error) => {
      if (abort.signal.aborted) return;
      setError(e.message);
      onLoaded(tabId);
    });
    return () => {
      abort.abort();
      // The last frame stays on screen; its URL is freed when the next one replaces it.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown, attempt, target.port]);

  // Closing the tab closes its browser tab on this computer.
  useEffect(
    () => () => {
      const id = idRef.current;
      idRef.current = null;
      if (id) void api.closePreviewStream(id).catch(() => undefined);
      onState(tabId, null);
      control(tabId, null);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Back, forward and reload from the toolbar act on this tab's browser.
  useEffect(() => {
    control(tabId, {
      run: (action) => {
        const id = idRef.current;
        if (!id) {
          setAttempt((n) => n + 1);
          return;
        }
        void api.previewStreamNavigate(id, { action }).catch((e: Error) => setError(e.message));
      },
    });
  }, [control, tabId]);

  // The browser's viewport follows the panel's size and the app's theme.
  useEffect(() => {
    const box = boxRef.current;
    if (!box || !shown) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const send = () => {
      const id = idRef.current;
      const state = stateRef.current;
      const width = Math.round(box.clientWidth);
      const height = Math.round(box.clientHeight);
      if (!id || width < 50 || height < 50) return;
      if (state && Math.abs(state.width - width) < 4 && Math.abs(state.height - height) < 4) return;
      void api
        .resizePreviewStream(id, {
          width,
          height,
          scale: Math.min(2, window.devicePixelRatio || 1),
          dark: isDark(),
        })
        .catch(() => undefined);
    };
    const observer = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(send, 200);
    });
    observer.observe(box);
    const theme = new MutationObserver(() => {
      const id = idRef.current;
      const state = stateRef.current;
      if (!id || !state) return;
      void api
        .resizePreviewStream(id, {
          width: state.width,
          height: state.height,
          scale: Math.min(2, window.devicePixelRatio || 1),
          dark: isDark(),
        })
        .catch(() => undefined);
    });
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      theme.disconnect();
    };
  }, [shown]);

  // Wheel needs a non-passive listener to keep the page around it from scrolling.
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const onWheel = (e: WheelEvent) => {
      const state = stateRef.current;
      if (!state) return;
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? state.height : 1;
      const p = toStreamPoint(e.clientX, e.clientY, box.getBoundingClientRect(), state);
      queue.current!.push({
        type: 'wheel',
        ...p,
        deltaX: e.deltaX * unit,
        deltaY: e.deltaY * unit,
        modifiers: modifiersOf(e),
      });
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, []);

  type Pointer = Pick<
    PointerEvent,
    'clientX' | 'clientY' | 'button' | 'buttons' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'
  >;
  const mouse = (kind: 'down' | 'up' | 'move', e: Pointer, clickCount = 1) => {
    const state = stateRef.current;
    const box = boxRef.current;
    if (!state || !box) return;
    const p = toStreamPoint(e.clientX, e.clientY, box.getBoundingClientRect(), state);
    queue.current!.push({
      type: 'mouse',
      kind,
      ...p,
      button: kind === 'move' ? 'none' : (BUTTONS[e.button] ?? 'left'),
      buttons: e.buttons,
      clickCount: kind === 'move' ? 0 : clickCount,
      modifiers: modifiersOf(e),
    });
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.pointerType === 'mouse') {
      keysRef.current?.focus({ preventScroll: true });
      e.currentTarget.setPointerCapture(e.pointerId);
      mouse('down', e, e.detail || 1);
      return;
    }
    touch.current = {
      x: e.clientX,
      y: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') {
      const now = performance.now();
      if (now - lastMove.current < MOVE_EVERY_MS && e.buttons === 0) return;
      lastMove.current = now;
      mouse('move', e);
      return;
    }
    const t = touch.current;
    const state = stateRef.current;
    const box = boxRef.current;
    if (!t || !state || !box) return;
    if (!t.moved && Math.hypot(e.clientX - t.x, e.clientY - t.y) < TAP_SLOP) return;
    t.moved = true;
    // A finger drag scrolls the page under it, the way it would on the phone itself.
    const scale = state.height / Math.max(1, box.clientHeight);
    const p = toStreamPoint(t.x, t.y, box.getBoundingClientRect(), state);
    queue.current!.push({
      type: 'wheel',
      ...p,
      deltaX: (t.lastX - e.clientX) * scale,
      deltaY: (t.lastY - e.clientY) * scale,
      modifiers: 0,
    });
    t.lastX = e.clientX;
    t.lastY = e.clientY;
  };
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse') {
      mouse('up', e, e.detail || 1);
      return;
    }
    const t = touch.current;
    touch.current = null;
    if (!t || t.moved) return;
    // A tap is a left click where the finger was.
    const tap = {
      clientX: t.x,
      clientY: t.y,
      button: 0,
      buttons: 1,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    };
    mouse('move', tap);
    mouse('down', tap);
    mouse('up', { ...tap, buttons: 0 });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const modifiers = modifiersOf(e);
    const command = e.ctrlKey || e.metaKey;
    // Typed characters arrive through `input` (which also covers phone keyboards and IMEs).
    if (e.key.length === 1 && !command) return;
    if (e.key === 'Unidentified' || e.key === 'Process' || e.nativeEvent.isComposing) return;
    // Paste reads the clipboard here and sends the text.
    if (command && e.key.toLowerCase() === 'v') return;
    e.preventDefault();
    queue.current!.push({
      type: 'key',
      kind: 'down',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      modifiers,
    });
  };
  const onKeyUp = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key.length === 1 && !(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'Unidentified' || e.key === 'Process') return;
    queue.current!.push({
      type: 'key',
      kind: 'up',
      key: e.key,
      code: e.code,
      keyCode: e.keyCode,
      modifiers: modifiersOf(e),
    });
  };

  return (
    <div
      ref={boxRef}
      id={`preview-panel-${tabId}`}
      role="tabpanel"
      aria-labelledby={`preview-tab-${tabId}`}
      aria-label={title}
      className={`preview-frame preview-stream${shown ? '' : ' is-hidden'}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        touch.current = null;
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {image && <img className="preview-stream-image" src={image} alt="" draggable={false} />}
      <textarea
        ref={keysRef}
        className="preview-stream-keys"
        aria-label={`Type into ${title}`}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onInput={(e) => {
          const text = e.currentTarget.value;
          e.currentTarget.value = '';
          if (text) queue.current!.push({ type: 'text', text: text.replace(/\n/g, '') });
        }}
        onPaste={(e) => {
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain');
          if (text) queue.current!.push({ type: 'text', text: text.slice(0, 10_000) });
        }}
      />
      {error && (
        <div className="preview-stream-error" role="alert">
          <span>{error}</span>
          <button
            type="button"
            className="btn btn-sm"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => {
              idRef.current = null;
              setAttempt((n) => n + 1);
            }}
          >
            Try again
          </button>
        </div>
      )}
    </div>
  );
}
