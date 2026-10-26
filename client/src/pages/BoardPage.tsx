import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  CARD_STATUSES,
  CARD_STATUS_LABELS,
  type Card,
  type CardStatus,
  type CardWithProject,
  type ProjectSummary,
} from '../../../shared/types';
import { serialPoll } from '../lib/serialPoll';
import { api } from '../api';
import { useBoardView, useStoredChoice } from '../boardView';
import { BoardListView, BoardViewTabs } from '../components/BoardListView';
import { CardDialog } from '../components/CardDialog';
import { Dropdown } from '../components/Dropdown';
import { NewCardDialog } from '../components/NewCardDialog';
import { formatRelative } from '../format';
import { useStuckTop } from '../stuckTop';

// One board across every project (Notion-style: a board view whose cards carry a project tag).
// ?show=planned|active narrows the columns (the dashboard's tiles link here), ?project=<id>
// narrows to one project. Drag a card to move it; open it to edit, change its column from the
// keyboard, or hand it to an agent, exactly as on a project's own board.

type Show = 'all' | 'planned' | 'active';
const SHOW_COLUMNS: Record<Show, readonly CardStatus[]> = {
  all: CARD_STATUSES,
  planned: ['backlog', 'todo'],
  active: ['in_progress', 'review'],
};
const SHOW_OPTIONS: { value: Show; label: string; title: string }[] = [
  { value: 'all', label: 'All cards', title: 'Every column' },
  { value: 'planned', label: 'Planned', title: 'Backlog and To do' },
  { value: 'active', label: 'Being worked on', title: 'In progress and Review' },
];
const SERIES_SLOTS = 7;

const parseShow = (v: string | null): Show => (v === 'planned' || v === 'active' ? v : 'all');

/** The project tag shown on a card; 0 is the cross-project "All projects" board (PM-138). */
const projectNameOf = (projects: ProjectSummary[], projectId: number): string =>
  projects.find((p) => p.id === projectId)?.name || (projectId ? '' : 'All projects');

/**
 * Done cards drawn until "Show older" is pressed (newest first, as the server lists them). Done
 * grows without end (225 cards in Oct 2026) and drawing them all doubled the time to open the
 * board; the working columns always show every card, so nothing waiting on you is hidden.
 */
const DONE_LIMIT = 40;

// View options (PM-296), saved per browser: what Linear, Jira and GitHub Projects offer on a
// board with hundreds of cards.
const DENSITIES = ['comfortable', 'compact'] as const;
const GROUPINGS = ['none', 'project'] as const;
/** In progress turns amber past this many cards (0: no limit). Kanban's WIP limit. */
const WIP_LIMITS = ['0', '3', '5', '8', '12'] as const;

/** Every word of the filter appears in the card's title, key or project. */
const matchesFilter = (card: CardWithProject, words: string[]) => {
  const text = `${card.title} ${card.key} ${card.projectName}`.toLowerCase();
  return words.every((w) => text.includes(w));
};

/** Focus is in a text field, where "/" is typed rather than a shortcut. */
const typingIn = (el: EventTarget | null) =>
  el instanceof HTMLElement &&
  (el.isContentEditable || !!el.closest('input, textarea, select, .xterm'));

