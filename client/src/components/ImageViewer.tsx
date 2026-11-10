import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { mediaKind } from '../../../shared/media';
import type { FolderItem } from '../../../shared/types';
import { formatBytes } from '../format';
import { FileTypeIcon, iconFor } from './fileIcons';
import { CloseIcon, DownloadIcon } from './icons';
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
  const [viewport, setViewport] = useState({ w: 0, h: 0 });
  const fitted = natural ? fitImage(natural, viewport) : null;
  useEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => {
      const css = getComputedStyle(el);
      setViewport({
        w: Math.max(0, el.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight)),
        h: Math.max(
          0,
          el.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom),
        ),
      });
    };
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, []);
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
        style={{
          width: fitted?.w || undefined,
          height: fitted?.h || undefined,
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
        }}
        onLoad={(event) =>
          setNatural({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })
        }
      />
      <output className="iv-zoom" aria-live="polite">
        {fitted ? `${Math.round(fitted.ratio * scale * 100)}%` : 'Fit'}
        {natural ? ` · ${natural.w} × ${natural.h}` : ''}
      </output>
    </div>
  );
}

const pinchDistance = (pointers: Map<number, Point>): number => {
  const [a, b] = [...pointers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
};

/** The unzoomed picture fits inside the usable stage, preserving aspect ratio and native size. */
export function fitImage(natural: { w: number; h: number }, viewport: { w: number; h: number }) {
  const ratio =
    natural.w > 0 && natural.h > 0
      ? Math.min(viewport.w / natural.w, viewport.h / natural.h, 1)
      : 0;
  return { w: natural.w * ratio, h: natural.h * ratio, ratio };
}

/** The scale at which the picture is shown at its own pixel size, relative to "fit". */
function fitFor(natural: { w: number; h: number }, stage: HTMLElement): number {
  const css = getComputedStyle(stage);
  const fit = fitImage(natural, {
    w: stage.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight),
    h: stage.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom),
  }).ratio;
  return fit > 0 ? clamp(1 / fit) : 1;
}

/** One filmstrip picture, or the file's type icon when it has none or it fails to load. */
function StripThumb({ item, src }: { item: FolderItem; src: string | null }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (!src || failed === src) return <FileTypeIcon spec={iconFor(item)} size={22} />;
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      decoding="async"
      draggable={false}
      onError={() => setFailed(src)}
    />
  );
}

/**
 * The folder lightbox (PM-286, every file type since PM-652). Pictures get the zoom and pan
 * stage; other files show through `renderFile` (the player for video and audio, rendered
 * markdown and HTML, source for code) on a plain stage where clicks, text selection and the
 * player's own controls work as usual. Arrows, chevrons, the filmstrip, Info, Copy path,
 * Download and the focus trap are the same for every kind.
 */
