import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import type { LocalApp, PreviewLaunch, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { Dropdown } from './Dropdown';
import { ArrowLeftIcon, ArrowRightIcon, BookmarkIcon, GlobeIcon, RefreshIcon } from './icons';
import { LoadingMark } from './LoadingMark';
import './project-preview.css';

// Preview (PM-253, docs/BUILT-IN-BROWSER.md): a dev server on this computer's localhost, shown
// through the server's read-only /api/preview proxy so it also works from a phone or the remote
// listener. A list of apps beside a small browser: a tab strip, back / forward / reload, one
// address field and a bookmark, like the built-in browser in Claude's desktop app. On phones it is
// the list or the browser, with an "Apps" button back. It is a global page (top bar Preview), not
// a project tab: a dev server is not owned by one project. The page runs in a sandbox WITHOUT
// allow-same-origin, so it gets an opaque origin and cannot reach this app's API or cookies. Never
// offer "open in a new tab" for the proxied address: a top-level tab would run it as this origin.
//
// The list refreshes every 5 s while the page is open and visible (paused in a background tab),
// and the refresh button reads the machine right now. Sections fold and the sort is remembered
// per browser (localStorage; the page works without it).

export interface PreviewTarget {
  port: number;
  /** Always starts with "/". */
  path: string;
}

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

export const previewSrc = (t: PreviewTarget) => `/api/preview/${t.port}${t.path}`;

/** How an address reads in the address field. */
export const targetText = (t: PreviewTarget) =>
  `localhost:${t.port}${t.path === '/' ? '' : t.path}`;
const sameTarget = (a: PreviewTarget | null, b: PreviewTarget | null) =>
  !!a && !!b && a.port === b.port && a.path === b.path;
const POLL_MS = 5000;

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
      hint: 'From your projects, with an icon: usually the front end',
      apps: mine.filter((a) => a.icon),
    },
    {
      id: 'services' as const,
      heading: 'Services',
      hint: 'From your projects, no icon: usually an API or back end',
      apps: mine.filter((a) => !a.icon),
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
          src={`/api/preview/${app.port}${app.icon}`}
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

/** Pages opened in the viewer, with where you are in them (back and forward). */
interface Trail {
  stack: PreviewTarget[];
  index: number;
}
const EMPTY_TRAIL: Trail = { stack: [], index: -1 };

export function PreviewWorkspace() {
  const [params, setParams] = useSearchParams();
  const initial = parsePreviewTarget(params.get('preview') ?? '');
  const [trail, setTrail] = useState<Trail>(() =>
    initial ? { stack: [initial], index: 0 } : EMPTY_TRAIL,
  );
  const target: PreviewTarget | null = trail.stack[trail.index] ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? (target ? targetText(target) : '');
  const [reloads, setReloads] = useState(0);
  const [frameLoading, setFrameLoading] = useState(initial !== null);
  const [error, setError] = useState<string | null>(null);
  const [apps, setApps] = useState<LocalApp[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [launches, setLaunches] = useState<PreviewLaunch[]>([]);
  const [projects, setProjects] = useState<Map<number, string>>(new Map());
  const [sort, setSortState] = useState<PreviewSort>(readSort);
  const [chosenOpen, setChosenOpen] = useState(readOpen);

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

  // The address bar and the link always show where the viewer is.
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

  const setSort = (next: PreviewSort) => {
    setSortState(next);
    remember(SORT_KEY, next);
  };

  const open = useCallback((next: PreviewTarget) => {
    setDraft(null);
    setError(null);
    setFrameLoading(true);
    setReloads((n) => n + 1);
    setTrail((t) => {
      if (sameTarget(t.stack[t.index] ?? null, next)) return t;
      const stack = [...t.stack.slice(0, t.index + 1), next];
      return { stack, index: stack.length - 1 };
    });
  }, []);
  const step = (delta: -1 | 1) => {
    const index = trail.index + delta;
    if (index < 0 || index >= trail.stack.length) return;
    setDraft(null);
    setError(null);
    setFrameLoading(true);
    setReloads((n) => n + 1);
    setTrail({ ...trail, index });
  };
  const reload = () => {
    setFrameLoading(true);
    setReloads((n) => n + 1);
  };
  /** Closes the page: back to the empty browser (and, on a phone, the list). */
  const close = () => {
    setTrail(EMPTY_TRAIL);
    setDraft(null);
    setFrameLoading(false);
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

  const tabTitle = target ? (running?.title ?? `localhost:${target.port}`) : 'New tab';

  return (
    <div className={`project-preview${target ? ' has-target' : ''}`}>
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
                    <li key={`${app.port}:${app.pid}`}>
                      <button
                        type="button"
                        className={`preview-row${target?.port === app.port ? ' is-active' : ''}`}
                        onClick={() => open({ port: app.port, path: '/' })}
                        title={[project, app.command || app.name].filter(Boolean).join(' · ')}
                      >
                        <AppIcon app={app} label={name} />
                        <span className="preview-row-text">
                          <span className="preview-row-name">{name}</span>
                          <span className="preview-row-sub">:{app.port}</span>
                        </span>
                      </button>
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
                      onClick={() => open({ port: l.port, path: l.path })}
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
        <div className="preview-tabstrip">
          <span className="preview-tab" title={tabTitle}>
            {running ? (
              <AppIcon app={running} label={tabTitle} />
            ) : (
              <GlobeIcon size={14} className="preview-tab-globe" />
            )}
            <span className="preview-tab-title">{tabTitle}</span>
            {target && (
              <button
                type="button"
                className="preview-tab-close"
                aria-label="Close this page"
                onClick={close}
              >
                ×
              </button>
            )}
          </span>
        </div>
        <form className="preview-toolbar" onSubmit={go}>
          <button type="button" className="btn btn-sm preview-back" onClick={close}>
            Apps
          </button>
          <button
            type="button"
            className="preview-tool"
            aria-label="Back"
            title="Back"
            disabled={trail.index <= 0}
            onClick={() => step(-1)}
          >
            <ArrowLeftIcon size={15} />
          </button>
          <button
            type="button"
            className="preview-tool"
            aria-label="Forward"
            title="Forward"
            disabled={trail.index >= trail.stack.length - 1}
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
            onClick={reload}
          >
            <RefreshIcon size={15} />
          </button>
          <input
            className="input preview-address"
            value={text}
            onChange={(e) => setDraft(e.target.value)}
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
        <div className="preview-stage">
          {target ? (
            <>
              <iframe
                key={`${target.port}${target.path}:${reloads}`}
                className="preview-frame"
                title={`Preview of localhost:${target.port}`}
                src={previewSrc(target)}
                sandbox="allow-scripts allow-forms allow-popups"
                referrerPolicy="no-referrer"
                onLoad={() => setFrameLoading(false)}
              />
              {frameLoading && (
                <div className="preview-loading" role="status">
                  <LoadingMark />
                  <span>Opening localhost:{target.port}…</span>
                </div>
              )}
            </>
          ) : (
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