export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const show = parseShow(params.get('show'));
  const projectFilter = Number(params.get('project')) || null;
  const cardParam = Number(params.get('card')) || null;
  const [cards, setCards] = useState<CardWithProject[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [explicitCard, setExplicitCard] = useState<CardWithProject | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<CardStatus | null>(null);
  // Adding: the column whose + was clicked (null = closed).
  const [addingTo, setAddingTo] = useState<CardStatus | null>(null);
  // Done shows every card once "Show older" is pressed (until the page is left).
  const [expanded, setExpanded] = useState<ReadonlySet<CardStatus>>(() => new Set());
  const [view, setView] = useBoardView();
  const stuckTop = useStuckTop();

  const openCard =
    explicitCard ?? (cardParam && cards ? (cards.find((c) => c.id === cardParam) ?? null) : null);
  const setOpenCard = (c: CardWithProject | null) => {
    setExplicitCard(c);
    if (!c && cardParam) setParam('card', null);
  };

  useEffect(() => {
    let active = true;
    const load = () =>
      api.listAllCards().then(
        (list) => {
          if (!active) return;
          setCards(list);
          setError(null);
        },
        (e: Error) => active && setError(e.message),
      );
    api.listProjects().then(
      (p) => active && setProjects(p),
      () => undefined,
    );
    // Commits and agents move cards too; keep the board current without a reload. Not while the
    // tab is hidden, and one read at a time (an unchanged list revalidates as a bodiless 304).
    const stop = serialPoll(load, 10_000, { pauseWhenHidden: true });
    return () => {
      active = false;
      stop();
    };
  }, []);

  // A project keeps its tag colour: categorical slots in fixed order by project id.
  const colorOf = useMemo(() => {
    const ids = [
      ...new Set([...projects.map((p) => p.id), ...(cards ?? []).map((c) => c.projectId)]),
    ].sort((a, b) => a - b);
    return new Map(ids.map((id, i) => [id, `var(--series-${(i % SERIES_SLOTS) + 1})`]));
  }, [projects, cards]);

  const setParam = (key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value === null) next.delete(key);
    else next.set(key, value);
    setParams(next, { replace: true });
  };

  const [density, setDensity] = useStoredChoice('pm.board.density', DENSITIES, 'comfortable');
  const [grouping, setGrouping] = useStoredChoice('pm.board.group', GROUPINGS, 'none');
  const [wip, setWip] = useStoredChoice('pm.board.wip', WIP_LIMITS, '0');
  const wipLimit = Number(wip);
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  // Phones keep the filter behind a search button (the field takes a row of its own).
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || filter !== '';
  // "/" jumps to the filter, as in GitHub, Linear and Gmail; Esc in it clears it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || typingIn(e.target)) return;
      if (document.querySelector('dialog[open]')) return;
      e.preventDefault();
      setSearchOpen(true);
      filterRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const visible = (cards ?? []).filter(
    (c) => (!projectFilter || c.projectId === projectFilter) && matchesFilter(c, words),
  );
  const columns = SHOW_COLUMNS[show];

  async function move(card: CardWithProject, status: CardStatus) {
    if (card.status === status) return;
    // Optimistic: the card moves at once; a failure puts it back.
    const before = cards;
    // The server lists newest first, so the moved card goes to the front of its new column (and
    // so is never hidden past Done's cap, below).
    setCards((prev) =>
      prev
        ? [
            { ...card, status, updatedAt: new Date().toISOString() },
            ...prev.filter((c) => c.id !== card.id),
          ]
        : prev,
    );
    try {
      const saved = await api.updateCard(card.id, { status });
      setCards((prev) => prev?.map((c) => (c.id === saved.id ? { ...c, ...saved } : c)) ?? prev);
    } catch (e) {
      setCards(before);
      setError((e as Error).message);
    }
  }

  // A saved card may have been moved to another project from the dialog, so its tag is refreshed
  // from the project that now owns it (PM-154).
  const replace = (saved: Card) =>
    setCards(
      (prev) =>
        prev?.map((c) =>
          c.id === saved.id
            ? { ...c, ...saved, projectName: projectNameOf(projects, saved.projectId) }
            : c,
        ) ?? prev,
    );

  const renderCard = (c: CardWithProject): ReactNode => (
    <button
      key={c.id}
      type="button"
      className="gcard"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', c.key);
        setDragId(c.id);
      }}
      onDragEnd={() => {
        setDragId(null);
        setDropOn(null);
      }}
      onClick={() => setOpenCard(c)}
      title="Open to edit, change its column or hand it to an agent · drag to move"
    >
      <span className="gcard-title">{c.title}</span>
      <span className="gcard-meta">
        <span className="project-tag" style={{ ['--tag' as string]: colorOf.get(c.projectId) }}>
          {c.projectName || 'All projects'}
        </span>
        <span className="mono faint">{c.key}</span>
        <span className="faint" title={c.updatedAt}>
          {formatRelative(c.updatedAt)}
        </span>
      </span>
    </button>
  );

  return (
    <main className="page board-page">
      {/* Sticky chrome like project pages: title, filters and the view switch stay put while
          the columns scroll underneath. */}
      <div className="sticky-head">
        <div className="page-header">
          <div>
            <h1>Board</h1>
            <div className="subtitle">
              Every card across your projects
              {cards && (
                <span className="faint">
                  {' '}
                  · {visible.length} card{visible.length === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </div>
          <div className="actions">
            <button
              type="button"
              className="icon-btn board-search-toggle"
              aria-label={searching ? 'Close the filter' : 'Filter cards'}
              aria-expanded={searching}
              title={searching ? 'Close the filter (clears it)' : 'Filter cards'}
              onClick={() => {
                if (searching) {
                  setSearchOpen(false);
                  setFilter('');
                } else {
                  setSearchOpen(true);
                  // After the field is shown.
                  requestAnimationFrame(() => filterRef.current?.focus());
                }
              }}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
                <path
                  d="M10.5 10.5 14 14"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                />
              </svg>
            </button>
            <button
              type="button"
              className="btn btn-primary board-new"
              onClick={() => setAddingTo(columns[0]!)}
              title="Add a card to one of your projects"
            >
              <span className="board-new-desktop">＋ New card</span>
              <span className="board-new-mobile">＋ New</span>
            </button>
            <Dropdown
              label="Project"
              value={projectFilter ?? 0}
              options={[
                { value: 0, label: 'All projects' },
                ...projects.map((p) => ({ value: p.id, label: p.name })),
              ]}
              onChange={(v) => setParam('project', v ? String(v) : null)}
            />
            <Dropdown
              label="Show"
              value={show}
              options={SHOW_OPTIONS}
              onChange={(v) => setParam('show', v === 'all' ? null : v)}
            />
          </div>
        </div>

        <div className={`board-tools${searching ? ' is-searching' : ''}`}>
          <BoardViewTabs view={view} onChange={setView} />
          <input
            ref={filterRef}
            type="search"
            className="input board-filter"
            placeholder="Filter cards"
            title="Filter by title, key or project (press / to jump here)"
            aria-label="Filter cards by title, key or project (press / to focus)"
            aria-keyshortcuts="/"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && filter) {
                e.stopPropagation();
                setFilter('');
              }
            }}
          />
          {view === 'board' && (
            <div className="board-options">
              <Dropdown
                label="Density"
                value={density}
                options={[
                  { value: 'comfortable', label: 'Comfortable' },
                  { value: 'compact', label: 'Compact', title: 'One line per card' },
                ]}
                onChange={setDensity}
              />
              <Dropdown
                label="Group"
                value={grouping}
                options={[
                  { value: 'none', label: 'No grouping' },
                  { value: 'project', label: 'Group by project' },
                ]}
                onChange={setGrouping}
              />
              <Dropdown
                label="Work-in-progress limit"
                value={wip}
                options={WIP_LIMITS.map((v) => ({
                  value: v,
                  label: v === '0' ? 'No WIP limit' : `WIP limit ${v}`,
                  title: 'In progress turns amber past this many cards',
                }))}
                onChange={setWip}
              />
            </div>
          )}
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {cards === null ? (
        view === 'list' ? (
          <div className="blist" aria-busy="true">
            {columns.map((s) => (
              <div key={s} className="skeleton blist-skeleton" />
            ))}
          </div>
        ) : (
          <div className="gboard" style={{ gridTemplateColumns: `repeat(${columns.length}, 1fr)` }}>
            {columns.map((s) => (
              <div key={s} className="gcolumn skeleton" style={{ minHeight: 240 }} />
            ))}
          </div>
        )
      ) : view === 'list' ? (
        <BoardListView
          columns={columns}
          cards={visible}
          onOpen={setOpenCard}
          onAdd={setAddingTo}
          onToggleDone={(card, done) => void move(card, done ? 'done' : 'todo')}
          meta={(c) => (
            <>
              <span
                className="project-tag"
                style={{ ['--tag' as string]: colorOf.get(c.projectId) }}
              >
                {c.projectName || 'All projects'}
              </span>
              <span className="mono">{c.key}</span>
              <span title={c.updatedAt}>{formatRelative(c.updatedAt)}</span>
            </>
          )}
        />
      ) : (
        <div
          ref={stuckTop}
          className={`gboard${density === 'compact' ? ' is-compact' : ''}`}
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
        >
          {columns.map((status) => {
            const items = visible.filter((c) => c.status === status);
            // A filter shows every match: an old Done card searched for is never left behind.
            const capped = status === 'done' && !expanded.has(status) && words.length === 0;
            const shown = capped ? items.slice(0, DONE_LIMIT) : items;
            return (
              <section
                key={status}
                className={`gcolumn${dropOn === status ? ' is-drop' : ''}`}
                aria-label={CARD_STATUS_LABELS[status]}
                onDragOver={(e: DragEvent) => {
                  if (dragId === null) return;
                  e.preventDefault();
                  if (dropOn !== status) setDropOn(status);
                }}
                onDragLeave={() => setDropOn(null)}
                onDrop={(e: DragEvent) => {
                  e.preventDefault();
                  const card = cards.find((c) => c.id === dragId);
                  setDragId(null);
                  setDropOn(null);
                  if (card) void move(card, status);
                }}
              >
                {/* Sticks under the page header while the column scrolls (see .col-stick). */}
                <div className="col-stick">
                  <header className="gcolumn-head">
                    <h2>
                      <span className={`status-pill status-${status}`}>
                        {CARD_STATUS_LABELS[status]}
                      </span>
                    </h2>
                    {status === 'in_progress' && wipLimit > 0 ? (
                      <span
                        className={`num gcolumn-wip${items.length > wipLimit ? ' is-over' : ''}`}
                        title={
                          items.length > wipLimit
                            ? `Over the work-in-progress limit of ${wipLimit}`
                            : `Work-in-progress limit: ${wipLimit}`
                        }
                      >
                        {items.length}/{wipLimit}
                        {items.length > wipLimit && ' over'}
                      </span>
                    ) : (
                      <span className="faint num">{items.length}</span>
                    )}
                    <button
                      type="button"
                      className="icon-btn gcolumn-add"
                      aria-label={`Add a card to ${CARD_STATUS_LABELS[status]}`}
                      title={`Add a card to ${CARD_STATUS_LABELS[status]}`}
                      onClick={() => setAddingTo(status)}
                    >
                      ＋
                    </button>
                  </header>
                </div>
                <div className="gcolumn-cards">
                  {grouping === 'project'
                    ? groupByProject(shown).map(([name, group]) => (
                        <div key={name} className="gcolumn-group">
                          <h3 className="gcolumn-group-head">
                            <span className="truncate">{name}</span>
                            <span className="faint num">{group.length}</span>
                          </h3>
                          {group.map(renderCard)}
                        </div>
                      ))
                    : shown.map(renderCard)}
                  {items.length > shown.length && (
                    <button
                      type="button"
                      className="btn gcolumn-more"
                      onClick={() => setExpanded((prev) => new Set(prev).add(status))}
                    >
                      Show {items.length - shown.length} older
                    </button>
                  )}
                  {items.length === 0 && <p className="faint gcolumn-empty">No cards here.</p>}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {cards && cards.length === 0 && (
        <p className="faint">
          No cards yet. Open a project and add cards to its <Link to="/">board</Link>.
        </p>
      )}

      <NewCardDialog
        open={addingTo !== null}
        status={addingTo ?? 'backlog'}
        projectId={projectFilter ?? 0}
        projects={projects}
        onClose={() => setAddingTo(null)}
        onCreated={(created) => {
          const withProject: CardWithProject = {
            ...created,
            projectName: projectNameOf(projects, created.projectId),
          };
          setCards((prev) => [withProject, ...(prev ?? [])]);
          setAddingTo(null);
          // The card is created and the dialog closes (PM-142): no second round to Save. Open
          // the card from the board for images, notes or an agent hand-off.
        }}
      />
      <CardDialog
        card={openCard}
        projectId={openCard?.projectId ?? 0}
        projects={projects}
        onClose={() => {
          setOpenCard(null);
          setParam('card', null);
        }}
        onSaved={(saved) => {
          replace(saved);
          setOpenCard(null);
          setParam('card', null);
        }}
        onDeleted={(id) => {
          setCards((prev) => prev?.filter((c) => c.id !== id) ?? prev);
          setOpenCard(null);
          setParam('card', null);
        }}
      />
    </main>
  );
}

/** A column's cards under one heading per project, projects A–Z, newest first within each. */
function groupByProject(cards: CardWithProject[]): [string, CardWithProject[]][] {
  const groups = new Map<string, CardWithProject[]>();
  for (const c of cards) {
    const name = c.projectName || 'All projects';
    groups.set(name, [...(groups.get(name) ?? []), c]);
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b));
}
