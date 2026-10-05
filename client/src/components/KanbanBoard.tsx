import { useCallback, useEffect, useState, type DragEvent, type FormEvent } from 'react';
import {
  CARD_STATUSES,
  CARD_STATUS_LABELS,
  type Card,
  type CardRunSummary,
  type CardStatus,
} from '../../../shared/types';
import { api } from '../api';
import { formatRelative } from '../format';
import { CardDialog } from './CardDialog';

/** Midpoint ordering: a card's position sits between its neighbours, so a move is one update. */
function positionBetween(before: Card | undefined, after: Card | undefined): number {
  if (!before && !after) return 1000;
  if (!before) return after!.position - 1000;
  if (!after) return before.position + 1000;
  return (before.position + after.position) / 2;
}

export function KanbanBoard({ projectId, reloadKey }: { projectId: number; reloadKey: number }) {
  const [cards, setCards] = useState<Card[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    status: CardStatus;
    beforeId: number | null;
  } | null>(null);
  const [adding, setAdding] = useState<CardStatus | null>(null);
  const [editing, setEditing] = useState<Card | null>(null);
  const [runSummary, setRunSummary] = useState<Map<number, CardRunSummary>>(new Map());

  // Loaders only set state in promise callbacks, so effects may call them directly.
  const load = useCallback(
    () =>
      api.listCards(projectId).then(
        (next) => {
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
        (summaries) => setRunSummary(new Map(summaries.map((s) => [s.cardId, s]))),
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
    setCards(
      (prev) => prev?.map((c) => (c.id === cardId ? { ...c, status, position } : c)) ?? prev,
    );
    try {
      const saved = await api.updateCard(cardId, { status, position });
      setCards((prev) => prev?.map((c) => (c.id === cardId ? saved : c)) ?? prev);
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

  if (error && !cards) return <div className="error-banner">{error}</div>;
  if (!cards) {
    return (
      <div className="board" aria-busy="true">
        {CARD_STATUSES.map((s) => (
          <div key={s} className="column skeleton" />
        ))}
      </div>
    );
  }

  return (
    <>
      {error && <div className="error-banner">{error}</div>}
      <div className="board" onDragEnd={() => (setDragId(null), setDropTarget(null))}>
        {CARD_STATUSES.map((status) => {
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
                  {CARD_STATUS_LABELS[status]} <span className="badge">{items.length}</span>
                </h3>
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setAdding(status)}
                  aria-label={`Add card to ${CARD_STATUS_LABELS[status]}`}
                >
                  ＋
                </button>
              </div>

              {adding === status && (
                <QuickAdd
                  onCancel={() => setAdding(null)}
                  onSubmit={async (title) => {
                    const card = await api.addCard(projectId, { title, status });
                    setCards((prev) => [...(prev ?? []), card]);
                  }}
                />
              )}

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

              {items.length === 0 && adding !== status && (
                <p className="faint" style={{ margin: '4px', fontSize: 12.5 }}>
                  {status === 'backlog' ? 'Capture upcoming features here.' : 'Drop cards here.'}
                </p>
              )}
            </section>
          );
        })}
      </div>

      <CardDialog
        card={editing}
        projectId={projectId}
        liveSessionId={editing ? (runSummary.get(editing.id)?.liveSessionId ?? null) : null}
        onClose={() => setEditing(null)}
        onSaved={(saved) => {
          setCards((prev) => prev?.map((c) => (c.id === saved.id ? saved : c)) ?? prev);
          setEditing(null);
        }}
        onDeleted={(id) => {
          setCards((prev) => prev?.filter((c) => c.id !== id) ?? prev);
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
        <span className="badge" title={`${summary.running} agent run(s) in flight`}>
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

function QuickAdd({
  onSubmit,
  onCancel,
}: {
  onSubmit: (title: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await onSubmit(title.trim());
      setTitle(''); // Stay open for rapid entry.
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="quick-add" onSubmit={submit}>
      <input
        className="input"
        autoFocus
        placeholder="Feature title…"
        aria-label="New card title"
        value={title}
        maxLength={200}
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && onCancel()}
      />
      {error && <span className="faint">{error}</span>}
      <div className="actions">
        <button className="btn btn-primary btn-sm" disabled={busy || !title.trim()}>
          Add
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
          Done
        </button>
      </div>
    </form>
  );
}
