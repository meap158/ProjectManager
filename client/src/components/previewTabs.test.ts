import { describe, expect, it } from 'vitest';
import {
  MAX_TABS,
  createTabsReducer,
  initialTabs,
  parseTabs,
  serializeTabs,
  targetOf,
  type PreviewTarget,
  type TabAction,
  type TabsState,
} from './previewTabs';

// The Preview browser's tabs (PM-253): what a browser's tabs do, as plain state transitions.

const t = (port: number, path = '/'): PreviewTarget => ({ port, path });

function setup() {
  let n = 0;
  const makeId = () => `t${++n}`;
  const reduce = createTabsReducer(makeId);
  const run = (state: TabsState, ...actions: TabAction[]) => actions.reduce(reduce, state);
  return {
    makeId,
    reduce,
    run,
    start: (target: PreviewTarget | null = null) => initialTabs(target, makeId()),
  };
}
const ids = (s: TabsState) => s.tabs.map((x) => x.id);
const ports = (s: TabsState) => s.tabs.map((x) => targetOf(x)?.port ?? null);

describe('opening and closing', () => {
  it('opens a new tab next to the current one and switches to it', () => {
    const { run, start } = setup();
    const s = run(start(t(3000)), { type: 'new', target: null }, { type: 'new', target: t(4000) });
    expect(s.tabs).toHaveLength(3);
    expect(s.activeId).toBe(s.tabs[2]!.id);
    expect(ports(s)).toEqual([3000, null, 4000]);
    const mid = run(s, { type: 'activate', id: s.tabs[0]!.id }, { type: 'new', target: t(5000) });
    expect(ports(mid)).toEqual([3000, 5000, null, 4000]);
  });

  it('stops at the cap', () => {
    const { run, start } = setup();
    let s = start();
    for (let i = 0; i < MAX_TABS + 3; i++) s = run(s, { type: 'new', target: null });
    expect(s.tabs).toHaveLength(MAX_TABS);
  });

  it('closes a tab and hands over to its right neighbour, else the left one', () => {
    const { run, start } = setup();
    let s = run(start(t(3000)), { type: 'new', target: t(4000) }, { type: 'new', target: t(5000) });
    const [a, b, c] = ids(s) as [string, string, string];
    s = run(s, { type: 'activate', id: b }, { type: 'close', id: b });
    expect(s.activeId).toBe(c);
    s = run(s, { type: 'close', id: c });
    expect(s.activeId).toBe(a);
    // Closing a tab that is not active leaves the active one alone.
    s = run(s, { type: 'new', target: t(6000) }, { type: 'activate', id: a });
    s = run(s, { type: 'close', id: s.tabs[1]!.id });
    expect(s.activeId).toBe(a);
  });

  it('always keeps one tab: closing the last leaves a blank one', () => {
    const { run, start } = setup();
    const s0 = start(t(3000));
    const s = run(s0, { type: 'close', id: s0.tabs[0]!.id });
    expect(s.tabs).toHaveLength(1);
    expect(targetOf(s.tabs[0]!)).toBeNull();
    expect(s.activeId).toBe(s.tabs[0]!.id);
  });

  it('closes the others (keeping pinned ones) or the ones to the right', () => {
    const { run, start } = setup();
    let s = run(
      start(t(1111)),
      { type: 'new', target: t(2222) },
      { type: 'new', target: t(3333) },
      { type: 'new', target: t(4444) },
    );
    s = run(s, { type: 'pin', id: s.tabs[0]!.id });
    const second = s.tabs[1]!.id;
    const right = run(s, { type: 'closeRight', id: second });
    expect(ports(right)).toEqual([1111, 2222]);
    expect(right.activeId).toBe(second);
    const others = run(s, { type: 'closeOthers', id: s.tabs[2]!.id });
    expect(ports(others)).toEqual([1111, 3333]);
    expect(others.activeId).toBe(s.tabs[2]!.id);
  });

  it('reopens closed tabs, newest first, where they were', () => {
    const { run, start } = setup();
    let s = run(start(t(1111)), { type: 'new', target: t(2222) }, { type: 'new', target: t(3333) });
    s = run(s, { type: 'close', id: s.tabs[1]!.id }, { type: 'close', id: s.tabs[0]!.id });
    expect(ports(s)).toEqual([3333]);
    s = run(s, { type: 'reopen' });
    expect(ports(s)).toEqual([1111, 3333]);
    expect(targetOf(s.tabs.find((x) => x.id === s.activeId)!)?.port).toBe(1111);
    s = run(s, { type: 'reopen' });
    expect(ports(s)).toEqual([1111, 2222, 3333]);
    expect(run(s, { type: 'reopen' })).toBe(s);
  });
});

