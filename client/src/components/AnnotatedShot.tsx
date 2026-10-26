import { useEffect, useRef, useState, type MutableRefObject, type PointerEvent } from 'react';

// The element picker's screenshot, with annotations (PM-311): the picked element boxed, plus a box,
// pen and text tool in a few colours, and undo. Shapes are kept in the image's own pixels, so the
// exported PNG matches what was drawn however large the dialog shows it.

type Point = { x: number; y: number };
export type Shape =
  | { kind: 'box'; color: string; from: Point; to: Point }
  | { kind: 'pen'; color: string; points: Point[] }
  | { kind: 'text'; color: string; at: Point; text: string };
type Tool = 'box' | 'pen' | 'text';

const COLORS = ['#ff4d4f', '#ffb020', '#4c8dff', '#2ecc71'] as const;
const COLOR_NAMES: Record<string, string> = {
  '#ff4d4f': 'Red',
  '#ffb020': 'Amber',
  '#4c8dff': 'Blue',
  '#2ecc71': 'Green',
};

/** Draws the image and the shapes at the image's own size (for the screen and for export). */
export function paint(
  ctx: CanvasRenderingContext2D,
  image: CanvasImageSource,
  shapes: Shape[],
  w: number,
  h: number,
) {
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(image, 0, 0, w, h);
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

export function AnnotatedShot({
  src,
  initial,
  exportRef,
}: {
  src: string;
  /** Drawn first: the picked element's box. */
  initial: Shape[];
  /** Filled with a function returning the annotated image as base64 PNG. */
  exportRef: MutableRefObject<(() => string) | null>;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>(initial);
  const [tool, setTool] = useState<Tool>('box');
  const [color, setColor] = useState<string>(COLORS[0]);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [typing, setTyping] = useState<{ at: Point; screen: Point } | null>(null);
  const [text, setText] = useState('');

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = src;
  }, [src]);

  const all = draft ? [...shapes, draft] : shapes;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !image) return;
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const ctx = c.getContext('2d');
    if (ctx) paint(ctx, image, all, c.width, c.height);
  });

  useEffect(() => {
    exportRef.current = () => {
      if (!image) return '';
      const out = document.createElement('canvas');
      out.width = image.naturalWidth;
      out.height = image.naturalHeight;
      const ctx = out.getContext('2d');
      if (!ctx) return '';
      paint(ctx, image, shapes, out.width, out.height);
      return out.toDataURL('image/png').split(',')[1] ?? '';
    };
  });

  const toImage = (e: PointerEvent<HTMLCanvasElement>): Point => {
    const r = e.currentTarget.getBoundingClientRect();
    const c = e.currentTarget;
    return {
      x: Math.round(((e.clientX - r.left) / r.width) * c.width),
      y: Math.round(((e.clientY - r.top) / r.height) * c.height),
    };
  };

  return (
    <div className="shot">
      <div className="shot-tools" role="toolbar" aria-label="Annotate">
        {(['box', 'pen', 'text'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className="shot-tool"
            aria-pressed={tool === t}
            onClick={() => setTool(t)}
          >
            {t === 'box' ? 'Box' : t === 'pen' ? 'Pen' : 'Text'}
          </button>
        ))}
        <span className="shot-colors" role="radiogroup" aria-label="Colour">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={color === c}
              aria-label={COLOR_NAMES[c]}
              className="shot-color"
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </span>
        <button
          type="button"
          className="shot-tool"
          disabled={shapes.length === 0}
          onClick={() => setShapes((s) => s.slice(0, -1))}
        >
          Undo
        </button>
      </div>
      <div className="shot-stage">
        {!image && <div className="skeleton shot-skeleton" />}
        <canvas
          ref={canvas}
          className="shot-canvas"
          hidden={!image}
          aria-label="Screenshot of the page with your marks"
          onPointerDown={(e) => {
            const p = toImage(e);
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
            const p = toImage(e);
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
            if (!tiny) setShapes((s) => [...s, draft]);
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
                  setShapes((s) => [
                    ...s,
                    { kind: 'text', color, at: typing.at, text: text.trim() },
                  ]);
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
      </div>
    </div>
  );
}
