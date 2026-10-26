import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import type { LocalApp, PreviewLaunch, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { ConfirmDelete } from './ConfirmDelete';
import { ContextMenu, type ContextMenuItem } from './ContextMenu';
import { Dropdown } from './Dropdown';
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookmarkIcon,
  GlobeIcon,
  RefreshIcon,
  MoreVerticalIcon,
} from './icons';
import { LoadingMark } from './LoadingMark';
import { PreviewPickDialog, parsePicked, type PickedElement } from './PreviewPickDialog';
import { PreviewTabStrip, type StripTab, type TabCommand } from './PreviewTabStrip';
import {
  MAX_TABS,
  createTabsReducer,
  initialTabs,
  parseTabs,
  serializeTabs,
  targetOf,
  type PreviewTarget,
  type TabsState,
} from './previewTabs';
import './project-preview.css';

// Preview (PM-253, docs/BUILT-IN-BROWSER.md): a dev server on this computer's localhost, shown
// through the server's read-only /api/preview proxy so it also works from a phone or the remote
// listener. A list of apps beside a small browser: tabs, back / forward / reload, one
// address field and a bookmark, like the built-in browser in Claude's desktop app. On phones it is
// the list or the browser, with an "Apps" button back. It is a global page (top bar Preview), not
// a project tab: a dev server is not owned by one project. The page runs in a sandbox WITHOUT
// allow-same-origin, so it gets an opaque origin and cannot reach this app's API or cookies. Never
// offer "open in a new tab" for the proxied address: a top-level tab would run it as this origin.
//
// The list refreshes every 5 s while the page is open and visible (paused in a background tab),
// and the refresh button reads the machine right now. Sections fold and the sort is remembered
// per browser (localStorage; the page works without it).

export type { PreviewTarget };

/** Reads "3000", ":3000/docs", "localhost:3000/a?b=1" or "http://127.0.0.1:3000/"; null if not one. */
export function parsePreviewTarget(input: string): PreviewTarget | null {
  const match =
    /^\s*(?:https?:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])?:?(\d{4,5})(\/[^\s]*)?\s*$/i.exec(
      input,
    );
  if (!match) return null;
  const port = Number(match[1]);
  if (port < 1024 || port > 65535) return null;
  return { port, path: match[2] ?? '/' };
}

/** The read-only path mode: an address under this app (LAN, remote, any host but this computer). */
export const previewSrc = (t: PreviewTarget) => `/api/preview/${t.port}${t.path}`;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Where the frame loads from and what it may do. Opened on this computer, the app gets its own
 * origin (`p<port>.localhost`): root-absolute URLs, cookies, forms and live-reload sockets work
 * as on its own port, and it is a different origin from this app, so it cannot reach this app.
 * Anywhere else (a phone on the LAN, the remote listener) there is no such host name, so it is
 * the read-only path mode in a sandbox with no origin of its own.
 */
export function previewFrame(
  target: PreviewTarget,
  loc: Pick<Location, 'protocol' | 'hostname' | 'port'> = window.location,
): { src: string; sandbox: string; ownOrigin: boolean } {
  if (loc.protocol === 'http:' && LOCAL_HOSTS.has(loc.hostname)) {
    const port = loc.port ? `:${loc.port}` : '';
    return {
      src: `http://p${target.port}.localhost${port}${target.path}`,
      sandbox: 'allow-scripts allow-forms allow-popups allow-modals allow-same-origin',
      ownOrigin: true,
    };
  }
  return {
    src: previewSrc(target),
    sandbox: 'allow-scripts allow-forms allow-popups',
    ownOrigin: false,
  };
}

/** How an address reads in the address field. */
export const targetText = (t: PreviewTarget) =>
  `localhost:${t.port}${t.path === '/' ? '' : t.path}`;
const POLL_MS = 5000;
/** How long "Stopped …" stays up. */
const STOPPED_NOTE_MS = 4000;
/** A page title can be a whole sentence; the note names the app briefly and the port exactly. */
const NOTE_NAME_MAX = 28;

export function stoppedNote(name: string, port: number): string {
  const clean = name.replace(/\s+/g, ' ').trim();
  const short =
    clean.length > NOTE_NAME_MAX ? `${clean.slice(0, NOTE_NAME_MAX - 1).trimEnd()}…` : clean;
  return `Stopped ${short || 'the app'} (:${port}).`;
}

