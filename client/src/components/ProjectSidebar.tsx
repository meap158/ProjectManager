import { Fragment, Suspense, lazy, useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import type { AgentSession, LocalApp, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { formatCompact, formatRelative } from '../format';
import { useProjectHref } from '../projectTabs';
import { sessionActivity } from '../sessionActivity';
import { applyCustomOrder, mergeVisibleOrder, moveBefore, moveBy } from '../projectOrder';
import { PlanUsage } from './PlanUsage';
import { navigateProjectPane } from '../projectPaneNavigation';
import { serialPoll } from '../lib/serialPoll';
import { GlobeIcon } from './icons';

// Opened from the + button only: loaded on first use, not with every page.
const AddProjectDialog = lazy(() =>
  import('./AddProjectDialog').then((m) => ({ default: m.AddProjectDialog })),
);

// Sorter modelled on the KDP Publishing Pipeline Library sorter: each mode has
// a natural direction, re-selecting the active mode flips it, switching modes
// restarts from the new mode's natural direction, and the label always names
// the active direction (never "A–Z" while sorting Z–A).
// "Custom order" (KDP Library's custom sort): the user's own arrangement, dragged by a grip
// handle or moved with the arrow keys; it has no direction.
type SortMode =
  'custom' | 'name' | 'recent' | 'started' | 'lines' | 'terminals' | 'active' | 'planned';
type SortDirection = 'asc' | 'desc';

const SORT_MODES: SortMode[] = [
  'custom',
  'name',
  'recent',
  'started',
  'lines',
  'terminals',
  'active',
  'planned',
];
const SORT_DEFAULT_DIRECTION: Record<SortMode, SortDirection> = {
  custom: 'asc',
  name: 'asc',
  recent: 'desc',
  started: 'desc',
  lines: 'desc',
  terminals: 'desc',
  active: 'desc',
  planned: 'desc',
};

// Filters (KDP Library "Status" analogue): single choice, shown as a segmented group.
type Filter = 'all' | 'open' | 'running' | 'active' | 'planned';
const FILTERS: { value: Filter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'Every tracked project' },
  { value: 'open', label: 'CLI open', title: 'Projects with a CLI session running' },
  {
    value: 'running',
    label: 'Running',
    title: 'Projects whose CLI is busy, or still has a shell or subtask going',
  },
  { value: 'active', label: 'In progress', title: 'Projects with cards in progress or review' },
  { value: 'planned', label: 'Planned', title: 'Projects with cards in Backlog or To do' },
];

function sortOptionLabel(mode: SortMode, direction: SortDirection): string {
  if (mode === 'custom') return 'Custom order';
  if (mode === 'name') return direction === 'asc' ? 'A–Z' : 'Z–A';
  // "Recently active" (last commit) vs "Newest project" (first commit): never ambiguous.
  if (mode === 'recent') return direction === 'desc' ? 'Recently active' : 'Least active';
  if (mode === 'started') return direction === 'desc' ? 'Newest project' : 'Oldest project';
  if (mode === 'terminals') return direction === 'desc' ? 'Most terminals' : 'Fewest terminals';
  if (mode === 'active') return direction === 'desc' ? 'Most in progress' : 'Least in progress';
  if (mode === 'planned') return direction === 'desc' ? 'Most planned' : 'Least planned';
  return direction === 'desc' ? 'Most code' : 'Least code';
}

function readSortPreference<T extends string>(key: string, choices: T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && choices.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

/** How often the sidebar re-reads the (large) projects list while only sessions are changing. */
const PROJECTS_EVERY_MS = 8000;

function firstCommitTime(p: ProjectSummary): number | null {
  return p.git?.firstCommitAt ? Date.parse(p.git.firstCommitAt) : null;
}

function lastCommitTime(p: ProjectSummary): number {
  return p.git?.lastCommitAt ? Date.parse(p.git.lastCommitAt) : 0;
}

function recentCommits(projects: ProjectSummary[], days: number): number {
  const since = Date.now() - days * 86_400_000;
  return projects.reduce(
    (sum, p) =>
      sum +
      Object.entries(p.git?.dailyCommits ?? {}).reduce(
        (s, [day, n]) => (Date.parse(day) >= since ? s + n : s),
        0,
      ),
    0,
  );
}

/** CLI sessions in a project by what they're doing (see sessionActivity). */
interface Activity {
  running: number;
  idle: number;
  /** Asking you to choose or approve something (PM-47). */
  input: number;
}

/** Left sidebar: every tracked project with at-a-glance status. */
/**
 * `panelOpen` / `onNavigate` drive the phone layout, where the sidebar is a full-screen panel opened
 * from the bottom tab bar (DESIGN.md §10.1). Above the phone breakpoint CSS ignores `panelOpen`.
 */
export function ProjectSidebar({
  panelOpen = false,
  onNavigate,
}: { panelOpen?: boolean; onNavigate?: () => void } = {}) {
  const navigate = useNavigate();
  const projectHref = useProjectHref();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  // Web apps running on this computer, by the project they were started from (Preview's detection).
  const [webApps, setWebApps] = useState<Map<number, LocalApp[]>>(new Map());
  // Clock for running/idle badges, refreshed on every load (never read during render).
  const [now, setNow] = useState(0);
  const [query, setQuery] = useState('');
  const [sortMode, setSortMode] = useState<SortMode>(() =>
    readSortPreference('pm-sidebar-sort', SORT_MODES, 'name'),
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(() =>
    readSortPreference('pm-sidebar-sort-direction', ['asc', 'desc'] as SortDirection[], 'asc'),
  );
  const [filter, setFilter] = useState<Filter>(() =>
    readSortPreference(
      'pm-sidebar-filter',
      FILTERS.map((f) => f.value),
      'all',
    ),
  );
  const [sortOpen, setSortOpen] = useState(false);
  // Custom order (server-side, so it survives port changes and cleared browsers).
  const [customOrder, setCustomOrder] = useState<number[]>([]);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropBefore, setDropBefore] = useState<number | null | undefined>(undefined);
  const [adding, setAdding] = useState(false);
  const sorterRef = useRef<HTMLDivElement>(null);

  function chooseSort(mode: SortMode) {
    // Re-selecting the active mode flips it; switching modes starts from that
    // mode's natural direction instead of inheriting the previous one.
    if (mode === sortMode) {
      if (mode !== 'custom') setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortMode(mode);
      setSortDirection(SORT_DEFAULT_DIRECTION[mode]);
    }
  }

  // Persist the sorter; close the menu on outside click / Escape.
  useEffect(() => {
    try {
      localStorage.setItem('pm-sidebar-sort', sortMode);
      localStorage.setItem('pm-sidebar-sort-direction', sortDirection);
      localStorage.setItem('pm-sidebar-filter', filter);
    } catch {
      // Private browsing etc: sorting still works for the session.
    }
  }, [sortMode, sortDirection, filter]);

  useEffect(() => {
    let active = true;
    api.getProjectOrder().then(
      ({ order }) => active && setCustomOrder(order),
      () => undefined, // Unknown order: projects fall back to A–Z.
    );
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!sortOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!sorterRef.current?.contains(e.target as Node)) setSortOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault(); // Esc closes the menu only, not the phone project panel around it.
        setSortOpen(false);
      }
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [sortOpen]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // The projects list is big (stats, heatmaps) and changes slowly; the sessions drive the
    // working/idle badges. So sessions follow the fast cadence and projects are re-read only
    // while a scan runs or every PROJECTS_EVERY_MS.
    let projectsAt = 0;
    let latest: ProjectSummary[] = [];
    async function load() {
      try {
        const scanningNow = latest.some((p) => p.scan.status === 'scanning');
        const refreshProjects = scanningNow || Date.now() - projectsAt >= PROJECTS_EVERY_MS;
        const [list, all] = await Promise.all([
          refreshProjects ? api.listProjects() : Promise.resolve(latest),
          api.listAllSessions().catch(() => [] as AgentSession[]),
        ]);
        if (refreshProjects) {
          projectsAt = Date.now();
          latest = list;
        }
        if (!cancelled) {
          if (refreshProjects) setProjects(list);
          setSessions(all);
          setNow(Date.now());
        }
        const scanning = list.some((p) => p.scan.status === 'scanning');
        // Working vs idle is judged on output in the last few seconds: poll faster while any
        // session runs so the badges keep up.
        const running = all.some((x) => x.status === 'running');
        timer = setTimeout(load, scanning ? 2000 : running ? 4000 : 10000);
      } catch {
        timer = setTimeout(load, 10000);
      }
    }
    load();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    const stop = serialPoll(
      () =>
        api.localApps().then(
          ({ apps }) => {
            if (!active) return;
            const byProject = new Map<number, LocalApp[]>();
            for (const app of apps) {
              if (!app.web || app.projectId == null) continue;
              byProject.set(app.projectId, [...(byProject.get(app.projectId) ?? []), app]);
            }
            setWebApps((prev) => (sameApps(prev, byProject) ? prev : byProject));
          },
          () => undefined, // A convenience: the list works without it.
        ),
      15_000,
      { pauseWhenHidden: true },
    );
    return () => {
      active = false;
      stop();
    };
  }, []);

  const q = query.trim().toLowerCase();
  // Comparators are written once in their natural direction and negated for
  // the reverse, so a flip can never disagree with the forward ordering.
  const flip = sortDirection === SORT_DEFAULT_DIRECTION[sortMode] ? 1 : -1;
  // Per project: how many CLI sessions are running (busy, or a shell/subtask going) vs idle (waiting for you).
  const activity = new Map<number, Activity>();
  for (const x of sessions) {
    const state = sessionActivity(x, now);
    if (state === 'stopped') continue;
    const entry = activity.get(x.projectId) ?? { running: 0, idle: 0, input: 0 };
    entry[state]++;
    activity.set(x.projectId, entry);
  }
  const open = (p: ProjectSummary) => {
    const a = activity.get(p.id);
    return a ? a.running + a.idle + a.input : p.runningSessions;
  };
  const planned = (p: ProjectSummary) => p.cardCounts.backlog + p.cardCounts.todo;
  const inProgress = (p: ProjectSummary) => p.cardCounts.in_progress + p.cardCounts.review;
  const matchesFilter = (p: ProjectSummary) =>
    filter === 'open'
      ? open(p) > 0
      : filter === 'running'
        ? (activity.get(p.id)?.running ?? 0) > 0
        : filter === 'active'
          ? inProgress(p) > 0
          : filter === 'planned'
            ? planned(p) > 0
            : true;
  const filterLabel = FILTERS.find((f) => f.value === filter)!.label;

  const sorted = sortMode === 'custom' ? applyCustomOrder(projects ?? [], customOrder) : null;
  const visible = (sorted ?? projects ?? [])
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    .filter(matchesFilter)
    .slice()
    .sort((a, b) => {
      if (sortMode === 'custom') return 0; // Already in the user's order (stable sort).
      // Count sorts fall back to name so equal counts keep a stable, readable order.
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (sortMode === 'terminals') return flip * (open(b) - open(a)) || byName;
      if (sortMode === 'active') return flip * (inProgress(b) - inProgress(a)) || byName;
      if (sortMode === 'planned') return flip * (planned(b) - planned(a)) || byName;
      if (sortMode === 'recent') return flip * (lastCommitTime(b) - lastCommitTime(a));
      if (sortMode === 'started') {
        // Projects without commits have no age: always after the ones that do.
        const fa = firstCommitTime(a);
        const fb = firstCommitTime(b);
        if (fa === null || fb === null) return fa === fb ? 0 : fa === null ? 1 : -1;
        return flip * (fb - fa);
      }
      if (sortMode === 'lines') return flip * ((b.code?.code ?? -1) - (a.code?.code ?? -1));
      return flip * a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    });

  /** Saves a new order of the visible projects (hidden ones keep their places). */
  function reorder(visibleIds: number[]) {
    const full = applyCustomOrder(projects ?? [], customOrder).map((x) => x.id);
    const next = mergeVisibleOrder(full, visibleIds);
    setCustomOrder(next);
    api.saveProjectOrder(next).catch(() => undefined); // Still applied for this session.
  }
  const visibleIds = visible.map((x) => x.id);
  const reorderable = sortMode === 'custom' && visible.length > 1;

  const totalsLines = (projects ?? []).reduce((s, p) => s + (p.code?.code ?? 0), 0);
  const totalsCommits = recentCommits(projects ?? [], 30);
  const totalsFlight = (projects ?? []).reduce(
    (s, p) => s + p.cardCounts.in_progress + p.cardCounts.review,
    0,
  );
  const totalsRunning = (projects ?? []).reduce((s, p) => s + p.runningSessions, 0);

  return (
    <aside
      id="project-panel"
      className={`sidebar${panelOpen ? ' is-open' : ''}`}
      aria-label="Tracked projects"
      tabIndex={-1}
      onKeyDown={(e) => navigateProjectPane(e, navigate)}
      // Picking any link (even the page already shown) closes the phone panel.
      onClick={(e) => {
        if ((e.target as Element).closest('a')) onNavigate?.();
      }}
    >
      <NavLink
        to="/"
        end
        className={({ isActive }) => `sidebar-home${isActive ? ' is-active' : ''}`}
      >
        <span aria-hidden="true" className="sidebar-home-icon">
          ▦
        </span>
        <span className="sidebar-home-text">
          <b>All projects</b>
          {/* The project count lives here (PM-43), not in a footer row of its own. */}
          <span className="faint">
            {projects === null
              ? 'Portfolio overview'
              : visible.length !== projects.length
                ? `Portfolio · ${visible.length} of ${projects.length} shown`
                : `Portfolio · ${projects.length} project${projects.length === 1 ? '' : 's'}`}
          </span>
        </span>
      </NavLink>
      <div className="sidebar-top">
        <input
          className="input"
          type="search"
          placeholder="Filter projects…"
          aria-label="Filter projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="sidebar-row">
          <div className="sorter" ref={sorterRef}>
            <button
              type="button"
              className="btn btn-sm sorter-trigger"
              aria-haspopup="dialog"
              aria-expanded={sortOpen}
              aria-label="Filter and sort projects"
              title={
                sortOpen
                  ? 'Close filter and sort options'
                  : `Showing ${filterLabel.toLowerCase()}, sorted ${sortOptionLabel(sortMode, sortDirection)}`
              }
              onClick={() => setSortOpen((o) => !o)}
            >
              <SlidersIcon />
              <span className="truncate">
                {sortOptionLabel(sortMode, sortDirection)}
                {filter !== 'all' && <span className="sorter-filter"> · {filterLabel}</span>}
              </span>
            </button>
            {sortOpen && (
              <div className="sorter-menu" role="dialog" aria-label="Filter and sort projects">
                <div className="sorter-label" id="sidebar-show-label">
                  Show
                </div>
                <div className="sorter-filters" role="group" aria-labelledby="sidebar-show-label">
                  {FILTERS.map((f) => (
                    <button
                      key={f.value}
                      type="button"
                      aria-pressed={filter === f.value}
                      className={filter === f.value ? 'active' : undefined}
                      title={f.title}
                      onClick={() => setFilter(f.value)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
                <div className="sorter-divider" />
                <div className="sorter-label">Sort by</div>
                {SORT_MODES.map((mode) => {
                  const active = mode === sortMode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      className={`sorter-option${active ? ' selected' : ''}`}
                      title={
                        mode === 'custom'
                          ? 'Your own order: drag the handles, or focus one and use the arrow keys'
                          : active
                            ? 'Click again to reverse the order'
                            : `Sort by ${sortOptionLabel(mode, SORT_DEFAULT_DIRECTION[mode])}`
                      }
                      onClick={() => chooseSort(mode)}
                    >
                      <span>
                        {active
                          ? sortOptionLabel(mode, sortDirection)
                          : sortOptionLabel(mode, SORT_DEFAULT_DIRECTION[mode])}
                      </span>
                      {active && (
                        <span className="sort-direction-badge" aria-hidden="true">
                          {mode === 'custom' ? '✓' : sortDirection === 'asc' ? '↑' : '↓'}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
          <button className="btn btn-primary btn-sm" onClick={() => setAdding(true)}>
            ＋ Add
          </button>
        </div>
      </div>

      <nav className="sidebar-list">
        {projects === null && (
          <>
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 52 }} />
            ))}
          </>
        )}
        {projects?.length === 0 && (
          <div className="faint" style={{ fontSize: 13, padding: '4px 2px' }}>
            No projects tracked yet.
          </div>
        )}
        {visible.map((p) => {
          const item = (
            <SidebarItem
              project={p}
              href={projectHref(p.id)}
              activity={activity.get(p.id) ?? { running: 0, idle: p.runningSessions, input: 0 }}
              apps={webApps.get(p.id)}
            />
          );
          if (!reorderable) return <Fragment key={p.id}>{item}</Fragment>;
          return (
            <div
              key={p.id}
              className={`sidebar-reorder${dragId === p.id ? ' is-dragging' : ''}${
                dragId !== null && dropBefore === p.id ? ' drop-before' : ''
              }`}
              onDragOver={(e) => {
                if (dragId === null) return;
                e.preventDefault();
                const box = e.currentTarget.getBoundingClientRect();
                const after = e.clientY > box.top + box.height / 2;
                const i = visibleIds.indexOf(p.id);
                setDropBefore(after ? (visibleIds[i + 1] ?? null) : p.id);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragId !== null && dropBefore !== undefined)
                  reorder(moveBefore(visibleIds, dragId, dropBefore));
                setDragId(null);
                setDropBefore(undefined);
              }}
            >
              <button
                type="button"
                className="sidebar-grip"
                data-project-id={p.id}
                draggable
                aria-label={`Move ${p.name}: press the up or down arrow`}
                title="Drag to reorder, or use the arrow keys"
                onDragStart={(e) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', p.name);
                  const row = e.currentTarget.parentElement;
                  if (row) e.dataTransfer.setDragImage(row, 12, 20);
                  setDragId(p.id);
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropBefore(undefined);
                }}
                onKeyDown={(e) => {
                  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                  e.preventDefault();
                  const next = moveBy(visibleIds, p.id, e.key === 'ArrowUp' ? -1 : 1);
                  if (next === visibleIds) return;
                  reorder(next);
                  // Moving the row re-inserts its DOM node, which drops focus: put it back.
                  requestAnimationFrame(() =>
                    document
                      .querySelector<HTMLButtonElement>(`.sidebar-grip[data-project-id="${p.id}"]`)
                      ?.focus(),
                  );
                }}
              >
                <GripIcon />
              </button>
              {item}
            </div>
          );
        })}
        {reorderable && dragId !== null && (
          <div
            className={`sidebar-drop-end${dropBefore === null ? ' drop-before' : ''}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDropBefore(null);
            }}
            onDrop={(e) => {
              e.preventDefault();
              reorder(moveBefore(visibleIds, dragId, null));
              setDragId(null);
              setDropBefore(undefined);
            }}
          />
        )}
        {projects !== null && visible.length === 0 && projects.length > 0 && (
          <div className="faint" style={{ fontSize: 13, padding: '4px 2px' }}>
            {q ? `No projects match “${query.trim()}”` : 'No projects match this filter'}
            {filter !== 'all' && (
              <>
                {' · '}
                <button type="button" className="link-button" onClick={() => setFilter('all')}>
                  Show all
                </button>
              </>
            )}
          </div>
        )}
      </nav>

      {projects && projects.length > 0 && (
        <div className="sidebar-foot">
          <PlanUsage />
          <div className="sidebar-totals" aria-label="Portfolio totals">
            <div className="totals-grid">
              <span className="t">
                <b className="num">{formatCompact(totalsLines)}</b>
                <span>lines</span>
              </span>
              <span className="t">
                <b className="num">{totalsCommits}</b>
                <span title="Commits in the last 30 days">commits · 30d</span>
              </span>
              <span className="t">
                <b className="num">{totalsFlight}</b>
                <span title="Tasks in progress or in review">active</span>
              </span>
              <Link
                to="/workspace"
                className="t"
                title="CLI sessions running in all projects. Open them in Agents."
              >
                <b className="num">{totalsRunning}</b>
                <span>running</span>
              </Link>
            </div>
          </div>
        </div>
      )}

      {adding && (
        <Suspense fallback={null}>
          <AddProjectDialog
            open={adding}
            onClose={() => setAdding(false)}
            onAdded={(project) => {
              setAdding(false);
              setProjects((prev) => (prev ? [...prev, project] : [project]));
              navigate(`/projects/${project.id}`);
            }}
            onAddedMany={(result) => {
              setAdding(false);
              setProjects((prev) => (prev ? [...prev, ...result.added] : [...result.added]));
              if (result.added.length === 1) navigate(`/projects/${result.added[0]!.id}`);
            }}
          />
        </Suspense>
      )}
    </aside>
  );
}

/** Same projects with the same ports: keeps the previous map so the list doesn't re-render. */
function sameApps(a: Map<number, LocalApp[]>, b: Map<number, LocalApp[]>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, apps] of b) {
    const old = a.get(id);
    if (!old || old.map((x) => x.port).join() !== apps.map((x) => x.port).join()) return false;
  }
  return true;
}

/** "App running: localhost:3000" — what the globe on a sidebar row says. */
export function runningAppsLabel(apps: LocalApp[]): string {
  const where = apps.map((a) => `localhost:${a.port}`).join(', ');
  return apps.length === 1 ? `App running: ${where}` : `${apps.length} apps running: ${where}`;
}

function SidebarItem({
  project: p,
  href,
  activity,
  apps,
}: {
  project: ProjectSummary;
  href: string;
  activity: Activity;
  apps?: LocalApp[];
}) {
  const flight = p.cardCounts.in_progress + p.cardCounts.review;
  const planned = p.cardCounts.backlog + p.cardCounts.todo;
  const topLang = p.code?.languages[0]?.name;
  const live = apps?.length ? runningAppsLabel(apps) : null;
  return (
    <NavLink
      to={href}
      className={({ isActive }) => `sidebar-item${isActive ? ' is-active' : ''}`}
      title={p.path}
      aria-label={`${p.name} — ${p.path}${live ? ` — ${live}` : ''}`}
    >
      <span className="sidebar-name-row">
        <StatusDot project={p} />
        <span className="sidebar-name truncate">{p.name}</span>
        {/* Icon only, and only when something runs: costs no width on the other rows. */}
        {live && (
          <span className="sidebar-live" role="img" aria-label={live} title={live}>
            <GlobeIcon size={13} />
          </span>
        )}
        {p.missing ? (
          <span className="badge badge-danger">missing</span>
        ) : p.scan.status === 'scanning' ? (
          <span className="badge">
            <span className="spinner" style={{ width: 10, height: 10 }} />
          </span>
        ) : flight > 0 ? (
          <span className="badge" title="In progress + Review">
            {flight} ▶
          </span>
        ) : planned > 0 ? (
          <span className="badge" title="Backlog + To do">
            {planned}
          </span>
        ) : null}
        {/* Rightmost fixed slot: session counts share one right edge; empty rows keep it. */}
        <span className="sidebar-session-slot">
          {activity.running + activity.idle + activity.input > 0 && <SessionBadge {...activity} />}
        </span>
      </span>
      <span className="sidebar-stats">
        <span className="num">{p.code ? formatCompact(p.code.code) : '—'}</span>
        <span className="faint">lines</span>
        <span aria-hidden="true" className="faint">
          ·
        </span>
        <span className="truncate" style={{ maxWidth: 96 }}>
          {topLang ?? '—'}
        </span>
        <span aria-hidden="true" className="faint">
          ·
        </span>
        {p.git?.lastCommitAt ? (
          <span className="faint" title={p.git.lastCommitAt}>
            {formatRelative(p.git.lastCommitAt)}
          </span>
        ) : (
          <span className="faint">no commits</span>
        )}
      </span>
    </NavLink>
  );
}

/**
 * CLI sessions in this project, by what they're doing. Working (output in the last seconds):
 * accent badge with a spinning ring. Idle (open, waiting for you): neutral badge with a
 * terminal glyph. Icon + count + text label, never colour alone.
 */
function SessionBadge({ running, idle, input }: Activity) {
  const total = running + idle + input;
  const parts = [
    input > 0 ? `${input} asking you to choose something` : null,
    running > 0 ? `${running} running` : null,
    idle > 0 ? `${idle} open, waiting for you` : null,
  ].filter(Boolean);
  const label = `${total} CLI session${total === 1 ? '' : 's'}: ${parts.join(', ')}`;
  // Asking you comes first: it's the one thing here that waits on you specifically.
  const state = input > 0 ? 'input' : running > 0 ? 'running' : 'idle';
  return (
    <span className={`badge badge-session is-${state}`} title={label} aria-label={label} role="img">
      {state === 'input' ? (
        <span aria-hidden="true" style={{ fontWeight: 800 }}>
          !
        </span>
      ) : state === 'running' ? (
        <span className="badge-spinner" aria-hidden="true" />
      ) : (
        <svg width="11" height="11" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 4l4 4-4 4M8.5 12H13"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
      {total}
    </span>
  );
}

function StatusDot({ project: p }: { project: ProjectSummary }) {
  let color = 'var(--series-other)';
  let label = 'Idle';
  if (p.missing) {
    color = 'var(--danger)';
    label = 'Folder missing';
  } else if (p.scan.status === 'scanning') {
    color = 'var(--accent)';
    label = 'Scanning';
  } else if (p.scan.status === 'error') {
    color = 'var(--danger)';
    label = 'Scan failed';
  } else if (p.cardCounts.in_progress + p.cardCounts.review > 0) {
    color = 'var(--good, #0ca30c)';
    label = 'Tasks being worked on';
  }
  return (
    <span
      className="status-dot"
      style={{ background: color }}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true">
      {[2, 7, 12].flatMap((y) => [
        <circle key={`a${y}`} cx="3" cy={y} r="1.2" fill="currentColor" />,
        <circle key={`b${y}`} cx="7" cy={y} r="1.2" fill="currentColor" />,
      ])}
    </svg>
  );
}

function SlidersIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden="true" style={{ flex: 'none' }}>
      <path
        d="M2 4h7M12 4h2M2 12h3M8 12h6M9.5 2.5v3M5.5 10.5v3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
