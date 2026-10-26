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
      const size = Math.max(14, Math.round(w / 55));
      ctx.font = `600 ${size}px system-ui, sans-serif`;
      ctx.lineWidth = Math.max(3, size / 5);
      ctx.strokeStyle = 'rgba(0,0,0,.65)';
      ctx.strokeText(s.text, s.at.x, s.at.y);
      ctx.fillText(s.text, s.at.x, s.at.y);
    }
  }
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
  const [typing, setTyping] = useState<{ at: Point; screen: Point } | null>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    const c = canvas.current;
    if (!c || width <= 0 || height <= 0) return;
    c.width = Math.round(width * pixelRatio);
    c.height = Math.round(height * pixelRatio);
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    paint(ctx, image, draft ? [...shapes, draft] : shapes, width, height);
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
        style={{ pointerEvents: drawing ? 'auto' : 'none', cursor: drawing ? 'crosshair' : '' }}
        onPointerDown={(e) => {
          if (!drawing) return;
          const p = at(e);
          if (tool === 'text') {
            const r = e.currentTarget.getBoundingClientRect();
            setTyping({ at: p, screen: { x: e.clientX - r.left, y: e.clientY - r.top } });
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
        onPointerUp={() => {
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
          className="input shot-text"
          style={{ left: typing.screen.x, top: typing.screen.y }}
          value={text}
          autoFocus
          maxLength={80}
          placeholder="Type, then Enter"
          aria-label="Text to add"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (text.trim())
                onShapes([...shapes, { kind: 'text', color, at: typing.at, text: text.trim() }]);
              setTyping(null);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              setTyping(null);
            }
          }}
          onBlur={() => setTyping(null)}
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
