import { useEffect, useRef, useState, type PointerEvent, type ReactNode } from 'react';

// Drawing marks for the Preview picker (PM-311), shared by the live page (a layer over the frame,
// as in the Claude app) and the screenshot in the send dialog: pen, box and text in a few colours,
// with undo. Shapes are kept in the layer's own coordinates (CSS pixels of the page for the live
// layer, image pixels for the screenshot), so marks carry from one to the other by a scale.

export type Point = { x: number; y: number };
export type Shape =
  | { kind: 'box'; color: string; from: Point; to: Point }
  | { kind: 'pen'; color: string; points: Point[] }
  | { kind: 'text'; color: string; at: Point; text: string };
export type MarkupTool = 'select' | 'pen' | 'box' | 'text';

export const MARK_COLORS = ['#ff4d4f', '#ffb020', '#4c8dff', '#2ecc71'] as const;
const COLOR_NAMES: Record<string, string> = {
  '#ff4d4f': 'Red',
  '#ffb020': 'Amber',
  '#4c8dff': 'Blue',
  '#2ecc71': 'Green',
};

/** Shapes moved into another coordinate space (page CSS pixels to image pixels, say). */
export function scaleShapes(shapes: Shape[], k: number): Shape[] {
  if (k === 1) return shapes;
  const p = (q: Point) => ({ x: Math.round(q.x * k), y: Math.round(q.y * k) });
  return shapes.map((s) =>
    s.kind === 'box'
      ? { ...s, from: p(s.from), to: p(s.to) }
      : s.kind === 'pen'
        ? { ...s, points: s.points.map(p) }
        : { ...s, at: p(s.at) },
  );
}

/** Draws the shapes (over an image, when given) in a w × h space. */
export function paint(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource | null,
  shapes: Shape[],
  w: number,
  h: number,
) {
  ctx.clearRect(0, 0, w, h);
  if (image) ctx.drawImage(image, 0, 0, w, h);
  const line = Math.max(2, Math.round(w / 400));
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  for (const s of shapes) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = line;
    if (s.kind === 'box') {
      ctx.strokeRect(
        Math.min(s.from.x, s.to.x),
        Math.min(s.from.y, s.to.y),
        Math.abs(s.to.x - s.from.x),
        Math.abs(s.to.y - s.from.y),
      );
    } else if (s.kind === 'pen') {
      ctx.beginPath();
      s.points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.stroke();
    } else {
      const size = textSize(w);
      ctx.font = textFont(size);
      // From the top, so the text lands where its box was typed in.
      ctx.textBaseline = 'top';
      ctx.lineWidth = Math.max(3, size / 5);
      ctx.strokeStyle = 'rgba(0,0,0,.65)';
      ctx.strokeText(s.text, s.at.x, s.at.y);
      ctx.fillText(s.text, s.at.x, s.at.y);
    }
  }
}

/** Text marks' size in layer units: readable on a small page, in step with a large one. */
export const textSize = (w: number) => Math.max(14, Math.round(w / 55));
const textFont = (size: number) => `600 ${size}px system-ui, sans-serif`;

let measurer: CanvasRenderingContext2D | null | undefined;
/** Where a text mark sits, in layer units (for picking it up to move or edit). */
export function textBounds(s: Extract<Shape, { kind: 'text' }>, w: number) {
  const size = textSize(w);
  measurer ??=
    typeof document !== 'undefined' ? document.createElement('canvas').getContext('2d') : null;
  let width = s.text.length * size * 0.6;
  if (measurer) {
    measurer.font = textFont(size);
    width = measurer.measureText(s.text).width;
  }
  return { x: s.at.x, y: s.at.y, width, height: size * 1.25 };
}

/**
 * A canvas that draws shapes in a w × h space and lets the owner add more with the current tool.
 * With the select tool it takes no pointer events, so what is under it (the page) gets them.
 */