export function ImageViewer({
  items,
  index,
  rawUrl,
  onIndex,
  onClose,
  thumbFor = (item) => rawUrl(item.path),
  isPicture = () => true,
  renderFile,
  onOpenFile,
  downloadUrl,
}: {
  items: readonly FolderItem[];
  index: number;
  rawUrl: (path: string) => string;
  onIndex: (index: number) => void;
  onClose: () => void;
  /** The filmstrip picture for an entry, or null for its type icon. */
  thumbFor?: (item: FolderItem) => string | null;
  /** Whether an entry is a picture for the zoom stage; others go to `renderFile`. */
  isPicture?: (item: FolderItem) => boolean;
  renderFile?: (item: FolderItem) => ReactNode;
  /** Opens the entry in the full file view. */
  onOpenFile?: (path: string) => void;
  downloadUrl?: (path: string) => string;
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

  // Measure within the strip, independent of its offset parent. Recenter before paint
  // as the bounded window moves, and when resizing changes the strip width.
  useLayoutEffect(() => {
    const bar = strip.current;
    if (!bar) return;
    const reveal = () => {
      const current = bar.querySelector<HTMLElement>('[aria-current="true"]');
      if (!current) return;
      const bounds = bar.getBoundingClientRect();
      const selected = current.getBoundingClientRect();
      bar.scrollLeft = Math.max(
        0,
        bar.scrollLeft + selected.left + selected.width / 2 - bounds.left - bounds.width / 2,
      );
    };
    reveal();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(reveal);
    observer?.observe(bar);
    window.addEventListener('resize', reveal);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', reveal);
    };
  }, [index, item?.path, items.length]);

  if (!item) return null;
  const picture = !renderFile || isPicture(item);
  const media = mediaKind(item.name);
  // Keep the filmstrip bounded even for project-wide collections with thousands of files.
  const stripStart = Math.max(0, Math.min(index - 20, items.length - 41));
  const step = (by: 1 | -1) => onIndex((index + by + items.length) % items.length);
  const zoom = (detail: 'in' | 'out' | 'fit' | 'actual') =>
    dialog.current
      ?.querySelector('.iv-stage')
      ?.dispatchEvent(new CustomEvent('pm-zoom', { detail }));
  const player = () =>
    dialog.current?.querySelector<HTMLMediaElement>('.iv-panel video, .iv-panel audio') ?? null;

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    // A focused player keeps its own keys (arrows seek, space plays); so do text fields.
    const ownKeys = target.closest('video, audio, input, textarea, select') !== null;
    switch (event.key) {
      case 'Escape':
        onClose();
        break;
      case 'ArrowLeft':
        if (ownKeys) return;
        step(-1);
        break;
      case 'ArrowRight':
        if (ownKeys) return;
        step(1);
        break;
      case '+':
      case '=':
        if (!picture) return;
        zoom('in');
        break;
      case '-':
        if (!picture) return;
        zoom('out');
        break;
      case '0':
        if (!picture) return;
        zoom('fit');
        break;
      case '1':
        if (!picture) return;
        zoom('actual');
        break;
      case ' ': {
        // Space plays and pauses the video or audio when nothing else has focus.
        const playing = player();
        if (!playing || target !== dialog.current) return;
        if (playing.paused) void playing.play().catch(() => undefined);
        else playing.pause();
        break;
      }
      case 'i':
      case 'I':
        if (ownKeys) return;
        setInfo((v) => !v);
        break;
      case 'Tab': {
        // Keep Tab inside the dialog.
        const focusable = [
          ...(dialog.current?.querySelectorAll<HTMLElement>(
            'button, [href], video, audio, iframe, [tabindex]:not([tabindex="-1"])',
          ) ?? []),
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
      aria-label={`${picture ? 'Image' : 'File'} ${index + 1} of ${items.length}: ${item.name}`}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {picture ? (
        <Stage
          key={item.path}
          src={rawUrl(item.path)}
          name={item.name}
          onSwipe={step}
          onDismiss={onClose}
        />
      ) : (
        <div
          className="iv-stage iv-plain"
          onClick={(event) => {
            if (event.target === event.currentTarget) onClose();
          }}
        >
          <div key={item.path} className={`iv-panel${media ? ' iv-panel-media' : ''}`}>
            {renderFile?.(item)}
          </div>
        </div>
      )}
      <div className="iv-tools" role="toolbar" aria-label="Viewer tools">
        {picture && (
          <>
            <button
              type="button"
              className="iv-btn"
              aria-label="Zoom out"
              onClick={() => zoom('out')}
            >
              −
            </button>
            <button
              type="button"
              className="iv-btn"
              aria-label="Zoom in"
              onClick={() => zoom('in')}
            >
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
          </>
        )}
        {onOpenFile && (
          <button
            type="button"
            className="iv-btn iv-text"
            onClick={() => onOpenFile(item.path)}
            title="Open in the file view"
          >
            Open
          </button>
        )}
        {/* Video and audio carry Download on the player itself (it saves the loaded copy). */}
        {downloadUrl && !media && (
          <a
            className="iv-btn"
            href={downloadUrl(item.path)}
            download={item.name}
            aria-label={`Download ${item.name}`}
            title="Download"
          >
            <DownloadIcon size={16} />
          </a>
        )}
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
            aria-label="Previous file"
            onClick={() => step(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="iv-nav iv-next"
            aria-label="Next file"
            onClick={() => step(1)}
          >
            ›
          </button>
        </>
      )}
      {info && (
        <aside className="iv-info" aria-label="File details">
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
          <div className="iv-strip" ref={strip} role="listbox" aria-label="Files in this folder">
            {items.slice(stripStart, stripStart + 41).map((entry, at) => (
              <button
                key={entry.path}
                type="button"
                role="option"
                aria-posinset={at + stripStart + 1}
                aria-setsize={items.length}
                aria-selected={at + stripStart === index}
                aria-current={at + stripStart === index ? 'true' : undefined}
                aria-label={entry.name}
                className="iv-thumb"
                onClick={() => onIndex(at + stripStart)}
              >
                <StripThumb item={entry} src={thumbFor(entry)} />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
