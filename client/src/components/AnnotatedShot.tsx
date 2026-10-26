import { useEffect, useState, type MutableRefObject } from 'react';
import {
  MARK_COLORS,
  MarkupLayer,
  MarkupToolbar,
  paint,
  type MarkupTool,
  type Shape,
} from './Markup';

// The element picker's screenshot, with annotations (PM-311): the picked element boxed and any
// marks drawn on the live page, plus the same tools to add more. Shapes are kept in the image's own
// pixels, so the exported PNG matches what was drawn however large the dialog shows it.

export type { Shape } from './Markup';

export function AnnotatedShot({
  src,
  initial,
  exportRef,
}: {
  src: string;
  /** Drawn first: the picked element's box and the live page's marks, in image pixels. */
  initial: Shape[];
  /** Filled with a function returning the annotated image as base64 PNG. */
  exportRef: MutableRefObject<(() => string) | null>;
}) {
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [shapes, setShapes] = useState<Shape[]>(initial);
  const [tool, setTool] = useState<MarkupTool>('pen');
  const [color, setColor] = useState<string>(MARK_COLORS[0]);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setImage(img);
    img.src = src;
  }, [src]);

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

  return (
    <div className={`shot${image ? ' is-ready' : ''}`}>
      {image && (
        <MarkupLayer
          width={image.naturalWidth}
          height={image.naturalHeight}
          image={image}
          shapes={shapes}
          onShapes={setShapes}
          tool={tool}
          color={color}
          className="shot-canvas"
          label="Screenshot of the page with your marks"
        />
      )}
      {image && (
        <MarkupToolbar
          tool={tool}
          onTool={setTool}
          color={color}
          onColor={setColor}
          canUndo={shapes.length > 0}
          onUndo={() => setShapes((s) => s.slice(0, -1))}
          label="Mark up the screenshot"
        />
      )}
    </div>
  );
}