export function MarkupLayer({
  width,
  height,
  pixelRatio = 1,
  image = null,
  shapes,
  onShapes,
  tool,
  color,
  className,
  label,
}: {
  width: number;
  height: number;
  /** Canvas pixels per unit, for a sharp layer on high-density screens. */
  pixelRatio?: number;
  image?: HTMLImageElement | null;
  shapes: Shape[];
  onShapes: (next: Shape[]) => void;
  tool: MarkupTool;
  color: string;
  className: string;
  label: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  // The text box: a new mark, or an existing one (index) being edited in place. `scale` is screen
  // pixels per layer unit, so the box shows the text at the size it will be drawn.
  const [typing, setTyping] = useState<{
    at: Point;
    screen: Point;
    scale: number;
    color: string;
    index: number | null;
  } | null>(null);
  const [text, setText] = useState('');
  /** Esc was pressed: the blur that follows closes the box without keeping the text. */
  const cancelled = useRef(false);
  // A press on an existing text mark: a drag moves it, a plain click edits it.
  const [moving, setMoving] = useState<{
    index: number;
    from: Point;
    origin: Point;
    at: Point;
    moved: boolean;
  } | null>(null);
  const [overText, setOverText] = useState(false);
  const commit = () => {
    if (typing && !cancelled.current) {
      const value = text.trim();
      if (typing.index !== null) {
        // Editing: the new words, or the mark removed when they were all deleted.
        onShapes(
          value
            ? shapes.map((sh, i) => (i === typing.index ? ({ ...sh, text: value } as Shape) : sh))
            : shapes.filter((_, i) => i !== typing.index),
        );
      } else if (value) {
        onShapes([...shapes, { kind: 'text', color: typing.color, at: typing.at, text: value }]);
      }
    }
    cancelled.current = false;
    setTyping(null);
  };
  /** The text mark under a point, topmost first. */
  const textAt = (p: Point) => {
    for (let i = shapes.length - 1; i >= 0; i--) {
      const sh = shapes[i]!;
      if (sh.kind !== 'text') continue;
      const b = textBounds(sh, width);
      if (p.x >= b.x - 4 && p.x <= b.x + b.width + 4 && p.y >= b.y - 4 && p.y <= b.y + b.height + 4)
        return i;
    }
    return -1;
  };

  useEffect(() => {
    const c = canvas.current;
    if (!c || width <= 0 || height <= 0) return;
    c.width = Math.round(width * pixelRatio);
    c.height = Math.round(height * pixelRatio);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    // A mark being edited is shown by its box instead; one being moved, where it is now.
    const shown = shapes
      .map((sh, i) =>
        moving && i === moving.index && sh.kind === 'text' ? { ...sh, at: moving.at } : sh,
      )
      .filter((_, i) => !(typing && typing.index === i));
    paint(ctx, image, draft ? [...shown, draft] : shown, width, height);
  });

  const at = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * width),
      y: Math.round(((e.clientY - r.top) / r.height) * height),
    };
  };
  const drawing = tool !== 'select';

  return (
    <>
      <canvas
        ref={canvas}
        className={className}
        aria-label={label}
        style={{
          pointerEvents: drawing ? 'auto' : 'none',
          cursor: !drawing
            ? ''
            : tool !== 'text'
              ? 'crosshair'
              : moving || overText
                ? 'move'
                : 'text',
        }}
        onPointerDown={(e) => {
          if (!drawing) return;
          const p = at(e);
          if (tool === 'text') {
            // Keep the press from moving focus: the text box it opens would lose focus at once
            // and close before anything could be typed (PM-329).
            e.preventDefault();
            const hit = textAt(p);
            if (hit >= 0) {
              const sh = shapes[hit] as Extract<Shape, { kind: 'text' }>;
              e.currentTarget.setPointerCapture(e.pointerId);
              setMoving({ index: hit, from: p, origin: sh.at, at: sh.at, moved: false });
              return;
            }
            const r = e.currentTarget.getBoundingClientRect();
            cancelled.current = false;
            setTyping({
              at: p,
              screen: { x: e.clientX - r.left, y: e.clientY - r.top },
              scale: r.width / width,
              color,
              index: null,
            });
            setText('');
            return;
          }
          e.currentTarget.setPointerCapture(e.pointerId);
          setDraft(
            tool === 'box'
              ? { kind: 'box', color, from: p, to: p }
              : { kind: 'pen', color, points: [p] },
          );
        }}
        onPointerMove={(e) => {
          if (tool === 'text' && !moving) setOverText(textAt(at(e)) >= 0);
          if (moving) {
            const p = at(e);
            const dx = p.x - moving.from.x;
            const dy = p.y - moving.from.y;
            const moved = moving.moved || Math.abs(dx) > 3 || Math.abs(dy) > 3;
            setMoving({
              ...moving,
              moved,
              at: moved ? { x: moving.origin.x + dx, y: moving.origin.y + dy } : moving.origin,
            });
            return;
          }
          if (!draft) return;
          const p = at(e);
          setDraft(
            draft.kind === 'box'
              ? { ...draft, to: p }
              : draft.kind === 'pen'
                ? { ...draft, points: [...draft.points, p] }
                : draft,
          );
        }}
        onPointerUp={(e) => {
          if (moving) {
            const m = moving;
            setMoving(null);
            if (m.moved) {
              onShapes(
                shapes.map((sh, i) => (i === m.index ? ({ ...sh, at: m.at } as Shape) : sh)),
              );
              return;
            }
            // A click on a text mark edits it in place.
            const sh = shapes[m.index] as Extract<Shape, { kind: 'text' }>;
            const r = e.currentTarget.getBoundingClientRect();
            const scale = r.width / width;
            cancelled.current = false;
            setTyping({
              at: sh.at,
              screen: { x: sh.at.x * scale, y: sh.at.y * scale },
              scale,
              color: sh.color,
              index: m.index,
            });
            setText(sh.text);
            return;
          }
          if (!draft) return;
          const tiny =
            draft.kind === 'box' &&
            Math.abs(draft.to.x - draft.from.x) < 4 &&
            Math.abs(draft.to.y - draft.from.y) < 4;
          if (!tiny) onShapes([...shapes, draft]);
          setDraft(null);
        }}
      />
      {typing && (
        <input
          className="shot-text"
          style={{
            left: typing.screen.x,
            top: typing.screen.y,
            color: typing.color,
            fontSize: textSize(width) * typing.scale,
            // Grows with what is typed; an empty box is just the outline and the caret.
            width: `${Math.max(2, text.length + 1)}ch`,
          }}
          value={text}
          autoFocus
          maxLength={80}
          aria-label={typing.index === null ? 'Text to add' : 'Edit the text'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancelled.current = true;
              setTyping(null);
            }
          }}
          // Clicking away keeps what was typed (Esc is the way to drop it).
          onBlur={commit}
        />
      )}
    </>
  );
}

