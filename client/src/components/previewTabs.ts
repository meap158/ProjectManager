// The Preview browser's tabs (PM-253), as plain state transitions so they are easy to test.
// What a browser's tabs do: open (next to the current one), close (and pick the neighbour), close
// the others or the ones to the right, duplicate, pin (pinned tabs sit first and are kept by "close
// others"), reorder within their group, reload, per-tab back and forward, and reopen the last closed
// tab. At least one tab always exists, there is a cap, and the open tabs survive a reload of the page.

export interface PreviewTarget {
  port: number;
  /** Always starts with "/". */
  path: string;
}

/** Pages opened in one tab, with where you are in them (back and forward). */
export interface Trail {
  stack: PreviewTarget[];
  index: number;
}

export interface PreviewTab {
  id: string;
  pinned: boolean;
  trail: Trail;
  /** Bumped to reload: it is part of the frame's key. */
  reloads: number;
  /** True from opening an address until its frame reports it has loaded. Not remembered. */
  loading: boolean;
}

export interface ClosedTab {
  target: PreviewTarget | null;
  pinned: boolean;
  index: number;
}

export interface TabsState {
  tabs: PreviewTab[];
  activeId: string;
  /** The last few closed tabs, newest first, for "Reopen closed tab". */
  closed: ClosedTab[];
}

export const MAX_TABS = 12;
const MAX_CLOSED = 10;

export const targetOf = (tab: PreviewTab): PreviewTarget | null =>
  tab.trail.stack[tab.trail.index] ?? null;

export const sameTarget = (a: PreviewTarget | null, b: PreviewTarget | null): boolean =>
  !!a && !!b && a.port === b.port && a.path === b.path;

export type TabAction =
  | { type: 'new'; target: PreviewTarget | null; afterId?: string }
  | { type: 'activate'; id: string }
  | { type: 'navigate'; id: string; target: PreviewTarget }
  | { type: 'step'; id: string; delta: -1 | 1 }
  | { type: 'reload'; id: string }
  | { type: 'loaded'; id: string }
  | { type: 'close'; id: string }
  | { type: 'closeOthers'; id: string }
  | { type: 'closeRight'; id: string }
  | { type: 'duplicate'; id: string }
  | { type: 'pin'; id: string }
  | { type: 'move'; id: string; to: number }
  | { type: 'reopen' }
  | { type: 'clear'; id: string }
  | { type: 'link'; target: PreviewTarget }
  | { type: 'restore'; state: TabsState };

function makeTab(id: string, target: PreviewTarget | null, pinned = false): PreviewTab {
  return {
    id,
    pinned,
    trail: target ? { stack: [target], index: 0 } : { stack: [], index: -1 },
    reloads: 0,
    loading: target !== null,
  };
}

export function initialTabs(target: PreviewTarget | null, id: string): TabsState {
  return { tabs: [makeTab(id, target)], activeId: id, closed: [] };
}

const pinnedCount = (tabs: PreviewTab[]) => tabs.filter((t) => t.pinned).length;

/** Where a new tab goes: right after `afterId`, but never among the pinned ones. */
function insertIndex(tabs: PreviewTab[], afterId: string | undefined): number {
  const at = afterId ? tabs.findIndex((t) => t.id === afterId) : -1;
  return Math.max(at < 0 ? tabs.length : at + 1, pinnedCount(tabs));
}

/** The tab that takes over when `removedIds` go: the neighbour on the right, else on the left. */
function neighbour(tabs: PreviewTab[], removedIds: Set<string>, from: number): string | null {
  for (let i = from + 1; i < tabs.length; i++) if (!removedIds.has(tabs[i]!.id)) return tabs[i]!.id;
  for (let i = from - 1; i >= 0; i--) if (!removedIds.has(tabs[i]!.id)) return tabs[i]!.id;
  return null;
}

