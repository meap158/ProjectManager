import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  CARD_STATUSES,
  CARD_STATUS_LABELS,
  type Card,
  type CardStatus,
  type CardWithProject,
  type ProjectSummary,
} from '../../../shared/types';
import { api } from '../api';
import { useBoardView } from '../boardView';
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

export function BoardPage() {
  const [params, setParams] = useSearchParams();
  const show = parseShow(params.get('show'));
  const projectFilter = Number(params.get('project')) || null;
  const [cards, setCards] = useState<CardWithProject[] | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openCard, setOpenCard] = useState<CardWithProject | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropOn, setDropOn] = useState<CardStatus | null>(null);
  // Adding: the column whose + was clicked (null = closed).
  const [addingTo, setAddingTo] = useState<CardStatus | null>(null);
  const [view, setView] = useBoardView();
  const stuckTop = useStuckTop();

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
    load();
    api.listProjects().then(
      (p) => active && setProjects(p),
      () => undefined,
    );
    // Commits and agents move cards too; keep the board current without a reload.
    const timer = setInterval(load, 10_000);
    return () => {
      active = false;
      clearInterval(timer);
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

  const visible = (cards ?? []).filter((c) => !projectFilter || c.projectId === projectFilter);
  const columns = SHOW_COLUMNS[show];

  async function move(card: CardWithProject, status: CardStatus) {
    if (card.status === status) return;
    // Optimistic: the card moves at once; a failure puts it back.
    const before = cards;
    setCards(
      (prev) =>
        prev?.map((c) =>
          c.id === card.id ? { ...c, status, updatedAt: new Date().toISOString() } : c,
        ) ?? prev,
    );
    try {
      const saved = await api.updateCard(card.id, { status });
      setCards((prev) => prev?.map((c) => (c.id === saved.id ? { ...c, ...saved } : c)) ?? prev);
    } catch (e) {
      setCards(before);
      setError((e as Error).message);
    }
  }

  const replace = (saved: Card) =>
    setCards((prev) => prev?.map((c) => (c.id === saved.id ? { ...c, ...saved } : c)) ?? prev);

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
              className="btn btn-primary"
              onClick={() => setAddingTo(columns[0]!)}
              title="Add a card to one of your projects"
            >
              ＋ New card
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

        <BoardViewTabs view={view} onChange={setView} />
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
                {c.projectName}
              </span>
              <span className="mono">{c.key}</span>
              <span title={c.updatedAt}>{formatRelative(c.updatedAt)}</span>
            </>
          )}
        />
      ) : (
        <div
          ref={stuckTop}
          className="gboard"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0, 1fr))` }}
        >
          {columns.map((status) => {
            const items = visible.filter((c) => c.status === status);
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
                    <span className="faint num">{items.length}</span>
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
                  {items.map((c) => (
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
                        <span
                          className="project-tag"
                          style={{ ['--tag' as string]: colorOf.get(c.projectId) }}
                        >
                          {c.projectName}
                        </span>
                        <span className="mono faint">{c.key}</span>
                        <span className="faint" title={c.updatedAt}>
                          {formatRelative(c.updatedAt)}
                        </span>
                      </span>
                    </button>
                  ))}
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
        {...(projectFilter ? { projectId: projectFilter } : { projects })}
        onClose={() => setAddingTo(null)}
        onCreated={(created) => {
          const withProject: CardWithProject = {
            ...created,
            projectName: projects.find((p) => p.id === created.projectId)?.name ?? '',
          };
          setCards((prev) => [withProject, ...(prev ?? [])]);
          setAddingTo(null);
          // Straight into the full dialog: images, notes, hand to an agent.
          setOpenCard(withProject);
        }}
      />
      <CardDialog
        card={openCard}
        projectId={openCard?.projectId ?? 0}
        onClose={() => setOpenCard(null)}
        onSaved={(saved) => {
          replace(saved);
          setOpenCard(null);
        }}
        onDeleted={(id) => {
          setCards((prev) => prev?.filter((c) => c.id !== id) ?? prev);
          setOpenCard(null);
        }}
      />
    </main>
  );
}
