import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import type { FolderItem } from '../../../shared/types';
import { formatBytes } from '../format';
import { CloseIcon } from './icons';
import './image-viewer.css';

// The folder previewer's image viewer (PM-286): a lightbox, like TrendRelay's. The page stays behind a
// dimmed backdrop and the picture sits centred on it with almost no chrome: a small tool cluster,
// chevrons only when there is more than one picture, a caption and a filmstrip. Clicking the
// backdrop (or Escape) closes it; clicking the picture does not. Zoom and pan (wheel, pinch, drag,
// double tap), swipe to change picture, an info card, a focus trap that gives focus back when it
// closes. Keys: arrows, + - 0 1, i, Escape.

const MIN = 0.1;
const MAX = 8;
const SWIPE_PX = 60;

const clamp = (value: number) => Math.min(MAX, Math.max(MIN, value));
export const nextZoom = (scale: number, direction: 1 | -1) =>
  clamp(scale * (direction > 0 ? 1.25 : 0.8));

interface Point {
  x: number;
  y: number;
}

function Stage({
  src,
  name,
  onSwipe,
  onDismiss,
}: {
  src: string;
  name: string;
  onSwipe: (step: 1 | -1) => void;
  /** A tap on the dark around the picture. */
  onDismiss: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<Point>({ x: 0, y: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<{ start: Point; origin: Point; pinch: number; scale: number } | null>(
    null,
  );

  // A non-passive wheel listener: the page must not scroll while the picture zooms.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      setScale((s) => clamp(s * (event.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Zoom and pan are driven from the dialog's keys (see ImageViewer) through this element.
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const onZoom = (event: Event) => {
      const detail = (event as CustomEvent<'in' | 'out' | 'fit' | 'actual'>).detail;
      if (detail === 'in') setScale((s) => nextZoom(s, 1));
      else if (detail === 'out') setScale((s) => nextZoom(s, -1));
      else {
        setOffset({ x: 0, y: 0 });
        setScale(
          detail === 'fit' ? 1 : natural && stage.current ? fitFor(natural, stage.current) : 1,
        );
      }
    };
    el.addEventListener('pm-zoom', onZoom);
    return () => el.removeEventListener('pm-zoom', onZoom);
  }, [natural]);

  const down = (event: ReactPointerEvent) => {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    gesture.current = {
      start: { x: event.clientX, y: event.clientY },
      origin: offset,
      pinch: pinchDistance(pointers.current),
      scale,
    };
  };
  const move = (event: ReactPointerEvent) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const g = gesture.current;
    if (pointers.current.size >= 2 && g.pinch > 0) {
      setScale(clamp((g.scale * pinchDistance(pointers.current)) / g.pinch));
    } else if (scale > 1.001) {
      setOffset({
        x: g.origin.x + event.clientX - g.start.x,
        y: g.origin.y + event.clientY - g.start.y,
      });
    }
  };
  const up = (event: ReactPointerEvent) => {
    const g = gesture.current;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size === 0 && g) {
      const dx = event.clientX - g.start.x;
      const dy = event.clientY - g.start.y;
      // A swipe changes the picture only at fit size (when zoomed, dragging pans).
      if (
        scale <= 1.001 &&
        g.pinch === 0 &&
        Math.abs(dx) > SWIPE_PX &&
        Math.abs(dx) > Math.abs(dy) * 1.5
      )
        onSwipe(dx < 0 ? 1 : -1);
      else if (event.target === event.currentTarget && Math.abs(dx) < 6 && Math.abs(dy) < 6)
        onDismiss();
      gesture.current = null;
    }
  };

  return (
    <div
      ref={stage}
      className="iv-stage"
      data-zoomed={scale > 1.001 || undefined}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onDoubleClick={() => {
        setOffset({ x: 0, y: 0 });
        setScale((s) => (s > 1.001 ? 1 : 2));
      }}
    >
      <img
        className="iv-image"
        src={src}
        alt={name}
        draggable={false}
        decoding="async"
        style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
        onLoad={(event) =>
          setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })
        }
      />
      <output className="iv-zoom" aria-live="polite">
        {Math.round(scale * 100)}%{natural ? ` · ${natural.w} × ${natural.h}` : ''}
      </output>
    </div>
  );
}