describe('inside a tab', () => {
  it('walks back and forward through the pages opened in it', () => {
    const { run, start } = setup();
    let s = start(t(3000));
    const id = s.tabs[0]!.id;
    s = run(
      s,
      { type: 'navigate', id, target: t(4000) },
      { type: 'navigate', id, target: t(5000) },
    );
    expect(targetOf(s.tabs[0]!)?.port).toBe(5000);
    s = run(s, { type: 'step', id, delta: -1 }, { type: 'step', id, delta: -1 });
    expect(targetOf(s.tabs[0]!)?.port).toBe(3000);
    expect(run(s, { type: 'step', id, delta: -1 })).toBe(s);
    s = run(s, { type: 'step', id, delta: 1 });
    expect(targetOf(s.tabs[0]!)?.port).toBe(4000);
    // Opening something new from the middle drops the forward pages.
    s = run(s, { type: 'navigate', id, target: t(6000) });
    expect(s.tabs[0]!.trail.stack.map((x) => x.port)).toEqual([3000, 4000, 6000]);
  });

  it('reloads instead of piling up when you open the page you are already on', () => {
    const { run, start } = setup();
    const s0 = start(t(3000));
    const id = s0.tabs[0]!.id;
    const s = run(s0, { type: 'loaded', id }, { type: 'navigate', id, target: t(3000) });
    expect(s.tabs[0]!.trail.stack).toHaveLength(1);
    expect(s.tabs[0]!.reloads).toBe(1);
    expect(s.tabs[0]!.loading).toBe(true);
  });

  it('tracks loading per tab', () => {
    const { run, start } = setup();
    let s = run(start(t(3000)), { type: 'new', target: t(4000) });
    const [a, b] = ids(s) as [string, string];
    s = run(s, { type: 'loaded', id: a });
    expect(s.tabs.map((x) => x.loading)).toEqual([false, true]);
    s = run(s, { type: 'reload', id: a });
    expect(s.tabs.map((x) => x.loading)).toEqual([true, true]);
    expect(run(s, { type: 'reload', id: 'missing' })).toBe(s);
    const blank = run(start(), { type: 'reload', id: 'nope' });
    expect(blank.tabs[0]!.reloads).toBe(0);
    expect(b).toBeTruthy();
  });

  it('duplicates a tab with the page it is on', () => {
    const { run, start } = setup();
    let s = start(t(3000));
    const id = s.tabs[0]!.id;
    s = run(s, { type: 'navigate', id, target: t(4000) }, { type: 'duplicate', id });
    expect(ports(s)).toEqual([4000, 4000]);
    expect(s.activeId).toBe(s.tabs[1]!.id);
    expect(s.tabs[1]!.trail.stack).toHaveLength(1);
  });
});

