import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { CloseIcon, GlobeIcon } from './icons';

// The Preview browser's tab strip (PM-253): tabs, a new-tab button and the context menu a browser's
// tabs have. The standard tabs pattern: one tablist with a roving tab stop, arrow keys move between
// tabs (and show them), Home and End jump, Delete closes, Alt+Left and Alt+Right reorder (the
// keyboard way to do what dragging does), and Shift+F10 or the Menu key opens the context menu.
// A middle click closes a tab, like a browser.
//
// Reordering (PM-328) works like Chrome's: the dragged tab follows the pointer inside its group
// (pinned or not), its neighbours slide aside as it passes their middle, and on release it glides
// into its slot before the order changes. Any reorder, from the keyboard or the menu too, animates
// from where the tabs were. With prefers-reduced-motion the tabs simply move.

export interface StripTab {
  id: string;
  title: string;
  pinned: boolean;
  loading: boolean;
  /** Nothing open in it yet. */
  blank: boolean;
  /** The address it shows, for "Copy address". */
  address: string | null;
}

export type TabCommand =
  | 'new-right'
  | 'reload'
  | 'duplicate'
  | 'pin'
  | 'copy'
  | 'reopen'
  | 'close'
  | 'close-others'
  | 'close-right'
  | 'move-left'
  | 'move-right';

type MenuItem = ContextMenuItem<TabCommand>;

/** The range of positions a tab may move within: pinned tabs stay among pinned ones. */
function groupRange(tab: StripTab, all: StripTab[]): [number, number] {
  const pinnedCount = all.filter((t) => t.pinned).length;
  return tab.pinned ? [0, pinnedCount - 1] : [pinnedCount, all.length - 1];
}

type Box = { left: number; right: number; width: number };

/**
 * Where a dragged tab lands and how far each tab is shifted meanwhile. `boxes` are the tabs'
 * places when the drag began; `dx` is how far the pointer moved. Pure, so it is testable.
 */
export function dragLayout(
  boxes: Box[],
  from: number,
  dx: number,
  [lo, hi]: [number, number],
): { target: number; dx: number; shift: (index: number) => number; slot: number } {
  const me = boxes[from]!;
  const clamped = Math.min(boxes[hi]!.right - me.right, Math.max(boxes[lo]!.left - me.left, dx));
  // As in Chrome: a neighbour gives way once the dragged tab's leading edge passes its middle.
  const mid = (i: number) => boxes[i]!.left + boxes[i]!.width / 2;
  let target = from;
  if (clamped > 0) while (target < hi && me.right + clamped > mid(target + 1)) target++;
  else if (clamped < 0) while (target > lo && me.left + clamped < mid(target - 1)) target--;
  const next = boxes[from + 1] ?? boxes[from - 1];
  const gap = next
    ? Math.max(0, next.left > me.left ? next.left - me.right : me.left - next.right)
    : 0;
  const step = me.width + gap;
  const shift = (i: number) =>
    i === from
      ? 0
      : target > from && i > from && i <= target
        ? -step
        : target < from && i >= target && i < from
          ? step
          : 0;
  // Where it settles: the far edge of the slot it takes.
  const slot =
    target > from
      ? boxes[target]!.right - me.right
      : target < from
        ? boxes[target]!.left - me.left
        : 0;
  return { target, dx: clamped, shift, slot };
}

const reducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** The items for one tab. Pure, so the rules (what is disabled and why) are testable. */
export function tabMenuItems(
  tab: StripTab,
  index: number,
  all: StripTab[],
  canReopen: boolean,
  atCap: boolean,
): MenuItem[] {
  const pinnedCount = all.filter((t) => t.pinned).length;
  const lo = tab.pinned ? 0 : pinnedCount;
  const hi = tab.pinned ? pinnedCount - 1 : all.length - 1;
  return [
    { command: 'new-right', label: 'New tab to the right', disabled: atCap },
    { command: 'reload', label: 'Reload', disabled: tab.blank },
    { command: 'duplicate', label: 'Duplicate', disabled: atCap },
    { command: 'pin', label: tab.pinned ? 'Unpin tab' : 'Pin tab' },
    { command: 'copy', label: 'Copy address', disabled: !tab.address },
    { command: 'move-left', label: 'Move left', divider: true, disabled: index <= lo },
    { command: 'move-right', label: 'Move right', disabled: index >= hi },
    { command: 'close', label: 'Close', divider: true },
    {
      command: 'close-others',
      label: 'Close other tabs',
      disabled: all.filter((t) => t.id !== tab.id && !t.pinned).length === 0,
    },
    {
      command: 'close-right',
      label: 'Close tabs to the right',
      disabled: all.slice(index + 1).filter((t) => !t.pinned).length === 0,
    },
    { command: 'reopen', label: 'Reopen closed tab', divider: true, disabled: !canReopen || atCap },
  ];
}

