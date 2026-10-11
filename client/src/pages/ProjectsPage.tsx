import { projectAttention } from '../../../shared/projectAttention';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import {
  CARD_STATUS_LABELS,
  type LanguageStats,
  type ProjectSummary,
  type CardWithProject,
} from '../../../shared/types';
import { api } from '../api';
import { useProjectHref } from '../projectTabs';
import { AddProjectDialog } from '../components/AddProjectDialog';
import { LanguageBar } from '../components/charts';
import { CommitsByProject } from '../components/CommitsByProject';
import { BytesTile, StatTile } from '../components/StatTile';
import { formatBytes, formatCompact, formatDate, formatNumber, formatRelative } from '../format';

const POLL_MS = 1000;

/** Commits in the last `days` days, from the per-day map. */
function recentCommits(project: ProjectSummary, days: number): number {
  const since = Date.now() - days * 86_400_000;
  return Object.entries(project.git?.dailyCommits ?? {}).reduce(
    (sum, [day, n]) => (Date.parse(day) >= since ? sum + n : sum),
    0,
  );
}

/** Rows a capped dashboard list shows on phones before "Show all" (keep in sync with CSS). */
const PHONE_LIST_ROWS = 5;

export function ProjectsPage() {
  const projectHref = useProjectHref();
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // Clock for staleness checks, refreshed on every load (see attention below).
  const [now, setNow] = useState(0);

  // Only sets state in promise callbacks, so effects may call it directly.
  const [inFlight, setInFlight] = useState<CardWithProject[]>([]);
  // Phone layout: long dashboard lists show their first rows until expanded (DESIGN.md §10.1).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const showAll = (list: string) => setExpanded((prev) => new Set(prev).add(list));
  const load = useCallback(
    () =>
      Promise.all([api.listProjects(), api.listCardsInFlight().catch(() => [])]).then(
        ([next, cards]) => {
          setProjects(next);
          setInFlight(cards);
          setNow(Date.now());
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Keep polling while any project is still being scanned.
  const scanning = projects?.some((p) => p.scan.status === 'scanning') ?? false;
  useEffect(() => {
    if (!scanning) return;
    const timer = setTimeout(load, POLL_MS);
    return () => clearTimeout(timer);
  }, [scanning, projects, load]);

  const totals = (projects ?? []).reduce(
    (t, p) => ({
      code: t.code + (p.code?.code ?? 0),
      bytes: t.bytes + (p.disk?.bytes ?? 0),
      commits30: t.commits30 + recentCommits(p, 30),
      open: t.open + p.cardCounts.backlog + p.cardCounts.todo,
      active: t.active + p.cardCounts.in_progress + p.cardCounts.review,
    }),
    { code: 0, bytes: 0, commits30: 0, open: 0, active: 0 },
  );

  // Portfolio rollups: languages summed across projects, commit days merged.
  const portfolioLanguages = useMemo(() => {
    const byName = new Map<string, LanguageStats>();
    for (const p of projects ?? []) {
      for (const l of p.code?.languages ?? []) {
        const acc = byName.get(l.name) ?? {
          name: l.name,
          files: 0,
          bytes: 0,
          code: 0,
          comments: 0,
          blanks: 0,
          complexity: 0,
        };
        acc.files += l.files;
        acc.bytes += l.bytes;
        acc.code += l.code;
        acc.comments += l.comments;
        acc.blanks += l.blanks;
        acc.complexity += l.complexity;
        byName.set(l.name, acc);
      }
    }
    return [...byName.values()].sort((a, b) => b.code - a.code);
  }, [projects]);

  // Shared with orchestrator follow-up so both surfaces use the same signals.
  const attention = useMemo(
    () =>
      (projects ?? []).flatMap((project) =>
        projectAttention(project, now).map((item) => ({
          project,
          ...item,
          detail:
            item.kind === 'Stale'
              ? `No commits for over 90 days (last ${formatRelative(project.git!.lastCommitAt!)})`
              : item.detail,
        })),
      ),
    [projects, now],
  );
  return (
    <main className="page">
      {/* Sticky chrome: title and action stay put while the dashboard scrolls. */}
      <div className="sticky-head">
        <div className="page-header">
          <div>
            <h1>Dashboard</h1>
            <div className="subtitle">
              Everything across your tracked folders: totals, rankings and projects.
            </div>
          </div>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            ＋ Add project
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      {projects === null && !error && (
        <div className="grid grid-cards" aria-busy="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="skeleton" style={{ height: 150 }} />
          ))}
        </div>
      )}

      {projects?.length === 0 && (
        <div className="panel empty">
          <h2>Track your first project</h2>
          <p style={{ margin: 0, maxWidth: 440 }}>
            Add a folder on this computer to see its lines of code, languages, size on disk, commit
            activity, and a board for planning upcoming features.
          </p>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            ＋ Add project
          </button>
        </div>
      )}

      {projects && projects.length > 0 && (
        <>
          <section className="stats" aria-label="Portfolio summary">
            <StatTile label="Projects" value={projects.length} />
            <StatTile label="Lines of code" value={totals.code} />
            <BytesTile label="Size on disk" bytes={totals.bytes} />
            <StatTile label="Commits (30 days)" value={totals.commits30} />
            <StatTile
              label="Planned tasks"
              value={totals.open}
              hint="In Backlog or To do"
              to="/board?show=planned"
              linkTitle="Open the board on planned tasks across all projects"
            />
            <StatTile
              label="Being worked on"
              value={totals.active}
              hint="In progress or review"
              to="/board?show=active"
              linkTitle="Open the board on tasks being worked on across all projects"
            />
          </section>

          {attention.length > 0 && (
            <section className="panel" aria-label="Needs attention">
              <div className="panel-header">
                <h2>Needs attention</h2>
                <span className="meta">
                  {attention.length} project{attention.length === 1 ? '' : 's'}
                </span>
              </div>
              <ul
                className={`list attention-list phone-capped${expanded.has('attention') ? ' is-expanded' : ''}`}
              >
                {attention.map(({ project: p, kind, detail }) => (
                  <li key={`${p.id}-${kind}`}>
                    <span
                      className={`badge${kind === 'Folder missing' || kind === 'Scan failed' ? ' badge-danger' : ''}`}
                      style={{ flex: 'none' }}
                    >
                      {kind}
                    </span>
                    <Link to={projectHref(p.id)} className="truncate" style={{ flex: 1 }}>
                      {p.name}
                    </Link>
                    <span className="faint truncate" style={{ flex: 2 }} title={detail}>
                      {detail}
                    </span>
                  </li>
                ))}
              </ul>
              {attention.length > PHONE_LIST_ROWS && !expanded.has('attention') && (
                <button
                  type="button"
                  className="link-button phone-show-all"
                  onClick={() => showAll('attention')}
                >
                  Show all {attention.length}
                </button>
              )}
            </section>
          )}

          {inFlight.length > 0 && (
            <section className="panel" aria-label="Tasks being worked on across projects">
              <div className="panel-header">
                <h2>Being worked on</h2>
                <span className="meta">In progress or in review, across all projects</span>
              </div>
              <ul
                className={`list flight-list phone-capped${expanded.has('flight') ? ' is-expanded' : ''}`}
              >
                {inFlight.map((c) => (
                  <li key={c.id}>
                    <span className="badge" style={{ flex: 'none' }}>
                      {CARD_STATUS_LABELS[c.status]}
                    </span>
                    <span className="mono faint" style={{ flex: 'none' }}>
                      {c.key}
                    </span>
                    <Link
                      to={`/projects/${c.projectId}?tab=board`}
                      className="truncate"
                      style={{ flex: 1 }}
                      title={c.title}
                    >
                      {c.title}
                    </Link>
                    <span className="faint truncate" style={{ flex: 'none', maxWidth: '30%' }}>
                      {c.projectName} · {formatRelative(c.updatedAt)}
                    </span>
                  </li>
                ))}
              </ul>
              {inFlight.length > PHONE_LIST_ROWS && !expanded.has('flight') && (
                <button
                  type="button"
                  className="link-button phone-show-all"
                  onClick={() => showAll('flight')}
                >
                  Show all {inFlight.length}
                </button>
              )}
            </section>
          )}

          <section className="panel">
            <div className="panel-header">
              <h2>Languages across all projects</h2>
              <span className="meta">by lines of code</span>
            </div>
            {portfolioLanguages.length === 0 ? (
              <p className="faint">Waiting for the first scan…</p>
            ) : (
              <LanguageBar languages={portfolioLanguages} />
            )}
          </section>

          <CommitsByProject projects={projects} />

          <RankingsTable projects={projects} />

          <section className="grid grid-cards" aria-label="Tracked projects">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </section>
        </>
      )}

      <AddProjectDialog
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(project) => {
          setAdding(false);
          navigate(`/projects/${project.id}`);
        }}
        onAddedMany={(result) => {
          setAdding(false);
          load();
          if (result.added.length === 1) navigate(`/projects/${result.added[0]!.id}`);
        }}
      />
    </main>
  );
}