export type PreviewSort = 'port' | 'name' | 'name-desc' | 'project';
export const PREVIEW_SORTS: { value: PreviewSort; label: string }[] = [
  { value: 'port', label: 'Port, low to high' },
  { value: 'name', label: 'Name A–Z' },
  { value: 'name-desc', label: 'Name Z–A' },
  { value: 'project', label: 'Project A–Z' },
];

/** The app's display name: its page title, else the project, else the program. */
export function appName(app: LocalApp, projects: ReadonlyMap<number, string>): string {
  const project = app.projectId !== null ? projects.get(app.projectId) : null;
  return app.title ?? project ?? (app.name.replace(/\.exe$/i, '') || 'app');
}

/** A sorted copy; ties fall back to the port so the order never jumps between refreshes. */
export function sortApps(
  apps: LocalApp[],
  sort: PreviewSort,
  projects: ReadonlyMap<number, string> = new Map(),
): LocalApp[] {
  const text = (value: string) => value.toLocaleLowerCase();
  const name = (a: LocalApp) => text(appName(a, projects));
  const project = (a: LocalApp) => text((a.projectId !== null && projects.get(a.projectId)) || '');
  const byPort = (a: LocalApp, b: LocalApp) => a.port - b.port;
  const compare: Record<PreviewSort, (a: LocalApp, b: LocalApp) => number> = {
    port: byPort,
    name: (a, b) => name(a).localeCompare(name(b)) || byPort(a, b),
    'name-desc': (a, b) => name(b).localeCompare(name(a)) || byPort(a, b),
    project: (a, b) =>
      project(a).localeCompare(project(b)) || name(a).localeCompare(name(b)) || byPort(a, b),
  };
  return [...apps].sort(compare[sort]);
}

export type PreviewGroupId = 'apps' | 'services' | 'other';

/** A front end: it answers "/" with a web page. Having an icon also counts, which keeps this right
 * against a server that predates the `web` field. */
function isWebApp(a: LocalApp): boolean {
  return a.web || !!a.icon;
}

/**
 * Your projects' running apps in two groups, the way a dev stack falls out: a server that serves a
 * page with an icon is the front end you open in a browser ("Apps", first); one without is usually
 * an API or back end ("Services"). Anything not started from one of your projects, mostly system
 * services, comes last. Each group is in the chosen order.
 */
export function groupApps(
  apps: LocalApp[],
  sort: PreviewSort = 'port',
  projects: ReadonlyMap<number, string> = new Map(),
): { id: PreviewGroupId; heading: string; hint: string; apps: LocalApp[] }[] {
  const sorted = sortApps(apps, sort, projects);
  const mine = sorted.filter((a) => a.projectId !== null);
  return [
    {
      id: 'apps' as const,
      heading: 'Apps',
      hint: 'From your projects, serving a web page: the front end',
      apps: mine.filter(isWebApp),
    },
    {
      id: 'services' as const,
      heading: 'Services',
      hint: 'From your projects, no web page: usually an API or back end',
      apps: mine.filter((a) => !isWebApp(a)),
    },
    {
      id: 'other' as const,
      heading: 'Other on this computer',
      hint: 'Not started from one of your projects',
      apps: sorted.filter((a) => a.projectId === null),
    },
  ].filter((g) => g.apps.length > 0);
}

type GroupKey = PreviewGroupId | 'saved';

/** Your projects' apps are what you came for; the rest is mostly system services, so it starts
 * closed. When nothing belongs to a project, it opens instead so the list is never just a closed
 * heading. A choice the person made always wins. */
export function isGroupOpen(
  id: GroupKey,
  chosen: Partial<Record<GroupKey, boolean>>,
  hasProjectApps: boolean,
): boolean {
  return chosen[id] ?? (id === 'other' ? !hasProjectApps : true);
}

const SORT_KEY = 'pm-preview-sort';
const OPEN_KEY = 'pm-preview-open';

function readSort(): PreviewSort {
  try {
    const saved = localStorage.getItem(SORT_KEY);
    if (PREVIEW_SORTS.some((s) => s.value === saved)) return saved as PreviewSort;
  } catch {
    // Storage unavailable: the default sort.
  }
  return 'port';
}