export function PreviewTabStrip({
  tabs,
  activeId,
  canReopen,
  atCap,
  icon,
  onActivate,
  onNew,
  onMove,
  onCommand,
}: {
  tabs: StripTab[];
  activeId: string;
  canReopen: boolean;
  atCap: boolean;
  icon: (tab: StripTab) => ReactNode;
  onActivate: (id: string) => void;
  onNew: () => void;
  /** Move a tab to the position another tab holds. */
  onMove: (id: string, toIndex: number) => void;
  onCommand: (command: TabCommand, id: string) => void;
}) {
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const tabRefs = useRef(new Map<string, HTMLElement>());
  const tabEls = useRef(new Map<string, HTMLElement>());
  const strip = useRef<HTMLDivElement>(null);
  // A drag in progress: where it began, and (once past the threshold) where the tab is now.
  const press = useRef<{
    id: string;
    pointerId: number;
    x: number;
    scroll: number;
    boxes: Box[];
    moved: boolean;
  } | null>(null);
  const [drag, setDrag] = useState<{
    id: string;
    dx: number;
    settling: boolean;
    /** The tabs' places when the drag began, and their order then. */
    boxes: Box[];
    order: string;
    /** Transitions off, everything still in place: the frame before the order changes. */
    frozen?: boolean;
  } | null>(null);
  const swallowClick = useRef(false);

  // Any reorder animates from where the tabs were (the keyboard, the menu, a finished drag).
  const lastBoxes = useRef(new Map<string, number>());
  const order = tabs.map((t) => t.id).join('|');
  const lastOrder = useRef(order);
  /** The order is changing because a drag ended: the tabs are already drawn in place. */
  const settled = useRef(false);
  useLayoutEffect(() => {
    const changed = lastOrder.current !== order;
    lastOrder.current = order;
    // A finished drag already glided into place. Animating "from where the tabs were" would
    // replay it from positions measured when the glide began (a visible snap back).
    const animate = changed && !settled.current;
    if (changed) settled.current = false;
    const now = new Map<string, number>();
    for (const [id, el] of tabEls.current) now.set(id, el.getBoundingClientRect().left);
    if (animate && !reducedMotion())
      for (const [id, left] of now) {
        const before = lastBoxes.current.get(id);
        const el = tabEls.current.get(id);
        if (before === undefined || !el || Math.abs(before - left) < 0.5 || !el.animate) continue;
        el.animate([{ transform: `translateX(${before - left}px)` }, { transform: 'none' }], {
          duration: 160,
          easing: 'cubic-bezier(.2,.8,.2,1)',
        });
      }
    lastBoxes.current = now;
  });

  const openMenu = (id: string, x: number, y: number) => setMenu({ id, x, y });
  const closeMenu = (restoreFocus: boolean) => {
    const id = menu?.id;
    setMenu(null);
    if (restoreFocus && id) tabRefs.current.get(id)?.focus();
  };

  const focusTab = (index: number, activate: boolean) => {
    const tab = tabs[(index + tabs.length) % tabs.length];
    if (!tab) return;
    tabRefs.current.get(tab.id)?.focus();
    if (activate) onActivate(tab.id);
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>, tab: StripTab, index: number) => {
    if (event.altKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      onMove(tab.id, index + (event.key === 'ArrowLeft' ? -1 : 1));
    } else if (event.key === 'ArrowRight') focusTab(index + 1, true);
    else if (event.key === 'ArrowLeft') focusTab(index - 1, true);
    else if (event.key === 'Home') focusTab(0, true);
    else if (event.key === 'End') focusTab(tabs.length - 1, true);
    else if (event.key === 'Delete') onCommand('close', tab.id);
    else if (event.key === 'Enter' || event.key === ' ') onActivate(tab.id);
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      const rect = event.currentTarget.getBoundingClientRect();
      openMenu(tab.id, rect.left, rect.bottom);
    } else return;
    event.preventDefault();
  };

  const dragIndex = drag ? tabs.findIndex((t) => t.id === drag.id) : -1;
  const layout =
    // Only while the order is the one the drag began with: once the new order lands, every tab
    // is drawn in its final place with no offset (an offset on the new order showed a jump).
    drag && dragIndex >= 0 && drag.order === order
      ? dragLayout(drag.boxes, dragIndex, drag.dx, groupRange(tabs[dragIndex]!, tabs))
      : null;

  const endDrag = (commit: boolean) => {
    const p = press.current;
    if (!p) return;
    press.current = null;
    if (!p.moved || !drag || !layout) {
      setDrag(null);
      return;
    }
    // Ignore the click this release may produce, and only that one. The pointer was captured by
    // the tab, so that click often lands on the tab itself rather than its button and never
    // clears the flag; left set, it swallowed the next real click on a tab.
    swallowClick.current = true;
    window.setTimeout(() => (swallowClick.current = false), 300);
    const target = commit ? layout.target : dragIndex;
    // Glide into the slot, then change the order (no jump: everything is already in place).
    setDrag({ ...drag, dx: commit ? layout.slot : 0, settling: true });
    // Then, in two steps: first switch the tabs' transitions off while everything stays where it
    // is, and only on the next frame change the order and drop the offsets. Done together, the
    // browser started a transition from the old offset with the old duration (a snap back).
    window.setTimeout(
      () => {
        if (target === dragIndex) {
          setDrag(null);
          return;
        }
        setDrag((d) => (d ? { ...d, frozen: true } : d));
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            settled.current = true;
            setDrag(null);
            onMove(drag.id, target);
          }),
        );
      },
      reducedMotion() ? 0 : 160,
    );
  };

  const onPointerDown = (event: PointerEvent<HTMLElement>, tab: StripTab) => {
    swallowClick.current = false; // A new press is never the end of the last drag.
    // Mouse and pen drag; a touch scrolls the strip (the menu and keyboard move tabs there).
    if (event.button !== 0 || event.pointerType === 'touch' || drag) return;
    if ((event.target as HTMLElement).closest('.preview-tab-close')) return;
    const boxes = tabs.map((t) => {
      const r = tabEls.current.get(t.id)!.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    });
    press.current = {
      id: tab.id,
      pointerId: event.pointerId,
      x: event.clientX,
      scroll: strip.current?.scrollLeft ?? 0,
      boxes,
      moved: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const p = press.current;
    if (!p || event.pointerId !== p.pointerId) return;
    const el = strip.current;
    // Near an edge of an overflowing strip, scroll it along.
    if (el && p.moved) {
      const r = el.getBoundingClientRect();
      if (event.clientX < r.left + 24) el.scrollLeft -= 8;
      else if (event.clientX > r.right - 24) el.scrollLeft += 8;
    }
    const dx = event.clientX - p.x + ((el?.scrollLeft ?? 0) - p.scroll);
    if (!p.moved) {
      if (Math.abs(dx) < 5) return;
      p.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    setDrag({ id: p.id, dx, settling: false, boxes: p.boxes, order });
  };

  const menuTab = menu ? tabs.find((t) => t.id === menu.id) : undefined;
  const menuIndex = menuTab ? tabs.indexOf(menuTab) : -1;

  return (
    <div className={`preview-tabstrip${tabs.length === 1 ? ' is-single' : ''}`}>
      <div
        ref={strip}
        className={`preview-tabs${layout ? ' is-dragging' : ''}${drag?.frozen ? ' is-frozen' : ''}`}
        role="tablist"
        aria-label="Browser tabs"
      >
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          const dragged = drag?.id === tab.id;
          const offset = !layout
            ? 0
            : dragged
              ? drag!.settling
                ? drag!.dx
                : layout.dx
              : layout.shift(index);
          return (
            <div
              key={tab.id}
              ref={(node) => {
                if (node) tabEls.current.set(tab.id, node);
                else tabEls.current.delete(tab.id);
              }}
              className={`preview-tab${active ? ' is-active' : ''}${tab.pinned ? ' is-pinned' : ''}${
                dragged ? (drag!.settling ? ' is-settling' : ' is-lifted') : ''
              }`}
              style={
                offset ? ({ transform: `translateX(${offset}px)` } as CSSProperties) : undefined
              }
              role="presentation"
              onPointerDown={(event) => onPointerDown(event, tab)}
              onPointerMove={onPointerMove}
              onPointerUp={() => endDrag(true)}
              onPointerCancel={() => endDrag(false)}
              onKeyDownCapture={(event) => {
                // Esc while dragging puts the tab back.
                if (event.key === 'Escape' && press.current?.moved) {
                  event.preventDefault();
                  endDrag(false);
                }
              }}
              onContextMenu={(event: MouseEvent) => {
                event.preventDefault();
                openMenu(tab.id, event.clientX, event.clientY);
              }}
              onMouseDown={(event: MouseEvent) => {
                // Suppress Windows autoscroll/focus changes before the auxiliary click.
                if (event.button === 1) event.preventDefault();
              }}
              onAuxClick={(event: MouseEvent) => {
                // Middle click closes, as in a browser.
                if (event.button === 1) {
                  event.preventDefault();
                  onCommand('close', tab.id);
                }
              }}
            >
              <button
                type="button"
                role="tab"
                id={`preview-tab-${tab.id}`}
                aria-selected={active}
                aria-controls={`preview-panel-${tab.id}`}
                tabIndex={active ? 0 : -1}
                className="preview-tab-main"
                title={tab.address ? `${tab.title} (${tab.address})` : tab.title}
                ref={(node) => {
                  if (node) tabRefs.current.set(tab.id, node);
                  else tabRefs.current.delete(tab.id);
                }}
                onClick={() => {
                  // The click that ends a drag is not a click on the tab.
                  if (swallowClick.current) {
                    swallowClick.current = false;
                    return;
                  }
                  onActivate(tab.id);
                }}
                onKeyDown={(event) => onTabKeyDown(event, tab, index)}
              >
                {tab.blank ? <GlobeIcon size={14} className="preview-tab-globe" /> : icon(tab)}
                {!tab.pinned && <span className="preview-tab-title">{tab.title}</span>}
                {tab.loading && <span className="preview-tab-busy" aria-label="Loading" />}
              </button>
              {!tab.pinned && (
                <button
                  type="button"
                  className="preview-tab-close"
                  tabIndex={-1}
                  aria-label={`Close ${tab.title}`}
                  onClick={() => onCommand('close', tab.id)}
                >
                  <CloseIcon size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
      <button
        type="button"
        className="preview-tab-new"
        aria-label="New tab"
        title="New tab"
        disabled={atCap}
        onClick={onNew}
      >
        +
      </button>
      {menu && menuTab && (
        <ContextMenu
          label="Tab actions"
          x={menu.x}
          y={menu.y}
          items={tabMenuItems(menuTab, menuIndex, tabs, canReopen, atCap)}
          onClose={() => closeMenu(true)}
          onPick={(command) => {
            const id = menu.id;
            setMenu(null);
            onCommand(command, id);
          }}
        />
      )}
    </div>
  );
}