/** Portfolio rankings: every project in one sortable table. Column clicks follow the
    KDP sorter rule — a new column starts from its natural direction, clicking the
    active column reverses it. */
type RankKey =
  | 'project'
  | 'lines'
  | 'size'
  | 'commits'
  | 'commits30'
  | 'firstCommit'
  | 'lastCommit'
  | 'planned'
  | 'flight';
type RankDir = 'asc' | 'desc';

const RANK_DEFAULT_DIR: Record<RankKey, RankDir> = {
  project: 'asc',
  lines: 'desc',
  size: 'desc',
  commits: 'desc',
  commits30: 'desc',
  firstCommit: 'desc',
  lastCommit: 'desc',
  planned: 'desc',
  flight: 'desc',
};
const RANK_COLUMNS: { key: RankKey; label: string; numeric: boolean }[] = [
  { key: 'project', label: 'Project', numeric: false },
  { key: 'lines', label: 'Lines', numeric: true },
  { key: 'size', label: 'Size', numeric: true },
  { key: 'commits', label: 'Commits', numeric: true },
  { key: 'commits30', label: 'Commits 30d', numeric: true },
  { key: 'firstCommit', label: 'First commit', numeric: false },
  { key: 'lastCommit', label: 'Last commit', numeric: false },
  { key: 'planned', label: 'Planned', numeric: true },
  { key: 'flight', label: 'Active tasks', numeric: true },
];

