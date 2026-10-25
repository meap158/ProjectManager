import {
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { GlobeIcon } from './icons';

// The Preview browser's tab strip (PM-253): tabs, a new-tab button and the context menu a browser's
// tabs have. The standard tabs pattern: one tablist with a roving tab stop, arrow keys move between
// tabs (and show them), Home and End jump, Delete closes, Alt+Left and Alt+Right reorder (the
// keyboard way to do what dragging does), and Shift+F10 or the Menu key opens the context menu.
// A middle click closes a tab, like a browser.

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
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const tabRefs = useRef(new Map<string, HTMLElement>());

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

  const onDrop = (event: DragEvent, targetId: string) => {
    event.preventDefault();
    const index = tabs.findIndex((t) => t.id === targetId);
    if (dragging && index >= 0) onMove(dragging, index);
    setDragging(null);
    setOver(null);
  };

  const menuTab = menu ? tabs.find((t) => t.id === menu.id) : undefined;
  const menuIndex = menuTab ? tabs.indexOf(menuTab) : -1;

  return (
    <div className={`preview-tabstrip${tabs.length === 1 ? ' is-single' : ''}`}>
      <div className="preview-tabs" role="tablist" aria-label="Browser tabs">
        {tabs.map((tab, index) => {
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={`preview-tab${active ? ' is-active' : ''}${tab.pinned ? ' is-pinned' : ''}${
                over === tab.id && dragging !== tab.id ? ' is-drop' : ''
              }`}
              role="presentation"
              draggable
              onDragStart={(event) => {
                setDragging(tab.id);
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', tab.id);
              }}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                setOver(tab.id);
              }}
              onDragLeave={() => setOver((o) => (o === tab.id ? null : o))}
              onDrop={(event) => onDrop(event, tab.id)}
              onDragEnd={() => {
                setDragging(null);
                setOver(null);
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
                onClick={() => onActivate(tab.id)}
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
                  ×
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
