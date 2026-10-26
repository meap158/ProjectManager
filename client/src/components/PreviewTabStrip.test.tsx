// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PreviewTabStrip,
  dragLayout,
  tabMenuItems,
  type StripTab,
  type TabCommand,
} from './PreviewTabStrip';

afterEach(cleanup);

// The Preview browser's tab strip (PM-253): the tabs pattern, a context menu, middle-click close.

const tab = (id: string, extra: Partial<StripTab> = {}): StripTab => ({
  id,
  title: `Tab ${id}`,
  pinned: false,
  loading: false,
  blank: false,
  address: `http://localhost:3000/${id}`,
  ...extra,
});

describe('tabMenuItems', () => {
  const find = (items: ReturnType<typeof tabMenuItems>, command: TabCommand) =>
    items.find((i) => i.command === command)!;

  it('disables what cannot apply and explains nothing else', () => {
    const all = [tab('a'), tab('b'), tab('c')];
    const first = tabMenuItems(all[0]!, 0, all, false, false);
    expect(find(first, 'move-left').disabled).toBe(true);
    expect(find(first, 'move-right').disabled).toBe(false);
    expect(find(first, 'reopen').disabled).toBe(true);
    const last = tabMenuItems(all[2]!, 2, all, true, false);
    expect(find(last, 'move-right').disabled).toBe(true);
    expect(find(last, 'close-right').disabled).toBe(true);
    expect(find(last, 'reopen').disabled).toBe(false);
  });

  it('blocks opening more tabs at the cap, and treats a blank tab as having nothing to reload or copy', () => {
    const all = [tab('a', { blank: true, address: null })];
    const items = tabMenuItems(all[0]!, 0, all, true, true);
    expect(find(items, 'new-right').disabled).toBe(true);
    expect(find(items, 'duplicate').disabled).toBe(true);
    expect(find(items, 'reload').disabled).toBe(true);
    expect(find(items, 'copy').disabled).toBe(true);
    expect(find(items, 'reopen').disabled).toBe(true);
    expect(find(items, 'close-others').disabled).toBe(true);
  });

  it('keeps pinned tabs in their own group and labels the pin toggle', () => {
    const all = [tab('p', { pinned: true }), tab('q', { pinned: true }), tab('r')];
    expect(find(tabMenuItems(all[0]!, 0, all, false, false), 'pin').label).toBe('Unpin tab');
    expect(find(tabMenuItems(all[2]!, 2, all, false, false), 'pin').label).toBe('Pin tab');
    expect(find(tabMenuItems(all[1]!, 1, all, false, false), 'move-right').disabled).toBe(true);
    expect(find(tabMenuItems(all[2]!, 2, all, false, false), 'move-left').disabled).toBe(true);
    // Close others keeps pinned tabs, so with only pinned ones around there is nothing to close.
    expect(find(tabMenuItems(all[2]!, 2, all, false, false), 'close-others').disabled).toBe(true);
  });
});

