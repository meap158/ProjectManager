import { useCallback, useEffect, useState, type CSSProperties, type DragEvent } from 'react';
import {
  BOARD_PRESET_COLUMNS,
  CARD_STATUS_LABELS,
  type BoardPreset,
  type Card,
  type CardRunSummary,
  type CardStatus,
} from '../../../shared/types';
import { api } from '../api';
import { useBoardView } from '../boardView';
import { formatRelative, movedBy } from '../format';
import { BoardListView, BoardViewTabs } from './BoardListView';
import { CardDialog } from './CardDialog';
import { NewCardDialog } from './NewCardDialog';

/** Midpoint ordering: a card's position sits between its neighbours, so a move is one update. */
function positionBetween(before: Card | undefined, after: Card | undefined): number {
  if (!before && !after) return 1000;
  if (!before) return after!.position - 1000;
  if (!after) return before.position + 1000;
  return (before.position + after.position) / 2;
}

// Tab memory (KDP ManuscriptViewer pattern): the board unmounts never while switching tabs
// (ProjectPage keeps panels mounted), but a revisit must still be instant. Module-scope caches
// survive component lifetime; the project page keys the board by project so each project reads
// its own entry and background refreshes keep it fresh.
const cardCache = new Map<number, Card[]>();
const runCache = new Map<number, CardRunSummary[]>();