describe('pinning and order', () => {
  it('keeps pinned tabs first, and new tabs never open among them', () => {
    const { run, start } = setup();
    let s = run(start(t(1111)), { type: 'new', target: t(2222) }, { type: 'new', target: t(3333) });
    s = run(s, { type: 'pin', id: s.tabs[2]!.id });
    expect(ports(s)).toEqual([3333, 1111, 2222]);
    expect(s.tabs[0]!.pinned).toBe(true);
    s = run(s, { type: 'activate', id: s.tabs[0]!.id }, { type: 'new', target: t(4444) });
    expect(ports(s)).toEqual([3333, 4444, 1111, 2222]);
    s = run(s, { type: 'pin', id: s.tabs[0]!.id });
    expect(s.tabs.map((x) => x.pinned)).toEqual([false, false, false, false]);
  });

  it('moves a tab within its own group only', () => {
    const { run, start } = setup();
    let s = run(
      start(t(1111)),
      { type: 'new', target: t(2222) },
      { type: 'new', target: t(3333) },
      { type: 'new', target: t(4444) },
    );
    s = run(s, { type: 'pin', id: s.tabs[0]!.id }); // 1111 pinned and first
    s = run(s, { type: 'move', id: s.tabs[3]!.id, to: 0 });
    expect(ports(s)).toEqual([1111, 4444, 2222, 3333]);
    s = run(s, { type: 'move', id: s.tabs[0]!.id, to: 3 });
    expect(ports(s)).toEqual([1111, 4444, 2222, 3333]);
    s = run(s, { type: 'move', id: s.tabs[1]!.id, to: 2 });
    expect(ports(s)).toEqual([1111, 2222, 4444, 3333]);
  });

  it('keeps a reopened pinned tab pinned and first', () => {
    const { run, start } = setup();
    let s = run(start(t(1111)), { type: 'new', target: t(2222) });
    s = run(
      s,
      { type: 'pin', id: s.tabs[0]!.id },
      { type: 'close', id: s.tabs[0]!.id },
      { type: 'reopen' },
    );
    expect(ports(s)).toEqual([1111, 2222]);
    expect(s.tabs[0]!.pinned).toBe(true);
  });
});

describe('addresses from the page link or the list', () => {
  it('shows an open page where it already is', () => {
    const { run, start } = setup();
    const s = run(
      start(t(3000)),
      { type: 'new', target: t(4000) },
      { type: 'link', target: t(3000) },
    );
    expect(s.tabs).toHaveLength(2);
    expect(s.activeId).toBe(s.tabs[0]!.id);
  });
  it('fills a blank active tab, else opens a new one', () => {
    const { run, start } = setup();
    const filled = run(start(), { type: 'link', target: t(3000) });
    expect(ports(filled)).toEqual([3000]);
    const added = run(filled, { type: 'link', target: t(4000) });
    expect(ports(added)).toEqual([3000, 4000]);
  });
});

describe('remembering tabs', () => {
  it('round-trips the open pages, pins and the active tab', () => {
    const { run, start, makeId } = setup();
    let s = run(
      start(t(3000, '/a')),
      { type: 'new', target: t(4000) },
      { type: 'new', target: null },
    );
    s = run(s, { type: 'pin', id: s.tabs[1]!.id }, { type: 'activate', id: s.tabs[1]!.id });
    const back = parseTabs(serializeTabs(s), makeId)!;
    expect(back.tabs.map((x) => [targetOf(x)?.port ?? null, x.pinned])).toEqual([
      [4000, true],
      [3000, false],
      [null, false],
    ]);
    expect(back.activeId).toBe(back.tabs[0]!.id);
    expect(back.tabs[1]!.loading).toBe(true);
  });

  it('ignores anything damaged or hostile', () => {
    const { makeId } = setup();
    expect(parseTabs(null, makeId)).toBeNull();
    expect(parseTabs('not json', makeId)).toBeNull();
    expect(parseTabs('{"v":2,"tabs":[]}', makeId)).toBeNull();
    const odd = parseTabs(
      JSON.stringify({
        v: 1,
        active: 99,
        tabs: [
          { pinned: false, target: { port: 80, path: 'x' } },
          { target: { port: 3000, path: '/' } },
        ],
      }),
      makeId,
    )!;
    expect(odd.tabs.map((x) => targetOf(x))).toEqual([null, { port: 3000, path: '/' }]);
    expect(odd.activeId).toBe(odd.tabs[1]!.id);
  });
});

describe('clearing a tab', () => {
  it('empties the tab but keeps it, which is the phone way back to the app list', () => {
    const { run, start } = setup();
    const s0 = start(t(3000));
    const id = s0.tabs[0]!.id;
    const s = run(s0, { type: 'clear', id });
    expect(s.tabs).toHaveLength(1);
    expect(targetOf(s.tabs[0]!)).toBeNull();
    expect(s.tabs[0]!.loading).toBe(false);
    expect(run(s, { type: 'clear', id })).toBe(s);
  });
});