const pinchDistance = (pointers: Map<number, Point>): number => {
  const [a, b] = [...pointers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
};

/** The scale at which the picture is shown at its own pixel size, relative to "fit". */
function fitFor(natural: { w: number; h: number }, stage: HTMLElement): number {
  const fit = Math.min(stage.clientWidth / natural.w, stage.clientHeight / natural.h, 1);
  return fit > 0 ? clamp(1 / fit) : 1;
}

export function ImageViewer({
  items,
  index,
  rawUrl,
  onIndex,
  onClose,
}: {
  items: readonly FolderItem[];
  index: number;
  rawUrl: (path: string) => string;
  onIndex: (index: number) => void;
  onClose: () => void;
}) {
  const item = items[index];
  const [info, setInfo] = useState(false);
  const [copied, setCopied] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(null);

  // Focus moves into the dialog and comes back to what opened it.
  useEffect(() => {
    opener.current = document.activeElement;
    dialog.current?.focus({ preventScroll: true });
    const previous = opener.current;
    return () => (previous as HTMLElement | null)?.focus?.({ preventScroll: true });
  }, []);

  // The filmstrip keeps the current picture in view.
  useEffect(() => {
    const bar = strip.current;
    const current = bar?.querySelector<HTMLElement>('[aria-current="true"]');
    // The strip's own scroller only (scrollIntoView would also move the page behind the viewer).
    if (bar && current)
      bar.scrollLeft = current.offsetLeft - bar.clientWidth / 2 + current.offsetWidth / 2;
  }, [index]);

  if (!item) return null;
  const step = (by: 1 | -1) => onIndex((index + by + items.length) % items.length);
  const zoom = (detail: 'in' | 'out' | 'fit' | 'actual') =>
    dialog.current
      ?.querySelector('.iv-stage')
      ?.dispatchEvent(new CustomEvent('pm-zoom', { detail }));

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    switch (event.key) {
      case 'Escape':
        onClose();
        break;
      case 'ArrowLeft':
        step(-1);
        break;
      case 'ArrowRight':
        step(1);
        break;
      case '+':
      case '=':
        zoom('in');
        break;
      case '-':
        zoom('out');
        break;
      case '0':
        zoom('fit');
        break;
      case '1':
        zoom('actual');
        break;
      case 'i':
      case 'I':
        setInfo((v) => !v);
        break;
      case 'Tab': {
        // Keep Tab inside the dialog.
        const focusable = [
          ...(dialog.current?.querySelectorAll<HTMLElement>('button, [href]') ?? []),
        ];
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === dialog.current) {
          last?.focus();
          break;
        }
        if (!event.shiftKey && document.activeElement === last) {
          first?.focus();
          break;
        }
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
  };

  return createPortal(
    <div
      ref={dialog}
      className="iv"
      role="dialog"
      aria-modal="true"
      aria-label={`Image ${index + 1} of ${items.length}: ${item.name}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <Stage
        key={item.path}
        src={rawUrl(item.path)}
        name={item.name}
        onSwipe={step}
        onDismiss={onClose}
      />
      <div className="iv-tools" role="toolbar" aria-label="Viewer tools">
        <button type="button" className="iv-btn" aria-label="Zoom out" onClick={() => zoom('out')}>
          −
        </button>
        <button type="button" className="iv-btn" aria-label="Zoom in" onClick={() => zoom('in')}>
          +
        </button>
        <button
          type="button"
          className="iv-btn iv-text"
          onClick={() => zoom('fit')}
          title="Fit to window (0)"
        >
          Fit
        </button>
        <button
          type="button"
          className="iv-btn iv-text"
          onClick={() => zoom('actual')}
          title="Actual size (1)"
        >
          100%
        </button>
        <button
          type="button"
          className="iv-btn iv-text"
          aria-pressed={info}
          onClick={() => setInfo((v) => !v)}
          title="Details (i)"
        >
          Info
        </button>
        <button type="button" className="iv-btn" aria-label="Close viewer" onClick={onClose}>
          <CloseIcon size={16} />
        </button>
      </div>
      {items.length > 1 && (
        <>
          <button
            type="button"
            className="iv-nav iv-prev"
            aria-label="Previous picture"
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="iv-nav iv-next"
            aria-label="Next picture"
            onClick={() => step(1)}
          >
            ›
          </button>
        </>
      )}
      {info && (
        <aside className="iv-info" aria-label="Picture details">
          <dl>
            <dt>Name</dt>
            <dd>{item.name}</dd>
            <dt>Path</dt>
            <dd className="iv-wrap">{item.path}</dd>
            <dt>Size</dt>
            <dd>{item.size === null ? '–' : formatBytes(item.size)}</dd>
            <dt>Modified</dt>
            <dd>{item.mtime ? new Date(item.mtime).toLocaleString() : '–'}</dd>
            <dt>Created</dt>
            <dd>{item.ctime ? new Date(item.ctime).toLocaleString() : '–'}</dd>
          </dl>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void navigator.clipboard?.writeText(item.path).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? 'Copied' : 'Copy path'}
          </button>
        </aside>
      )}
      <div className="iv-foot">
        <span className="iv-caption truncate" title={item.path}>
          {item.name}
          <span className="num">
            {' '}
            · {index + 1} / {items.length}
          </span>
        </span>
        {items.length > 1 && (
          <div className="iv-strip" ref={strip} role="listbox" aria-label="Pictures in this folder">
            {items.map((entry, i) => (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-selected={i === index}
                aria-current={i === index ? 'true' : undefined}
                aria-label={entry.name}
                className="iv-thumb"
                onClick={() => onIndex(i)}
              >
                {Math.abs(i - index) <= 40 && (
                  <img
                    src={rawUrl(entry.path)}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    draggable={false}
                  />
                )}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