function readOpen(): Partial<Record<GroupKey, boolean>> {
  try {
    const saved = JSON.parse(localStorage.getItem(OPEN_KEY) ?? 'null') as Record<
      string,
      unknown
    > | null;
    const out: Partial<Record<GroupKey, boolean>> = {};
    for (const key of ['apps', 'services', 'other', 'saved'] as const) {
      if (typeof saved?.[key] === 'boolean') out[key] = saved[key];
    }
    return out;
  } catch {
    return {};
  }
}

function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Remembering is a convenience only.
  }
}

/** The app's own icon through the proxy, over a lettered tile that shows until it has loaded (or
 * when the app has no icon), so a row never has a blank where its icon should be. */
function AppIcon({ app, label }: { app: LocalApp; label: string }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const showImage = !!app.icon && state !== 'failed';
  return (
    <span className="preview-icon preview-icon-wrap" aria-hidden="true">
      {state !== 'loaded' && (
        <span className="preview-icon-fallback">{label.slice(0, 1).toUpperCase()}</span>
      )}
      {showImage && (
        <img
          className={`preview-icon-img${state === 'loaded' ? ' is-loaded' : ''}`}
          src={app.icon!.startsWith('data:') ? app.icon! : `/api/preview/${app.port}${app.icon}`}
          alt=""
          onLoad={() => setState('loaded')}
          onError={() => setState('failed')}
        />
      )}
    </span>
  );
}

/** A section heading that folds its rows, with the row count beside it. */
function GroupHead({
  title,
  hint,
  count,
  open,
  onToggle,
}: {
  title: string;
  hint?: string;
  count: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <h3 className="preview-group-title">
      <button
        type="button"
        className="preview-group-head"
        aria-expanded={open}
        title={hint}
        onClick={onToggle}
      >
        <span className="preview-chevron" aria-hidden="true">
          ▸
        </span>
        <span className="preview-group-name">{title}</span>
        <span className="preview-group-count">{count}</span>
      </button>
    </h3>
  );
}

const TABS_KEY = 'pm-preview-tabs';
const makeId = () => `t${Math.random().toString(36).slice(2, 9)}`;
const tabsReducer = createTabsReducer(makeId);

function startTabs(link: PreviewTarget | null): TabsState {
  let saved: TabsState | null = null;
  try {
    saved = parseTabs(localStorage.getItem(TABS_KEY), makeId);
  } catch {
    // Storage unavailable: start with one blank tab.
  }
  const base = saved ?? initialTabs(null, makeId());
  return link ? tabsReducer(base, { type: 'link', target: link }) : base;
}

const addressOf = (t: PreviewTarget) => `http://localhost:${t.port}${t.path}`;

type AppCommand = 'open' | 'open-tab' | 'copy' | 'project' | 'stop';

/** The menu on a listed app (PM-270): open it, copy its address, go to its project, or stop it. */
export function appMenuItems(app: LocalApp): ContextMenuItem<AppCommand>[] {
  return [
    { command: 'open', label: 'Open' },
    { command: 'open-tab', label: 'Open in new tab' },
    { command: 'copy', label: 'Copy address', divider: true },
    ...(app.projectId !== null ? [{ command: 'project' as const, label: 'Go to project' }] : []),
    { command: 'stop', label: 'Stop process…', divider: true },
  ];
}