/** The floating toolbar: tools, colours, undo, and whatever the caller adds at the end. */
export function MarkupToolbar({
  tool,
  onTool,
  withSelect = false,
  color,
  onColor,
  canUndo,
  onUndo,
  className = '',
  label,
  children,
}: {
  tool: MarkupTool;
  onTool: (tool: MarkupTool) => void;
  withSelect?: boolean;
  color: string;
  onColor: (color: string) => void;
  canUndo: boolean;
  onUndo: () => void;
  className?: string;
  label: string;
  children?: ReactNode;
}) {
  const tools = [
    ...(withSelect ? ([['select', 'Select an element', SelectIcon]] as const) : []),
    ['pen', 'Draw', PenIcon],
    ['box', 'Box', BoxIcon],
    ['text', 'Text', TextIcon],
  ] as const;
  return (
    <div className={`shot-tools ${className}`} role="toolbar" aria-label={label}>
      {tools.map(([t, name, Icon]) => (
        <button
          key={t}
          type="button"
          className="shot-tool"
          aria-pressed={tool === t}
          aria-label={name}
          title={name}
          onClick={() => onTool(t)}
        >
          <Icon />
        </button>
      ))}
      <span className="shot-sep" aria-hidden="true" />
      <span className="shot-colors" role="radiogroup" aria-label="Colour">
        {MARK_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            role="radio"
            aria-checked={color === c}
            aria-label={COLOR_NAMES[c]}
            title={COLOR_NAMES[c]}
            className="shot-color"
            onClick={() => onColor(c)}
          >
            <span style={{ background: c }} />
          </button>
        ))}
      </span>
      <span className="shot-sep" aria-hidden="true" />
      <button
        type="button"
        className="shot-tool"
        aria-label="Undo"
        title="Undo"
        disabled={!canUndo}
        onClick={onUndo}
      >
        <UndoIcon />
      </button>
      {children}
    </div>
  );
}

const icon = {
  width: 15,
  height: 15,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;
export function SelectIcon() {
  return (
    <svg {...icon}>
      <path d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z" />
      <path d="M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h2M14 3h1M3 9v1M21 9v2M3 14v1" />
    </svg>
  );
}
function PenIcon() {
  return (
    <svg {...icon}>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  );
}
function BoxIcon() {
  return (
    <svg {...icon}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  );
}
function TextIcon() {
  return (
    <svg {...icon}>
      <path d="M4 7V4h16v3M9 20h6M12 4v16" />
    </svg>
  );
}
function UndoIcon() {
  return (
    <svg {...icon}>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}