describe('PreviewTabStrip', () => {
  function setup(tabs = [tab('a'), tab('b'), tab('c')], activeId = 'b') {
    const handlers = {
      onActivate: vi.fn(),
      onNew: vi.fn(),
      onMove: vi.fn(),
      onCommand: vi.fn(),
    };
    render(
      <PreviewTabStrip
        tabs={tabs}
        activeId={activeId}
        canReopen
        atCap={false}
        icon={() => <span>icon</span>}
        {...handlers}
      />,
    );
    return handlers;
  }

  it('is a tablist with the active tab selected and the only tab stop', () => {
    setup();
    const tabs = screen.getAllByRole('tab');
    expect(screen.getByRole('tablist', { name: 'Browser tabs' })).toBeTruthy();
    expect(tabs.map((t) => t.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false']);
    expect(tabs.map((t) => t.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
  });

  it('opens a new tab and activates one by click', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }));
    expect(h.onNew).toHaveBeenCalledOnce();
    fireEvent.click(screen.getAllByRole('tab')[2]!);
    expect(h.onActivate).toHaveBeenCalledWith('c');
  });

  it('closes with the × button and with a middle click', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Close Tab a' }));
    expect(h.onCommand).toHaveBeenCalledWith('close', 'a');
    fireEvent(
      screen.getAllByRole('tab')[2]!.parentElement!,
      new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }),
    );
    expect(h.onCommand).toHaveBeenCalledWith('close', 'c');
  });

  it('suppresses middle-button autoscroll and closes from the title without activating the tab', () => {
    const h = setup();
    const title = screen.getAllByRole('tab')[0]!.querySelector('.preview-tab-title')!;
    expect(fireEvent.mouseDown(title, { button: 1 })).toBe(false);
    fireEvent(title, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }));
    expect(h.onCommand).toHaveBeenCalledExactlyOnceWith('close', 'a');
    expect(h.onActivate).not.toHaveBeenCalled();
    fireEvent(title, new MouseEvent('auxclick', { bubbles: true, button: 2 }));
    expect(h.onCommand).toHaveBeenCalledTimes(1);
  });

  it('moves with the arrow keys (and shows the tab), jumps with Home and End, closes with Delete', () => {
    const h = setup();
    const middle = screen.getAllByRole('tab')[1]!;
    fireEvent.keyDown(middle, { key: 'ArrowRight' });
    expect(h.onActivate).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(middle, { key: 'ArrowLeft' });
    expect(h.onActivate).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(middle, { key: 'End' });
    expect(h.onActivate).toHaveBeenLastCalledWith('c');
    fireEvent.keyDown(middle, { key: 'Home' });
    expect(h.onActivate).toHaveBeenLastCalledWith('a');
    fireEvent.keyDown(middle, { key: 'Delete' });
    expect(h.onCommand).toHaveBeenCalledWith('close', 'b');
  });

  it('reorders from the keyboard with Alt+Arrow, the way dragging does', () => {
    const h = setup();
    const middle = screen.getAllByRole('tab')[1]!;
    fireEvent.keyDown(middle, { key: 'ArrowLeft', altKey: true });
    expect(h.onMove).toHaveBeenLastCalledWith('b', 0);
    fireEvent.keyDown(middle, { key: 'ArrowRight', altKey: true });
    expect(h.onMove).toHaveBeenLastCalledWith('b', 2);
    expect(h.onActivate).not.toHaveBeenCalled();
  });

  it('drags like Chrome: a small move is still a click, a real drag lands where it was dropped (PM-328)', async () => {
    vi.useFakeTimers();
    const h = setup();
    const wrappers = screen.getAllByRole('tab').map((t) => t.parentElement!);
    // Three 100px tabs with 4px between them.
    wrappers.forEach((w, i) => {
      w.getBoundingClientRect = () =>
        ({
          left: i * 104,
          right: i * 104 + 100,
          width: 100,
          top: 0,
          bottom: 32,
          height: 32,
        }) as DOMRect;
      w.setPointerCapture = () => {};
    });
    const [a] = wrappers;
    const tabA = screen.getAllByRole('tab')[0]!;
    // Under the threshold: a click.
    fireEvent.pointerDown(a!, { button: 0, pointerId: 1, clientX: 50, pointerType: 'mouse' });
    fireEvent.pointerMove(a!, { pointerId: 1, clientX: 53 });
    fireEvent.pointerUp(a!, { pointerId: 1, clientX: 53 });
    fireEvent.click(tabA);
    expect(h.onActivate).toHaveBeenCalledWith('a');
    expect(h.onMove).not.toHaveBeenCalled();
    // A drag past the third tab's middle: neighbours slide aside, then it lands at index 2.
    fireEvent.pointerDown(a!, { button: 0, pointerId: 2, clientX: 50, pointerType: 'mouse' });
    fireEvent.pointerMove(a!, { pointerId: 2, clientX: 270 });
    expect(wrappers[1]!.style.transform).toBe('translateX(-104px)');
    expect(a!.className).toContain('is-lifted');
    fireEvent.pointerUp(a!, { pointerId: 2, clientX: 270 });
    fireEvent.click(tabA); // The click that ends a drag does nothing.
    expect(h.onActivate).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.onMove).toHaveBeenCalledWith('a', 2);
    // The next real click on a tab is not swallowed (the release's own click may land on the tab
    // rather than its button, and must not leave the guard set).
    await vi.advanceTimersByTimeAsync(400);
    fireEvent.click(screen.getAllByRole('tab')[1]!);
    expect(h.onActivate).toHaveBeenLastCalledWith('b');
    vi.useRealTimers();
  });

  it('works out the landing place and the shifts, inside the tab group', () => {
    const boxes = [0, 1, 2, 3].map((i) => ({ left: i * 104, right: i * 104 + 100, width: 100 }));
    const right = dragLayout(boxes, 0, 160, [0, 3]);
    expect(right.target).toBe(2);
    expect([1, 2, 3].map(right.shift)).toEqual([-104, -104, 0]);
    expect(right.slot).toBe(208);
    const left = dragLayout(boxes, 3, -120, [0, 3]);
    expect(left.target).toBe(2);
    expect(left.shift(2)).toBe(104);
    // Clamped to its group (pinned tabs 0-1 stay put for an unpinned tab).
    const kept = dragLayout(boxes, 2, -500, [2, 3]);
    expect(kept.dx).toBe(0);
    expect(kept.target).toBe(2);
  });

  it('opens a context menu on right click, runs a command and closes', () => {
    const h = setup();
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]!.parentElement!, {
      clientX: 40,
      clientY: 50,
    });
    const menu = screen.getByRole('menu', { name: 'Tab actions' });
    const names = within(menu)
      .getAllByRole('menuitem')
      .map((i) => i.textContent);
    expect(names).toEqual([
      'New tab to the right',
      'Reload',
      'Duplicate',
      'Pin tab',
      'Copy address',
      'Move left',
      'Move right',
      'Close',
      'Close other tabs',
      'Close tabs to the right',
      'Reopen closed tab',
    ]);
    // The first enabled item has focus, so the menu is keyboard-ready at once.
    expect(document.activeElement?.textContent).toBe('New tab to the right');
    expect(
      (within(menu).getByRole('menuitem', { name: 'Move left' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Close other tabs' }));
    expect(h.onCommand).toHaveBeenCalledWith('close-others', 'a');
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens the menu from the keyboard and drives it with the arrow keys and Escape', () => {
    setup();
    const second = screen.getAllByRole('tab')[1]!;
    second.focus();
    fireEvent.keyDown(second, { key: 'F10', shiftKey: true });
    const menu = screen.getByRole('menu');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Reload');
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('Reopen closed tab');
    fireEvent.keyDown(menu, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(second);
  });

  it('closes the menu on a click elsewhere', () => {
    setup();
    fireEvent.contextMenu(screen.getAllByRole('tab')[0]!.parentElement!, {
      clientX: 10,
      clientY: 10,
    });
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('shows a pinned tab as its icon only, with no close button', () => {
    setup([tab('p', { pinned: true }), tab('q')], 'q');
    expect(screen.queryByRole('button', { name: 'Close Tab p' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Close Tab q' })).toBeTruthy();
    expect(screen.getAllByRole('tab')[0]!.textContent).not.toContain('Tab p');
  });

  it('stops the new-tab button at the cap', () => {
    render(
      <PreviewTabStrip
        tabs={[tab('a')]}
        activeId="a"
        canReopen={false}
        atCap
        icon={() => null}
        onActivate={() => {}}
        onNew={() => {}}
        onMove={() => {}}
        onCommand={() => {}}
      />,
    );
    expect((screen.getByRole('button', { name: 'New tab' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });
});