/** Removes tabs, remembers them for reopening, and keeps an active tab (a blank one if none are left). */
function remove(
  state: TabsState,
  removeIds: Set<string>,
  nextActive: string | null,
  makeId: () => string,
): TabsState {
  if (removeIds.size === 0) return state;
  const closedNow: ClosedTab[] = state.tabs
    .map((tab, index) => ({ tab, index }))
    .filter(({ tab }) => removeIds.has(tab.id))
    .map(({ tab, index }) => ({ target: targetOf(tab), pinned: tab.pinned, index }))
    .reverse();
  const tabs = state.tabs.filter((t) => !removeIds.has(t.id));
  const closed = [...closedNow, ...state.closed].slice(0, MAX_CLOSED);
  if (tabs.length === 0) {
    const fresh = makeTab(makeId(), null);
    return { tabs: [fresh], activeId: fresh.id, closed };
  }
  const activeStays = !removeIds.has(state.activeId);
  const activeId = activeStays
    ? state.activeId
    : (nextActive ??
      neighbour(
        state.tabs,
        removeIds,
        state.tabs.findIndex((t) => t.id === state.activeId),
      ) ??
      tabs[0]!.id);
  return { tabs, activeId, closed };
}

/** Changes one tab. When the change leaves the tab as it was, the state is returned as it was too. */
const update = (
  state: TabsState,
  id: string,
  change: (tab: PreviewTab) => PreviewTab,
): TabsState => {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return state;
  const changed = change(tab);
  if (changed === tab) return state;
  return { ...state, tabs: state.tabs.map((t) => (t.id === id ? changed : t)) };
};

/** A reducer that takes the id generator, so tests can use a counter and the page a random id. */
export function createTabsReducer(makeId: () => string) {
  return function tabsReducer(state: TabsState, action: TabAction): TabsState {
    switch (action.type) {
      case 'restore':
        return action.state;

      case 'new': {
        if (state.tabs.length >= MAX_TABS) return state;
        const tab = makeTab(makeId(), action.target);
        const tabs = [...state.tabs];
        tabs.splice(insertIndex(tabs, action.afterId ?? state.activeId), 0, tab);
        return { ...state, tabs, activeId: tab.id };
      }

      case 'activate':
        return state.tabs.some((t) => t.id === action.id)
          ? { ...state, activeId: action.id }
          : state;

      case 'navigate':
        return update(state, action.id, (tab) => {
          // Opening the page you are already on reloads it, like pressing Enter in the address bar.
          if (sameTarget(targetOf(tab), action.target)) {
            return { ...tab, reloads: tab.reloads + 1, loading: true };
          }
          const stack = [...tab.trail.stack.slice(0, tab.trail.index + 1), action.target];
          return {
            ...tab,
            trail: { stack, index: stack.length - 1 },
            reloads: tab.reloads + 1,
            loading: true,
          };
        });

      case 'step':
        return update(state, action.id, (tab) => {
          const index = tab.trail.index + action.delta;
          if (index < 0 || index >= tab.trail.stack.length) return tab;
          return {
            ...tab,
            trail: { ...tab.trail, index },
            reloads: tab.reloads + 1,
            loading: true,
          };
        });

      case 'reload':
        return update(state, action.id, (tab) =>
          targetOf(tab) ? { ...tab, reloads: tab.reloads + 1, loading: true } : tab,
        );

      case 'loaded':
        return update(state, action.id, (tab) => (tab.loading ? { ...tab, loading: false } : tab));

      case 'close':
        return remove(state, new Set([action.id]), null, makeId);

      case 'closeOthers': {
        const ids = new Set(
          state.tabs.filter((t) => t.id !== action.id && !t.pinned).map((t) => t.id),
        );
        return remove(state, ids, action.id, makeId);
      }

      case 'closeRight': {
        const at = state.tabs.findIndex((t) => t.id === action.id);
        if (at < 0) return state;
        const ids = new Set(
          state.tabs
            .slice(at + 1)
            .filter((t) => !t.pinned)
            .map((t) => t.id),
        );
        return remove(state, ids, action.id, makeId);
      }

      case 'duplicate': {
        const source = state.tabs.find((t) => t.id === action.id);
        if (!source || state.tabs.length >= MAX_TABS) return state;
        const tab = makeTab(makeId(), targetOf(source));
        const tabs = [...state.tabs];
        tabs.splice(insertIndex(tabs, source.id), 0, tab);
        return { ...state, tabs, activeId: tab.id };
      }

      case 'pin': {
        const tab = state.tabs.find((t) => t.id === action.id);
        if (!tab) return state;
        const rest = state.tabs.filter((t) => t.id !== tab.id);
        const pinned = rest.filter((t) => t.pinned);
        const loose = rest.filter((t) => !t.pinned);
        const next = { ...tab, pinned: !tab.pinned };
        // Pinning joins the end of the pinned block; unpinning goes to the start of the others.
        return {
          ...state,
          tabs: next.pinned ? [...pinned, next, ...loose] : [...pinned, next, ...loose],
        };
      }

      case 'move': {
        const from = state.tabs.findIndex((t) => t.id === action.id);
        const tab = state.tabs[from];
        if (!tab) return state;
        const pins = pinnedCount(state.tabs);
        // A tab stays inside its own group: pinned among the pinned, the rest among the rest.
        const lo = tab.pinned ? 0 : pins;
        const hi = tab.pinned ? pins - 1 : state.tabs.length - 1;
        const to = Math.min(hi, Math.max(lo, action.to));
        if (to === from) return state;
        const tabs = [...state.tabs];
        tabs.splice(from, 1);
        tabs.splice(to, 0, tab);
        return { ...state, tabs };
      }

      case 'reopen': {
        const [last, ...closed] = state.closed;
        if (!last || state.tabs.length >= MAX_TABS) return state;
        const tab = makeTab(makeId(), last.target, last.pinned);
        const pins = pinnedCount(state.tabs);
        const lo = last.pinned ? 0 : pins;
        const hi = last.pinned ? pins : state.tabs.length;
        const at = Math.min(hi, Math.max(lo, last.index));
        const tabs = [...state.tabs];
        tabs.splice(at, 0, tab);
        return { tabs, activeId: tab.id, closed };
      }

      case 'clear':
        // Back to an empty tab, keeping the tab (on a phone this is the way back to the app list).
        return update(state, action.id, (tab) =>
          targetOf(tab) ? { ...tab, trail: { stack: [], index: -1 }, loading: false } : tab,
        );

      case 'link': {
        // An address from the page link or a list row: show it where it already is, else in the
        // active tab when that is blank, else in a tab of its own.
        const existing = state.tabs.find((t) => sameTarget(targetOf(t), action.target));
        if (existing) return { ...state, activeId: existing.id };
        const active = state.tabs.find((t) => t.id === state.activeId);
        if (active && !targetOf(active)) {
          return tabsReducer(state, { type: 'navigate', id: active.id, target: action.target });
        }
        return tabsReducer(state, { type: 'new', target: action.target });
      }
    }
  };
}

