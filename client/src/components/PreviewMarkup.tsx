import { useEffect, useRef, useState } from 'react';
import { MARK_COLORS, MarkupLayer, MarkupToolbar, type MarkupTool, type Shape } from './Markup';
import { parsePage, parsePicked, type PickedElement, type PickedPage } from './PreviewPickDialog';

// Marking up the live page (PM-311), as in the Claude app: a toolbar floats at the foot of the
// Preview with Select (the page's picker: hover outlines, a click picks, the pick stays outlined),
// Draw, Box and Text over a transparent layer on the page, colours, undo, and Add to chat. The
// layer covers the page exactly, so marks are in the page's CSS pixels and land in the same place
// on the screenshot, which is retaken at the page's size and scroll. Messages count only from the
// shown frame; what they carry is untrusted and parsed.

export interface Markup {
  page: PickedPage;
  /** The page as it looked when Add to chat was pressed (static HTML), for the screenshot. */
  snapshot: string | null;
  element: PickedElement | null;
  marks: Shape[];
}

export function PreviewMarkup({
  frame,
  onAdd,
  onClose,
  onError,
}: {
  frame: () => HTMLIFrameElement | null;
  onAdd: (markup: Markup) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [tool, setTool] = useState<MarkupTool>('select');
  const [color, setColor] = useState<string>(MARK_COLORS[0]);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [element, setElement] = useState<PickedElement | null>(null);
  const [adding, setAdding] = useState(false);
  const pendingState = useRef<((page: PickedPage | null, snapshot: string | null) => void) | null>(
    null,
  );

  const tell = (type: 'start' | 'pause' | 'stop' | 'clear' | 'state') =>
    frame()?.contentWindow?.postMessage({ pmPicker: true, type }, '*');

  // The layer follows the page's size (the Preview's stage), for a sharp, exact canvas.
  useEffect(() => {
    const el = layer.current;
    if (!el) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: el.clientWidth, height: el.clientHeight }),
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Select hands the pointer (and the keyboard, for ↑ ↓ Enter) to the page; drawing takes it back.
  useEffect(() => {
    if (tool === 'select') {
      tell('start');
      frame()?.contentWindow?.focus();
    } else tell('pause');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tool]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => tell('stop'), []);

  useEffect(() => {
    const onMessage = (event: globalThis.MessageEvent) => {
      if (event.source !== frame()?.contentWindow) return;
      const data = event.data as {
        pmPicker?: unknown;
        type?: unknown;
        element?: unknown;
        page?: unknown;
      } | null;
      if (!data || data.pmPicker !== true) return;
      if (data.type === 'cancelled') onClose();
      else if (data.type === 'picked') {
        const picked = parsePicked(data.element);
        if (picked) setElement(picked);
        else onError('The page sent something that is not an element.');
      } else if (data.type === 'state') {
        const html =
          typeof (data as { snapshot?: unknown }).snapshot === 'string'
            ? ((data as { snapshot: string }).snapshot as string)
            : null;
        pendingState.current?.(
          parsePage(data.page),
          html && html.length <= 8_388_608 ? html : null,
        );
        pendingState.current = null;
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame, onClose, onError]);

  /** Where the page is now (its scroll, for the screenshot); the element's page if it does not answer. */
  /**
   * The page now: its scroll (for the screenshot) and a snapshot of what it shows, taken at this
   * moment, before the dialog opens. The element's page, without a snapshot, if it does not answer.
   */
  const currentPage = () =>
    new Promise<{ page: PickedPage | null; snapshot: string | null }>((resolve) => {
      const timer = setTimeout(() => resolve({ page: element, snapshot: null }), 3000);
      pendingState.current = (page, snapshot) => {
        clearTimeout(timer);
        resolve({ page: page ?? element, snapshot });
      };
      tell('state');
    });

  const add = async () => {
    setAdding(true);
    const { page, snapshot } = await currentPage();
    setAdding(false);
    if (!page) {
      onError('The page did not answer. Reload it in the Preview and try again.');
      return;
    }
    onAdd({ page, snapshot, element, marks: shapes });
  };

  return (
    <div ref={layer} className="preview-markup">
      <MarkupLayer
        width={size.width}
        height={size.height}
        pixelRatio={window.devicePixelRatio || 1}
        shapes={shapes}
        onShapes={setShapes}
        tool={tool}
        color={color}
        className="preview-markup-canvas"
        label="Marks on the page"
      />
      <MarkupToolbar
        withSelect
        tool={tool}
        onTool={setTool}
        color={color}
        onColor={setColor}
        canUndo={shapes.length > 0}
        onUndo={() => setShapes((s) => s.slice(0, -1))}
        className="preview-markup-tools"
        label="Mark up the page"
      >
        <span className="shot-sep" aria-hidden="true" />
        {element ? (
          <span className="preview-markup-chip" title={element.selector}>
            <code>{element.react ? `<${element.react.component} />` : `<${element.tag}>`}</code>
            <button
              type="button"
              aria-label="Clear the picked element"
              title="Clear the picked element"
              onClick={() => {
                tell('clear');
                setElement(null);
              }}
            >
              ×
            </button>
          </span>
        ) : (
          <span className="preview-markup-hint">
            {tool === 'select' ? 'Click an element' : 'Draw on the page'}
          </span>
        )}
        <button
          type="button"
          className="btn btn-primary btn-sm preview-markup-add"
          disabled={adding || (!element && shapes.length === 0)}
          onClick={() => void add()}
        >
          Add to chat
        </button>
        <button
          type="button"
          className="shot-tool"
          aria-label="Stop marking up (Esc)"
          title="Stop marking up (Esc)"
          onClick={onClose}
        >
          ×
        </button>
      </MarkupToolbar>
    </div>
  );
}
