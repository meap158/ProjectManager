import { useEffect, useRef, type KeyboardEvent } from 'react';
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
const ITEM_HEIGHT = 30;

/** The context menu: a real menu (arrow keys, Home and End, Escape), kept inside the window. */
export function ContextMenu<T extends string>({
  x,
  y,
  items,
  label,
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  items: ContextMenuItem<T>[];
  /** The menu's accessible name. */
  label: string;
  onPick: (command: T) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = items.filter((item) => !item.disabled);

  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    // Anything outside the menu closes it.
    const away = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('pointerdown', away, true);
    window.addEventListener('blur', onClose);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('pointerdown', away, true);
      window.removeEventListener('blur', onClose);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

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
    else if (event.key === 'Escape' || event.key === 'Tab') onClose();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  // Estimated from the item count, so no measuring pass is needed to keep it on screen.
  const height = items.length * ITEM_HEIGHT + 12;
  const left = Math.max(4, Math.min(x, window.innerWidth - MENU_WIDTH - 4));
  const top = Math.max(4, Math.min(y, window.innerHeight - height - 4));

  return (
    <div
      ref={ref}
      className="ctx-menu"
      role="menu"
      aria-label={label}
      style={{ left, top, width: MENU_WIDTH }}
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