export function KanbanBoard({
  projectId,
  reloadKey,
  preset = 'full',
}: {
  projectId: number;
  reloadKey: number;
  preset?: BoardPreset;
}) {
  const [cards, setCards] = useState<Card[] | null>(() => cardCache.get(projectId) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    status: CardStatus;
    beforeId: number | null;
  } | null>(null);
  const [adding, setAdding] = useState<CardStatus | null>(null);
  const [editing, setEditing] = useState<Card | null>(null);
  const [runSummary, setRunSummary] = useState<Map<number, CardRunSummary>>(
    () => new Map((runCache.get(projectId) ?? []).map((s) => [s.cardId, s])),
  );
  const [view, setView] = useBoardView();

  // Write-through cache: every cards update lands in the module cache too, so tab
  // switches and revisits render instantly and refresh in the background.
  const updateCards = useCallback(
    (updater: (prev: Card[] | null) => Card[] | null) => {
      setCards((prev) => {
        const next = updater(prev);
        if (next) cardCache.set(projectId, next);
        return next;
      });
    },
    [projectId],
  );

  // Loaders only set state in promise callbacks, so effects may call them directly.
  const load = useCallback(
    () =>
      api.listCards(projectId).then(
        (next) => {
          cardCache.set(projectId, next);
          setCards(next);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [projectId],
  );

  const loadRuns = useCallback(
    () =>
      api.runSummaries(projectId).then(
        (summaries) => {
          runCache.set(projectId, summaries);
          setRunSummary(new Map(summaries.map((s) => [s.cardId, s])));
        },
        // Agent runs are advisory: a failed lookup must not break the board.
        () => undefined,
      ),
    [projectId],
  );

  useEffect(() => {
    load();
    loadRuns();
  }, [load, loadRuns, reloadKey]);

  const column = (status: CardStatus) =>
    (cards ?? []).filter((c) => c.status === status).sort((a, b) => a.position - b.position);

  async function moveCard(cardId: number, status: CardStatus, beforeId: number | null) {
    const target = column(status).filter((c) => c.id !== cardId);
    const index = beforeId === null ? target.length : target.findIndex((c) => c.id === beforeId);
    const at = index === -1 ? target.length : index;
    const position = positionBetween(target[at - 1], target[at]);
    // Optimistic update; reload from the server if it fails.
    updateCards(
      (prev) => prev?.map((c) => (c.id === cardId ? { ...c, status, position } : c)) ?? prev,
    );
    try {
      const saved = await api.updateCard(cardId, { status, position });
      updateCards((prev) => prev?.map((c) => (c.id === cardId ? saved : c)) ?? prev);
    } catch (e) {
      setError((e as Error).message);
      load();
    }
  }

  function onDragOver(event: DragEvent, status: CardStatus, beforeId: number | null) {
    if (dragId === null) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = 'move';
    if (dropTarget?.status !== status || dropTarget.beforeId !== beforeId) {
      setDropTarget({ status, beforeId });
    }
  }

  function onDrop(event: DragEvent) {
    event.preventDefault();
    if (dragId !== null && dropTarget) moveCard(dragId, dropTarget.status, dropTarget.beforeId);
    setDragId(null);
    setDropTarget(null);
  }

  const columns = BOARD_PRESET_COLUMNS[preset] ?? BOARD_PRESET_COLUMNS.full;
  // Cards in hidden statuses keep their status: they stay in the data (and in counts,
  // auto-moves and validation) and reappear when the preset changes back.
  const hidden = (cards ?? []).filter((c) => !columns.includes(c.status));

  const tabs = <BoardViewTabs view={view} onChange={setView} />;
  if (error && !cards) return <div className="error-banner">{error}</div>;
  if (!cards) {
    return (
      <>
        {tabs}
        {view === 'list' ? (
          <div className="blist" aria-busy="true">
            {columns.map((s) => (
              <div key={s} className="skeleton blist-skeleton" />
            ))}
          </div>
        ) : (
          <div
            className="board"
            aria-busy="true"
            style={{ '--board-cols': columns.length } as CSSProperties}
          >
            {columns.map((s) => (
              <div key={s} className="column skeleton" />
            ))}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      {tabs}
      {view === 'list' ? (
        <BoardListView
          columns={columns}
          cards={columns.flatMap(column)}
          onOpen={setEditing}
          onAdd={setAdding}
          meta={(card) => (
            <>
              <span className="mono">{card.key}</span>
              <RunBadges summary={runSummary.get(card.id)} />
              {card.linkedCommit && (
                <span
                  className="truncate"
                  style={{ maxWidth: 120 }}
                  title={`Moved automatically by ${movedBy(card.linkedCommit).label}`}
                >
                  ⎇ {movedBy(card.linkedCommit).short}
                </span>
              )}
              <span>{formatRelative(card.updatedAt)}</span>
            </>
          )}
        />
      ) : (
        <div
          className="board"
          style={{ '--board-cols': columns.length } as CSSProperties}
          onDragEnd={() => (setDragId(null), setDropTarget(null))}
        >
          {columns.map((status) => {
            const items = column(status);
            return (
              <section
                key={status}
                className={`column${dropTarget?.status === status && dropTarget.beforeId === null ? ' drop-target' : ''}`}
                aria-label={CARD_STATUS_LABELS[status]}
                onDragOver={(e) => onDragOver(e, status, null)}
                onDrop={onDrop}
              >
                <div className="column-header">
                  <h3>
                    {/* Same coloured status pill as the List view's group headers. */}
                    <span className={`status-pill status-${status}`}>
                      {CARD_STATUS_LABELS[status]}
                    </span>{' '}
                    <span className="badge">{items.length}</span>
                  </h3>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={() => setAdding(status)}
                    aria-label={`Add card to ${CARD_STATUS_LABELS[status]}`}
                  >
                    ＋
                  </button>
                </div>

                {items.map((card) => (
                  <button
                    key={card.id}
                    className={[
                      'kcard',
                      dragId === card.id && 'dragging',
                      dropTarget?.beforeId === card.id && 'drop-before',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    draggable
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = 'move';
                      e.dataTransfer.setData('text/plain', card.key);
                      setDragId(card.id);
                    }}
                    onDragOver={(e) => onDragOver(e, status, card.id)}
                    onDrop={onDrop}
                    onClick={() => setEditing(card)}
                  >
                    <span className="title">{card.title}</span>
                    <span className="meta">
                      <span className="mono">{card.key}</span>
                      <RunBadges summary={runSummary.get(card.id)} />
                      {card.linkedCommit && (
                        <span title={`Moved by commit ${card.linkedCommit}`}>
                          ⎇ {card.linkedCommit.slice(0, 7)}
                        </span>
                      )}
                      <span>{formatRelative(card.updatedAt)}</span>
                    </span>
                  </button>
                ))}

                {items.length === 0 && (
                  <p className="faint" style={{ margin: '4px', fontSize: 12.5 }}>
                    {status === 'backlog' ? 'Capture upcoming features here.' : 'Drop cards here.'}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}

      {hidden.length > 0 && (
        <p className="faint hidden-strip" role="status">
          {hidden.length} card{hidden.length === 1 ? '' : 's'} in hidden{' '}
          {hidden.length === 1 ? 'column' : 'columns'} (
          {[...new Set(hidden.map((c) => CARD_STATUS_LABELS[c.status]))].join(', ')}) — change the
          board preset in Settings to show {hidden.length === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/* + opens the full New card dialog (title, column, notes); creating it opens the card
          itself so images and "hand to an agent" are right there. */}
      <NewCardDialog
        open={adding !== null}
        status={adding ?? 'backlog'}
        projectId={projectId}
        onClose={() => setAdding(null)}
        onCreated={(card) => {
          updateCards((prev) => [...(prev ?? []), card]);
          setAdding(null);
          setEditing(card);
        }}
      />
      <CardDialog
        card={editing}
        projectId={projectId}
        liveSessionId={editing ? (runSummary.get(editing.id)?.liveSessionId ?? null) : null}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          updateCards((prev) => prev?.map((c) => (c.id === saved.id ? saved : c)) ?? prev);
          setEditing(null);
        }}
        onDeleted={(id) => {
          updateCards((prev) => prev?.filter((c) => c.id !== id) ?? prev);
          setEditing(null);
        }}
        onDispatched={() => {
          loadRuns();
          load();
        }}
      />
    </>
  );
}

/** Quil-style attention badges: live session, running, awaiting validation, failed. */
function RunBadges({ summary }: { summary: CardRunSummary | undefined }) {
  if (!summary) return null;
  return (
    <>
      {summary.liveSessionId !== null && (
        <span className="badge badge-live" title="A live terminal session is working on this card">
          ⌨ live
        </span>
      )}
      {summary.running > 0 && (
        <span className="badge" title={`${summary.running} agent run(s) still running`}>
          ▶ {summary.running}
        </span>
      )}
      {summary.awaitingValidation > 0 && (
        <span className="badge badge-attention" title="Run finished — validate to move this card">
          ✓ {summary.awaitingValidation}
        </span>
      )}
      {summary.failed > 0 && summary.running === 0 && summary.awaitingValidation === 0 && (
        <span className="badge badge-danger" title={`${summary.failed} run(s) failed`}>
          ✗ {summary.failed}
        </span>
      )}
    </>
  );
}
