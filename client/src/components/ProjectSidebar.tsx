import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import type { AgentSession, ProjectSummary } from '../../../shared/types';
import { api } from '../api';
import { formatCompact, formatRelative } from '../format';
import { useProjectHref } from '../projectTabs';
import { sessionActivity } from '../sessionActivity';
import { AddProjectDialog } from './AddProjectDialog';

// Sorter modelled on the KDP Publishing Pipeline Library sorter: each mode has
// a natural direction, re-selecting the active mode flips it, switching modes
// restarts from the new mode's natural direction, and the label always names
// the active direction (never "A–Z" while sorting Z–A).
type SortMode = 'name' | 'recent' | 'started' | 'lines' | 'terminals' | 'active' | 'planned';
type SortDirection = 'asc' | 'desc';

const SORT_MODES: SortMode[] = [
  'name',
  'recent',
  'started',
  'lines',
  'terminals',
  'active',
  'planned',
];
const SORT_DEFAULT_DIRECTION: Record<SortMode, SortDirection> = {
  name: 'asc',
  recent: 'desc',
  started: 'desc',
  lines: 'desc',
  terminals: 'desc',
  active: 'desc',
  planned: 'desc',
};

// Filters (KDP Library "Status" analogue): single choice, shown as a segmented group.
type Filter = 'all' | 'open' | 'working' | 'active' | 'planned';
const FILTERS: { value: Filter; label: string; title: string }[] = [
  { value: 'all', label: 'All', title: 'Every tracked project' },
  { value: 'open', label: 'CLI open', title: 'Projects with a CLI session running' },
  { value: 'working', label: 'Working', title: 'Projects whose CLI is producing output right now' },
  { value: 'active', label: 'In progress', title: 'Projects with cards in progress or review' },
  { value: 'planned', label: 'Planned', title: 'Projects with cards in Backlog or To do' },
];

function sortOptionLabel(mode: SortMode, direction: SortDirection): string {
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

/** Left sidebar: every tracked project with at-a-glance status. */
export function ProjectSidebar() {
  const navigate = useNavigate();
  const projectHref = useProjectHref();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [sessions, setSessions] = useState<AgentSession[]>([]);
  // Clock for working/idle badges, refreshed on every load (never read during render).
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
  const [adding, setAdding] = useState(false);
  const sorterRef = useRef<HTMLDivElement>(null);

  function chooseSort(mode: SortMode) {
    // Re-selecting the active mode flips it; switching modes starts from that
    // mode's natural direction instead of inheriting the previous one.
    if (mode === sortMode) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : 'asc'));
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
    if (!sortOpen) return;
    function onPointerDown(e: PointerEvent) {
      if (!sorterRef.current?.contains(e.target as Node)) setSortOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setSortOpen(false);
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
    async function load() {
      try {
        const [list, all] = await Promise.all([
          api.listProjects(),
          api.listAllSessions().catch(() => [] as AgentSession[]),
        ]);
        if (!cancelled) {
          setProjects(list);
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

  const q = query.trim().toLowerCase();
  // Comparators are written once in their natural direction and negated for
  // the reverse, so a flip can never disagree with the forward ordering.
  const flip = sortDirection === SORT_DEFAULT_DIRECTION[sortMode] ? 1 : -1;
  // Per project: how many CLI sessions are working (recent output) vs idle (waiting for you).
  const activity = new Map<number, { working: number; idle: number }>();
  for (const x of sessions) {
    const state = sessionActivity(x, now);
    if (state === 'stopped') continue;
    const entry = activity.get(x.projectId) ?? { working: 0, idle: 0 };
    entry[state]++;
    activity.set(x.projectId, entry);
  }
  const open = (p: ProjectSummary) => {
    const a = activity.get(p.id);
    return a ? a.working + a.idle : p.runningSessions;
  };
  const planned = (p: ProjectSummary) => p.cardCounts.backlog + p.cardCounts.todo;
  const inProgress = (p: ProjectSummary) => p.cardCounts.in_progress + p.cardCounts.review;
  const matchesFilter = (p: ProjectSummary) =>
    filter === 'open'
      ? open(p) > 0
      : filter === 'working'
        ? (activity.get(p.id)?.working ?? 0) > 0
        : filter === 'active'
          ? inProgress(p) > 0
          : filter === 'planned'
            ? planned(p) > 0
            : true;
  const filterLabel = FILTERS.find((f) => f.value === filter)!.label;

  const visible = (projects ?? [])
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    .filter(matchesFilter)
    .slice()
    .sort((a, b) => {
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

  const totalsLines = (projects ?? []).reduce((s, p) => s + (p.code?.code ?? 0), 0);
  const totalsCommits = recentCommits(projects ?? [], 30);
  const totalsFlight = (projects ?? []).reduce(
    (s, p) => s + p.cardCounts.in_progress + p.cardCounts.review,
    0,
  );
  const totalsRunning = (projects ?? []).reduce((s, p) => s + p.runningSessions, 0);

  return (
    <aside className="sidebar" aria-label="Tracked projects">
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
          <span className="faint">Portfolio overview</span>
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
                        active
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
                          {sortDirection === 'asc' ? '↑' : '↓'}
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
        {visible.map((p) => (
          <SidebarItem
            key={p.id}
            project={p}
            href={projectHref(p.id)}
            activity={activity.get(p.id) ?? { working: 0, idle: p.runningSessions }}
          />
        ))}
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
          <span className="faint">
            {visible.length !== projects.length
              ? `${visible.length} of ${projects.length} projects`
              : `${projects.length} project${projects.length === 1 ? '' : 's'}`}
          </span>
        </div>
      )}

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
    </aside>
  );
}

function SidebarItem({
  project: p,
  href,
  activity,
}: {
  project: ProjectSummary;
  href: string;
  activity: { working: number; idle: number };
}) {
  const flight = p.cardCounts.in_progress + p.cardCounts.review;
  const planned = p.cardCounts.backlog + p.cardCounts.todo;
  const topLang = p.code?.languages[0]?.name;
  return (
    <NavLink
      to={href}
      className={({ isActive }) => `sidebar-item${isActive ? ' is-active' : ''}`}
      title={p.path}
      aria-label={`${p.name} — ${p.path}`}
    >
      <span className="sidebar-name-row">
        <StatusDot project={p} />
        <span className="sidebar-name truncate">{p.name}</span>
        {activity.working > 0 && <SessionBadge state="working" count={activity.working} />}
        {activity.idle > 0 && <SessionBadge state="idle" count={activity.idle} />}
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
function SessionBadge({ state, count }: { state: 'working' | 'idle'; count: number }) {
  const label =
    state === 'working'
      ? `${count} CLI session${count === 1 ? '' : 's'} working`
      : `${count} CLI session${count === 1 ? '' : 's'} open, waiting for you`;
  return (
    <span className={`badge badge-session is-${state}`} title={label} aria-label={label} role="img">
      {state === 'working' ? (
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
      {count}
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