// ---- Remembered across reloads of the page (per browser; the page works without it) ----

interface Saved {
  v: 1;
  active: number;
  tabs: { pinned: boolean; target: PreviewTarget | null }[];
}

export function serializeTabs(state: TabsState): string {
  const saved: Saved = {
    v: 1,
    active: Math.max(
      0,
      state.tabs.findIndex((t) => t.id === state.activeId),
    ),
    tabs: state.tabs.map((t) => ({ pinned: t.pinned, target: targetOf(t) })),
  };
  return JSON.stringify(saved);
}

const validTarget = (value: unknown): value is PreviewTarget => {
  const t = value as Partial<PreviewTarget> | null;
  return (
    !!t &&
    Number.isInteger(t.port) &&
    t.port! >= 1024 &&
    t.port! <= 65535 &&
    typeof t.path === 'string' &&
    t.path.startsWith('/')
  );
};

/** What `serializeTabs` stored, or null when it is missing or damaged. */
export function parseTabs(raw: string | null, makeId: () => string): TabsState | null {
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Partial<Saved>;
    if (saved.v !== 1 || !Array.isArray(saved.tabs) || saved.tabs.length === 0) return null;
    const tabs = saved.tabs
      .slice(0, MAX_TABS)
      .map((t) => makeTab(makeId(), validTarget(t?.target) ? t.target : null, t?.pinned === true));
    // Pinned tabs first, whatever order was stored.
    tabs.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    const active = tabs[Math.min(Math.max(0, Number(saved.active) || 0), tabs.length - 1)]!;
    return { tabs, activeId: active.id, closed: [] };
  } catch {
    return null;
  }
}