export function PreviewWorkspace() {
  const [params, setParams] = useSearchParams();
  const [state, dispatch] = useReducer(tabsReducer, undefined, () =>
    startTabs(parsePreviewTarget(params.get('preview') ?? '')),
  );
  const active = state.tabs.find((t) => t.id === state.activeId) ?? state.tabs[0]!;
  const target = targetOf(active);
  // What is typed in the address field. Switching tabs drops it (the id no longer matches).
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null);
  const text = draft?.id === active.id ? draft.text : target ? targetText(target) : '';
  const [error, setError] = useState<string | null>(null);
  /**
   * Phones show the list or the page, one at a time. "Apps" shows the list while the page stays
   * loaded behind it (it used to empty the tab, losing its place); opening something, or "Page",
   * shows the page again. Desktop always shows both, so this never applies there.
   */
  const [listing, setListing] = useState(false);
  const [apps, setApps] = useState<LocalApp[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [launches, setLaunches] = useState<PreviewLaunch[]>([]);
  const [projects, setProjects] = useState<Map<number, string>>(new Map());
  const [sort, setSortState] = useState<PreviewSort>(readSort);
  const [chosenOpen, setChosenOpen] = useState(readOpen);
  const [appMenu, setAppMenu] = useState<{
    app: LocalApp;
    x: number;
    y: number;
    anchor?: HTMLElement;
  } | null>(null);
  const [listNote, setListNote] = useState<{ text: string; error: boolean } | null>(null);
  // A confirmation fades on its own; an error stays until the next action.
  useEffect(() => {
    if (!listNote || listNote.error) return;
    const timer = setTimeout(() => setListNote(null), STOPPED_NOTE_MS);
    return () => clearTimeout(timer);
  }, [listNote]);
  const navigate = useNavigate();
  const addressRef = useRef<HTMLInputElement>(null);
  const focusAddress = useRef(false);
  const closeAppMenu = useCallback(() => setAppMenu(null), []);

  const load = useCallback((fresh = false) => {
    setRefreshing(true);
    return api
      .localApps(fresh)
      .then((r) => setApps(r.apps))
      .catch(() => undefined)
      .finally(() => {
        setLoaded(true);
        setRefreshing(false);
      });
  }, []);

  // Detected apps change as servers start and stop. Poll while the page is visible; a background
  // tab stops asking, and coming back refreshes at once.
  useEffect(() => {
    const tick = () => {
      if (!document.hidden) void load();
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [load]);
  useEffect(() => {
    void api
      .previewLaunches()
      .then((r) => setLaunches(r.launches))
      .catch(() => undefined);
    void api
      .listProjects()
      .then((list: ProjectSummary[]) => setProjects(new Map(list.map((p) => [p.id, p.name]))))
      .catch(() => undefined);
  }, []);

  // The open tabs survive a reload of the page (per browser).
  useEffect(() => {
    remember(TABS_KEY, serializeTabs(state));
  }, [state]);

  // The link always shows the page in the active tab, and a new blank tab starts in the address field.
  const targetKey = target ? `${target.port}${target.path}` : '';
  useEffect(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (targetKey) next.set('preview', targetKey);
        else next.delete('preview');
        return next;
      },
      { replace: true },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey]);
  useEffect(() => {
    if (focusAddress.current && !targetOf(active)) addressRef.current?.focus();
    focusAddress.current = false;
  }, [active]);

  const setSort = (next: PreviewSort) => {
    setSortState(next);
    remember(SORT_KEY, next);
  };

  /** Opens an address: in the active tab, or in a tab of its own (Ctrl, ⌘ or middle click). */
  const open = (next: PreviewTarget, inNewTab = false) => {
    setDraft(null);
    setError(null);
    setListing(false);
    if (inNewTab) dispatch({ type: 'new', target: next });
    else dispatch({ type: 'navigate', id: active.id, target: next });
  };
  const newTab = (afterId?: string) => {
    focusAddress.current = true;
    dispatch({ type: 'new', target: null, afterId });
  };
  const step = (delta: -1 | 1) => {
    setDraft(null);
    setError(null);
    dispatch({ type: 'step', id: active.id, delta });
  };

  const go = (event: FormEvent) => {
    event.preventDefault();
    const next = parsePreviewTarget(text);
    if (!next) {
      setError('Enter a localhost port between 1024 and 65535, like 3000 or localhost:5173/docs.');
      return;
    }
    open(next);
  };

  const persist = (next: PreviewLaunch[]) => {
    const before = launches;
    setLaunches(next);
    api.savePreviewLaunches(next).catch((e: Error) => {
      setLaunches(before);
      setError(e.message);
    });
  };
  const saved = target
    ? launches.find((l) => l.port === target.port && l.path === target.path)
    : undefined;
  const running = target ? apps.find((a) => a.port === target.port) : undefined;
  const toggleSaved = () => {
    if (!target) return;
    if (saved) {
      persist(launches.filter((l) => l !== saved));
      return;
    }
    const name = (running ? appName(running, projects) : null) ?? `localhost:${target.port}`;
    persist([
      ...launches,
      { name, port: target.port, path: target.path, projectId: running?.projectId ?? null },
    ]);
  };

  const groups = useMemo(() => groupApps(apps, sort, projects), [apps, sort, projects]);
  const hasProjectApps = groups.some((g) => g.id !== 'other');
  const groupOpen = (id: GroupKey) => isGroupOpen(id, chosenOpen, hasProjectApps);
  const toggleGroup = (id: GroupKey) => {
    setChosenOpen((prev) => {
      const next = { ...prev, [id]: !isGroupOpen(id, prev, hasProjectApps) };
      remember(OPEN_KEY, JSON.stringify(next));
      return next;
    });
  };
  const sortedLaunches = useMemo(() => {
    const text = (v: string) => v.toLocaleLowerCase();
    return [...launches].sort((a, b) =>
      sort === 'port'
        ? a.port - b.port
        : sort === 'name-desc'
          ? text(b.name).localeCompare(text(a.name))
          : text(a.name).localeCompare(text(b.name)) || a.port - b.port,
    );
  }, [launches, sort]);

  // What each tab shows in the strip: the app's own title and icon, else its address.
  const stripTabs: StripTab[] = state.tabs.map((tab) => {
    const t = targetOf(tab);
    const app = t ? apps.find((a) => a.port === t.port) : undefined;
    return {
      id: tab.id,
      title: !t ? 'New tab' : app ? appName(app, projects) : `localhost:${t.port}`,
      pinned: tab.pinned,
      loading: tab.loading,
      blank: !t,
      address: t ? addressOf(t) : null,
    };
  });
  const appOfTab = new Map(
    state.tabs.flatMap((tab) => {
      const t = targetOf(tab);
      const app = t ? apps.find((a) => a.port === t.port) : undefined;
      return app ? [[tab.id, app] as const] : [];
    }),
  );

  const runCommand = (command: TabCommand, id: string) => {
    const index = state.tabs.findIndex((t) => t.id === id);
    const tab = state.tabs[index];
    if (!tab) return;
    if (command === 'new-right') newTab(id);
    else if (command === 'reload') dispatch({ type: 'reload', id });
    else if (command === 'duplicate') dispatch({ type: 'duplicate', id });
    else if (command === 'pin') dispatch({ type: 'pin', id });
    else if (command === 'reopen') dispatch({ type: 'reopen' });
    else if (command === 'close') dispatch({ type: 'close', id });
    else if (command === 'close-others') dispatch({ type: 'closeOthers', id });
    else if (command === 'close-right') dispatch({ type: 'closeRight', id });
    else if (command === 'move-left') dispatch({ type: 'move', id, to: index - 1 });
    else if (command === 'move-right') dispatch({ type: 'move', id, to: index + 1 });
    else if (command === 'copy') {
      const t = targetOf(tab);
      // Clipboard access can be refused (it needs a secure page and a gesture): then nothing happens.
      if (t) void navigator.clipboard?.writeText(addressOf(t)).catch(() => undefined);
    }
  };

  const frame = target ? previewFrame(target) : null;

  // Element picker (PM-311): the page's injected picker reports one element, which the dialog
  // sends to a session. Messages count only from the shown tab's frame and only while picking.
  // A pick belongs to the tab and page it began on: switching either ends it.
  const pickKey = `${active.id}|${target?.port}|${target?.path}`;
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const picking = pickingFor === pickKey;
  const setPicking = (on: boolean) => setPickingFor(on ? pickKey : null);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const activeFrame = () =>
    document.getElementById(`preview-panel-${active.id}`) as HTMLIFrameElement | null;
  const tellPicker = (type: 'start' | 'stop') =>
    activeFrame()?.contentWindow?.postMessage({ pmPicker: true, type }, '*');
  useEffect(() => {
    if (!picking) return;
    const onMessage = (event: globalThis.MessageEvent) => {
      if (event.source !== activeFrame()?.contentWindow) return;
      const data = event.data as { pmPicker?: unknown; type?: unknown; element?: unknown } | null;
      if (!data || data.pmPicker !== true) return;
      if (data.type === 'cancelled') setPicking(false);
      if (data.type !== 'picked') return;
      setPicking(false);
      const element = parsePicked(data.element);
      if (element) setPicked(element);
      else setError('The page sent something that is not an element.');
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      tellPicker('stop');
      setPicking(false);
    };
    window.addEventListener('message', onMessage);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('keydown', onKey);
    };
    // The frame is looked up when a message arrives; the shown tab is part of the key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking, active.id]);
  const pickedApp = target ? (apps.find((a) => a.port === target.port) ?? null) : null;

  /** A click opens in the active tab; Ctrl, ⌘ or a middle click opens a new tab, like a link. */
  const rowOpen = (next: PreviewTarget) => ({
    onClick: (event: MouseEvent) => open(next, event.ctrlKey || event.metaKey),
    onAuxClick: (event: MouseEvent) => {
      if (event.button === 1) {
        event.preventDefault();
        open(next, true);
      }
    },
  });

  const stopApp = async (app: LocalApp, name: string) => {
    setListNote(null);
    try {
      await api.stopLocalApp(app.port, app.pid);
      setListNote({ text: stoppedNote(name, app.port), error: false });
    } catch (e) {
      setListNote({ text: e instanceof Error ? e.message : 'Could not stop it', error: true });
    }
    await load(true);
  };
  /** The hidden confirmation trigger is invoked only after choosing Stop from the menu. */
  const askStop = (app: LocalApp) =>
    document
      .querySelector<HTMLButtonElement>(`[data-stop="${app.port}:${app.pid}"] button`)
      ?.click();
  const runAppCommand = (command: AppCommand, app: LocalApp) => {
    const next = { port: app.port, path: '/' };
    if (command === 'open') open(next);
    else if (command === 'open-tab') open(next, true);
    else if (command === 'copy')
      void navigator.clipboard
        ?.writeText(`http://localhost:${app.port}/`)
        .then(() => setListNote({ text: `Copied http://localhost:${app.port}/`, error: false }));
    else if (command === 'project' && app.projectId !== null)
      navigate(`/projects/${app.projectId}`);
    else if (command === 'stop') askStop(app);
  };
  const rowMenu = (app: LocalApp) => ({
    onContextMenu: (event: MouseEvent) => {
      event.preventDefault();
      setAppMenu({ app, x: event.clientX, y: event.clientY });
    },
    onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      setAppMenu({ app, x: box.left + 16, y: box.bottom });
    },
  });

  return (
    <div
      className={`project-preview${target && !listing ? ' has-target' : ''}${
        target && listing ? ' is-listing' : ''
      }`}
    >
      <section className="panel preview-list-panel" aria-label="Local apps">
        <div className="preview-list-tools">
          <Dropdown
            label="Sort apps"
            value={sort}
            options={PREVIEW_SORTS}
            onChange={(value) => setSort(value as PreviewSort)}
          />
          <button
            type="button"
            className={`btn btn-sm btn-icon preview-refresh${refreshing ? ' is-spinning' : ''}`}
            onClick={() => void load(true)}
            aria-label="Refresh the list of apps"
            title="Look again now. The list also refreshes every 5 seconds while this page is open."
          >
            <RefreshIcon />
          </button>
        </div>
        {listNote && (
          <p
            className={
              listNote.error ? 'error-banner preview-list-note' : 'faint preview-list-note'
            }
            role={listNote.error ? 'alert' : 'status'}
          >
            {listNote.text}
          </p>
        )}
        {appMenu && (
          <ContextMenu
            anchor={appMenu.anchor}
            x={appMenu.x}
            y={appMenu.y}
            label={`${appName(appMenu.app, projects)} actions`}
            items={appMenuItems(appMenu.app)}
            onPick={(command) => {
              const app = appMenu.app;
              setAppMenu(null);
              runAppCommand(command, app);
            }}
            onClose={closeAppMenu}
          />
        )}
        {groups.map((group) => (
          <div key={group.id} className="preview-group">
            <GroupHead
              title={group.heading}
              hint={group.hint}
              count={group.apps.length}
              open={groupOpen(group.id)}
              onToggle={() => toggleGroup(group.id)}
            />
            {groupOpen(group.id) && (
              <ul className="preview-rows">
                {group.apps.map((app) => {
                  const name = appName(app, projects);
                  const project = app.projectId !== null ? projects.get(app.projectId) : null;
                  return (
                    <li key={`${app.port}:${app.pid}`} className="preview-app">
                      <button
                        type="button"
                        className={`preview-row${target?.port === app.port ? ' is-active' : ''}`}
                        {...rowOpen({ port: app.port, path: '/' })}
                        {...rowMenu(app)}
                        title={[
                          project,
                          app.command || app.name,
                          'Ctrl-click: new tab · right click or Shift+F10: more',
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      >
                        <AppIcon app={app} label={name} />
                        <span className="preview-row-text">
                          <span className="preview-row-name">{name}</span>
                          <span className="preview-row-sub">:{app.port}</span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-icon preview-app-actions"
                        aria-label={`Actions for ${name}`}
                        title={`Actions for ${name}`}
                        aria-haspopup="menu"
                        aria-expanded={
                          appMenu?.app.port === app.port && appMenu.app.pid === app.pid
                        }
                        data-app-actions={`${app.port}:${app.pid}`}
                        onClick={(event) => {
                          if (appMenu?.app.port === app.port && appMenu.app.pid === app.pid) {
                            setAppMenu(null);
                            return;
                          }
                          const box = event.currentTarget.getBoundingClientRect();
                          setAppMenu({
                            app,
                            x: box.right,
                            y: box.bottom,
                            anchor: event.currentTarget,
                          });
                        }}
                      >
                        <MoreVerticalIcon size={15} />
                      </button>
                      <span data-stop={`${app.port}:${app.pid}`}>
                        <ConfirmDelete
                          small
                          hideTrigger
                          onDismiss={() =>
                            document
                              .querySelector<HTMLButtonElement>(
                                `[data-app-actions="${app.port}:${app.pid}"]`,
                              )
                              ?.focus()
                          }
                          label={`Stop ${name}`}
                          heading={`Stop ${name}?`}
                          message={`This ends process ${app.pid}${app.name ? ` (${app.name})` : ''} listening on port ${app.port}, and the processes it started. Unsaved work in that app is lost.${app.command ? ` Command: ${app.command}` : ''}`}
                          confirmLabel="Stop process"
                          onConfirm={() => stopApp(app, name)}
                        />
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ))}
        {groups.length === 0 && (
          <p className="faint preview-empty">
            {loaded
              ? 'No local apps found. Start a dev server and it appears here.'
              : 'Looking for local apps…'}
          </p>
        )}
        {sortedLaunches.length > 0 && (
          <div className="preview-group">
            <GroupHead
              title="Quick launches"
              hint="Addresses you saved"
              count={sortedLaunches.length}
              open={groupOpen('saved')}
              onToggle={() => toggleGroup('saved')}
            />
            {groupOpen('saved') && (
              <ul className="preview-rows">
                {sortedLaunches.map((l) => (
                  <li key={`${l.port}${l.path}`} className="preview-saved">
                    <button
                      type="button"
                      className={`preview-row${
                        target?.port === l.port && target.path === l.path ? ' is-active' : ''
                      }`}
                      {...rowOpen({ port: l.port, path: l.path })}
                      title="Ctrl-click: new tab"
                    >
                      <span className="preview-icon preview-icon-wrap" aria-hidden="true">
                        <span className="preview-icon-fallback">
                          {l.name.slice(0, 1).toUpperCase()}
                        </span>
                      </span>
                      <span className="preview-row-text">
                        <span className="preview-row-name">{l.name}</span>
                        <span className="preview-row-sub">
                          :{l.port}
                          {l.path !== '/' ? l.path : ''}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="btn btn-icon btn-ghost"
                      aria-label={`Remove quick launch ${l.name}`}
                      onClick={() => persist(launches.filter((x) => x !== l))}
                    >
                      ×
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </section>

      <section className="preview-browser" aria-label="Preview">
        <PreviewTabStrip
          tabs={stripTabs}
          activeId={active.id}
          canReopen={state.closed.length > 0}
          atCap={state.tabs.length >= MAX_TABS}
          icon={(tab) => {
            const app = appOfTab.get(tab.id);
            return app ? (
              <AppIcon app={app} label={tab.title} />
            ) : (
              <GlobeIcon size={14} className="preview-tab-globe" />
            );
          }}
          onActivate={(id) => {
            setListing(false);
            dispatch({ type: 'activate', id });
          }}
          onNew={() => newTab()}
          onMove={(id, to) => dispatch({ type: 'move', id, to })}
          onCommand={runCommand}
        />
        <form className="preview-toolbar" onSubmit={go}>
          <button
            type="button"
            className="btn btn-sm preview-back"
            aria-pressed={listing}
            title={listing ? 'Back to the page, as you left it' : 'Your apps (the page stays open)'}
            onClick={() => setListing((on) => !on)}
          >
            {listing ? 'Page' : 'Apps'}
          </button>
          <button
            type="button"
            className="preview-tool"
            aria-label="Back"
            title="Back"
            disabled={active.trail.index <= 0}
            onClick={() => step(-1)}
          >
            <ArrowLeftIcon size={15} />
          </button>
          <button
            type="button"
            className="preview-tool preview-forward"
            aria-label="Forward"
            title="Forward"
            disabled={active.trail.index >= active.trail.stack.length - 1}
            onClick={() => step(1)}
          >
            <ArrowRightIcon size={15} />
          </button>
          <button
            type="button"
            className="preview-tool"
            aria-label="Reload"
            title="Reload"
            disabled={!target}
            onClick={() => dispatch({ type: 'reload', id: active.id })}
          >
            <RefreshIcon size={15} />
          </button>
          <input
            ref={addressRef}
            className="input preview-address"
            value={text}
            onChange={(e) => setDraft({ id: active.id, text: e.target.value })}
            placeholder="Type a localhost port or address"
            aria-label="Local address to preview"
            inputMode="url"
            enterKeyHint="go"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            type="button"
            className={`preview-tool${picking ? ' is-on' : ''}`}
            aria-label={picking ? 'Stop selecting' : 'Select an element to send to a session'}
            aria-pressed={picking}
            title={
              picking
                ? 'Click an element in the page (Esc to stop)'
                : 'Select an element and send it to a session'
            }
            disabled={!target}
            onClick={() => {
              tellPicker(picking ? 'stop' : 'start');
              setPicking(!picking);
            }}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12.034 12.681a.498.498 0 0 1 .647-.647l9 3.5a.5.5 0 0 1-.033.943l-3.444 1.068a1 1 0 0 0-.66.66l-1.067 3.443a.5.5 0 0 1-.943.033z" />
              <path d="M5 3a2 2 0 0 0-2 2M19 3a2 2 0 0 1 2 2M5 21a2 2 0 0 1-2-2M9 3h1M9 21h2M14 3h1M3 9v1M21 9v2M3 14v1" />
            </svg>
          </button>
          <button
            type="button"
            className={`preview-tool${saved ? ' is-on' : ''}`}
            aria-label={saved ? 'Remove from quick launches' : 'Save to quick launches'}
            aria-pressed={!!saved}
            title={saved ? 'Saved in Quick launches (click to remove)' : 'Save to Quick launches'}
            disabled={!target}
            onClick={toggleSaved}
          >
            <BookmarkIcon size={15} filled={!!saved} />
          </button>
        </form>
        {error && (
          <div className="error-banner preview-error" role="alert">
            {error}
          </div>
        )}
        {picked && (
          <PreviewPickDialog
            element={picked}
            projectId={pickedApp?.projectId ?? null}
            projectNames={projects}
            onClose={() => setPicked(null)}
          />
        )}
        <div className="preview-stage">
          {/* Every open page keeps its own frame, hidden when it is not the shown tab, so switching
              tabs keeps each page as you left it (scroll, forms, a running app). */}
          {state.tabs.map((tab) => {
            const t = targetOf(tab);
            if (!t) return null;
            const f = previewFrame(t);
            return (
              <iframe
                key={`${tab.id}:${tab.reloads}`}
                id={`preview-panel-${tab.id}`}
                role="tabpanel"
                aria-labelledby={`preview-tab-${tab.id}`}
                className={`preview-frame${tab.id === active.id ? '' : ' is-hidden'}`}
                title={`Preview of localhost:${t.port}`}
                src={f.src}
                sandbox={f.sandbox}
                referrerPolicy="no-referrer"
                onLoad={() => dispatch({ type: 'loaded', id: tab.id })}
              />
            );
          })}
          {picking && (
            <div className="preview-picking" role="status">
              <span>Click an element</span>
              <kbd>Esc</kbd>
              <button
                type="button"
                className="preview-picking-close"
                aria-label="Stop selecting"
                title="Stop selecting"
                onClick={() => {
                  tellPicker('stop');
                  setPicking(false);
                }}
              >
                ×
              </button>
            </div>
          )}
          {target && frame && active.loading && (
            <div className="preview-loading" role="status">
              <LoadingMark />
              <span>Opening localhost:{target.port}…</span>
            </div>
          )}
          {!target && (
            <div className="preview-empty-state">
              <GlobeIcon size={26} />
              <strong>Browse localhost</strong>
              <span>
                Pick an app from the list, or type a port above. Read-only and isolated from
                ProjectManager, so it works from your phone too.
              </span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
