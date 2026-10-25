import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import './context-menu.css';

// A context menu (PM-259): the real menu pattern (role="menu", arrow keys, Home and End, Escape,
// Tab closes), focus on the first enabled item, closed by an outside click, a window blur or a
// resize, and kept inside the window. Shared by the Preview tabs and the Files tree.

export interface ContextMenuItem<T extends string = string> {
  command: T;
  label: string;
  disabled?: boolean;
  /** A rule above this item. */
  divider?: boolean;
}

const MENU_WIDTH = 224;
/** Space kept between the menu and the window's edges. */
const EDGE = 4;

/**
 * Where a menu of this size goes for a click at (x, y): below and right of the pointer, or above
 * / left of it when there is no room, and never past an edge. A menu taller than the window
 * starts at the top edge and scrolls (its max-height is the window's).
 */
export function placeMenu(
  x: number,
  y: number,
  width: number,
  height: number,
  view: { width: number; height: number },
): { left: number; top: number } {
  const left =
    x + width + EDGE <= view.width
      ? x
      : Math.max(EDGE, Math.min(x - width, view.width - width - EDGE));
  const top =
    y + height + EDGE <= view.height
      ? y
      : y - height >= EDGE
        ? y - height
        : Math.max(EDGE, view.height - height - EDGE);
  return { left, top };
}

/** The context menu: a real menu (arrow keys, Home and End, Escape), kept inside the window. */
export function ContextMenu<T extends string>({
  x,
  y,
  items,
  label,
  onPick,
  onClose,
  anchor,
}: {
  x: number;
  y: number;
  items: ContextMenuItem<T>[];
  /** The menu's accessible name. */
  label: string;
  onPick: (command: T) => void;
  onClose: () => void;
  /** A menu-button trigger can toggle the menu without being treated as an outside click. */
  anchor?: HTMLElement;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Measured before paint (dividers and touch-sized rows change its height), then placed.
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect();
    if (!box) return;
    setPos(
      placeMenu(x, y, box.width, box.height, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    );
  }, [x, y, items.length]);
  const enabled = items.filter((item) => !item.disabled);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    // Anything outside the menu closes it.
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node) && !anchor?.contains(event.target as Node))
        onClose();
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose, anchor]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []),
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const focus = (i: number) => buttons[(i + buttons.length) % buttons.length]?.focus();
    if (event.key === 'ArrowDown') focus(at + 1);
    else if (event.key === 'ArrowUp') focus(at - 1);
    else if (event.key === 'Home') focus(0);
    else if (event.key === 'End') focus(buttons.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      anchor?.focus();
      onClose();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={label}
      style={{
        left: pos?.left ?? x,
        top: pos?.top ?? y,
        width: MENU_WIDTH,
        visibility: pos ? undefined : 'hidden',
      }}
      onKeyDown={onKeyDown}
    >
      {items.map((item) => (
        <div key={item.command} role="none">
          {item.divider && enabled.length > 0 && <hr className="ctx-menu-divider" />}
          <button
            type="button"
            role="menuitem"
            className="ctx-menu-item"
            disabled={item.disabled}
            onClick={() => onPick(item.command)}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