/** Sort value for a column; null when the project has no data for it (not scanned, no git
    history), so such rows sort last in either direction instead of taking the top spots. */
function rankValue(p: ProjectSummary, key: RankKey): number | string | null {
  switch (key) {
    case 'project':
      return p.name.toLowerCase();
    case 'lines':
      return p.code?.code ?? null;
    case 'size':
      return p.disk?.bytes ?? null;
    case 'commits':
      return p.git?.isRepo ? p.git.totalCommits : null;
    case 'commits30':
      return recentCommits(p, 30);
    case 'firstCommit':
      return p.git?.firstCommitAt ? Date.parse(p.git.firstCommitAt) : null;
    case 'lastCommit':
      return p.git?.lastCommitAt ? Date.parse(p.git.lastCommitAt) : null;
    case 'planned':
      return p.cardCounts.backlog + p.cardCounts.todo;
    case 'flight':
      return p.cardCounts.in_progress + p.cardCounts.review;
  }
}

function RankingsTable({ projects }: { projects: ProjectSummary[] }) {
  const projectHref = useProjectHref();
  const [sortKey, setSortKey] = useState<RankKey>(() => {
    try {
      const saved = localStorage.getItem('pm-rank-sort');
      const parsed: unknown = saved ? JSON.parse(saved) : null;
      if (
        parsed &&
        typeof parsed === 'object' &&
        RANK_COLUMNS.some((c) => c.key === (parsed as { key: string }).key) &&
        ((parsed as { dir: string }).dir === 'asc' || (parsed as { dir: string }).dir === 'desc')
      ) {
        return (parsed as { key: RankKey }).key;
      }
    } catch {
      // Fall through to the default.
    }
    return 'lines';
  });
  const [sortDir, setSortDir] = useState<RankDir>(() => {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem('pm-rank-sort') ?? 'null');
      if (
        parsed &&
        typeof parsed === 'object' &&
        ((parsed as { dir: string }).dir === 'asc' || (parsed as { dir: string }).dir === 'desc')
      ) {
        return (parsed as { dir: RankDir }).dir;
      }
    } catch {
      // Fall through to the default.
    }
    return 'desc';
  });

  function choose(key: RankKey) {
    let next: { key: RankKey; dir: RankDir };
    if (key === sortKey) {
      next = { key, dir: sortDir === 'asc' ? 'desc' : 'asc' };
    } else {
      next = { key, dir: RANK_DEFAULT_DIR[key] };
    }
    setSortKey(next.key);
    setSortDir(next.dir);
    try {
      localStorage.setItem('pm-rank-sort', JSON.stringify(next));
    } catch {
      // Sorting still works for the session.
    }
  }

  const rows = useMemo(() => {
    // The comparator below is ascending; the arrow in the header shows sortDir, so follow it.
    const flip = sortDir === 'asc' ? 1 : -1;
    return [...projects].sort((a, b) => {
      const va = rankValue(a, sortKey);
      const vb = rankValue(b, sortKey);
      const byName = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      if (va === null || vb === null) return va === vb ? byName : va === null ? 1 : -1;
      const cmp = typeof va === 'string' ? va.localeCompare(vb as string) : va - (vb as number);
      return flip * cmp || byName;
    });
  }, [projects, sortKey, sortDir]);

  const topLines = Math.max(1, ...projects.map((p) => p.code?.code ?? 0));

  return (
    <section className="panel" aria-label="Project rankings">
      <div className="panel-header">
        <h2>Rankings</h2>
        <span className="meta">click a column to sort · click again to reverse</span>
      </div>
      <div className="table-wrap">
        <table className="table rank-table">
          <thead>
            <tr>
              <th aria-label="Rank">
                <span className="faint">#</span>
              </th>
              {RANK_COLUMNS.map((col) => (
                <th
                  key={col.key}
                  aria-sort={
                    sortKey === col.key
                      ? sortDir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={col.numeric ? 'r' : undefined}
                >
                  <button
                    type="button"
                    className={`rank-head${sortKey === col.key ? ' is-active' : ''}`}
                    onClick={() => choose(col.key)}
                    title={sortKey === col.key ? 'Reverse the order' : `Sort by ${col.label}`}
                  >
                    {col.label}
                    <span aria-hidden="true" className="rank-arrow">
                      {sortKey === col.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                    </span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((p, i) => (
              <tr key={p.id}>
                <td className="faint num">{i + 1}</td>
                <td>
                  <Link to={projectHref(p.id)} title={p.path}>
                    {p.name}
                  </Link>
                  {p.missing && <span className="badge badge-danger">missing</span>}
                </td>
                <td className="r num">
                  <span className="rank-bar" aria-hidden="true">
                    <span
                      style={{ width: `${(((p.code?.code ?? 0) / topLines) * 100).toFixed(1)}%` }}
                    />
                  </span>{' '}
                  {p.code ? formatCompact(p.code.code) : '—'}
                </td>
                <td className="r num">{p.disk ? formatBytes(p.disk.bytes) : '—'}</td>
                <td className="r num">{p.git?.isRepo ? formatNumber(p.git.totalCommits) : '—'}</td>
                <td className="r num">{p.git ? formatNumber(recentCommits(p, 30)) : '—'}</td>
                <td title={formatRelative(p.git?.firstCommitAt ?? null)}>
                  {formatDate(p.git?.firstCommitAt ?? null)}
                </td>
                <td title={formatDate(p.git?.lastCommitAt ?? null)}>
                  {p.git?.lastCommitAt ? formatRelative(p.git.lastCommitAt) : '—'}
                </td>
                <td className="r num">{p.cardCounts.backlog + p.cardCounts.todo}</td>
                <td className="r num">{p.cardCounts.in_progress + p.cardCounts.review}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ProjectCard({ project: p }: { project: ProjectSummary }) {
  const projectHref = useProjectHref();
  const flight = p.cardCounts.in_progress + p.cardCounts.review;
  return (
    <Link to={projectHref(p.id)} className="project-card">
      <div>
        <div
          style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}
        >
          <h2 className="truncate">{p.name}</h2>
          {p.missing ? (
            <span className="badge badge-danger">Folder missing</span>
          ) : p.scan.status === 'scanning' ? (
            <span className="badge">
              <span className="spinner" style={{ width: 10, height: 10 }} /> Scanning
            </span>
          ) : p.git?.branch ? (
            <span className="badge mono">⎇ {p.git.branch}</span>
          ) : null}
        </div>
        <div className="path truncate" title={p.path}>
          {p.path}
        </div>
      </div>

      {p.code ? (
        <LanguageBar languages={p.code.languages} showLegend={false} />
      ) : (
        <div className="langbar skeleton" />
      )}

      <div className="figures">
        <div>
          <b>{p.code ? formatCompact(p.code.code) : '—'}</b>
          <span>lines</span>
        </div>
        <div>
          <b>{p.code ? formatCompact(p.code.totalFiles) : '—'}</b>
          <span>files</span>
        </div>
        <div>
          <b>{p.disk ? formatBytes(p.disk.bytes) : '—'}</b>
          <span>on disk</span>
        </div>
        <div>
          <b>{p.git?.isRepo ? formatCompact(p.git.totalCommits) : '—'}</b>
          <span>commits</span>
        </div>
      </div>

      <div
        className="board-strip faint"
        style={{ fontSize: 12.5, justifyContent: 'space-between' }}
      >
        <span>
          {p.code?.languages[0]?.name ?? 'No code yet'}
          {' · '}
          {p.git?.lastCommitAt ? `last commit ${formatRelative(p.git.lastCommitAt)}` : 'no commits'}
        </span>
        <span>
          {flight > 0 && (
            <span
              className="badge"
              title={`${CARD_STATUS_LABELS.in_progress} + ${CARD_STATUS_LABELS.review}`}
            >
              {flight} active
            </span>
          )}{' '}
          {p.cardCounts.backlog + p.cardCounts.todo > 0 && (
            <span className="badge">{p.cardCounts.backlog + p.cardCounts.todo} planned</span>
          )}
        </span>
      </div>
    </Link>
  );
}
