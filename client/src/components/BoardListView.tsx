import type { ReactNode } from 'react';
import { CARD_STATUS_LABELS, type Card, type CardStatus } from '../../../shared/types';
import { useCollapsedGroups, type BoardView } from '../boardView';
import { BoardIcon, ListIcon, PageIcon } from './icons';

/**
 * Notion-style database view tabs above a board: Board (the Kanban columns) or List. Plain text
 * tabs with an icon and an underline, like Notion's view bar (DESIGN.md §6 Kanban).
 */
export function BoardViewTabs({
  view,
  onChange,
}: {
  view: BoardView;
  onChange: (view: BoardView) => void;
}) {
  return (
    <div className="view-tabs" role="radiogroup" aria-label="Board view">
      {(['board', 'list'] as const).map((v) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={view === v}
          className="view-tab"
          title={v === 'board' ? 'Columns side by side' : 'Cards grouped by status, one per row'}
          onClick={() => onChange(v)}
        >
          {v === 'board' ? <BoardIcon /> : <ListIcon />}
          {v === 'board' ? 'Board' : 'List'}
        </button>
      ))}
    </div>
  );
}

/**
 * The List view: one collapsible group per status (Notion's grouped list), a full-width row per
 * card and a "New" row closing each group. It's the touch-friendly way through a board: no
 * sideways scrolling, 44px rows, and cards move through their dialog's Column dropdown.
 */
export function BoardListView<C extends Card>({
  columns,
  cards,
  onOpen,
  onAdd,
  meta,
}: {
  columns: readonly CardStatus[];
  /** Cards in display order within their status. */
  cards: C[];
  onOpen: (card: C) => void;
  onAdd: (status: CardStatus) => void;
  /** The properties line under a title (key, project tag, badges, time). */
  meta: (card: C) => ReactNode;
}) {
  const [collapsed, toggle] = useCollapsedGroups();
  return (
    <div className="blist">
      {columns.map((status) => {
        const items = cards.filter((c) => c.status === status);
        const open = !collapsed.has(status);
        const label = CARD_STATUS_LABELS[status];
        return (
          <section key={status} className="blist-group" aria-label={label}>
            <header className="blist-head">
              <button
                type="button"
                className="blist-toggle"
                aria-expanded={open}
                onClick={() => toggle(status)}
              >
                <span className="blist-caret" aria-hidden="true" />
                <span className={`status-pill status-${status}`}>{label}</span>
                <span className="faint num">{items.length}</span>
              </button>
              <button
                type="button"
                className="icon-btn blist-add"
                aria-label={`Add a card to ${label}`}
                title={`Add a card to ${label}`}
                onClick={() => onAdd(status)}
              >
                ＋
              </button>
            </header>
            {open && (
              <ul className="blist-rows">
                {items.map((card) => (
                  <li key={card.id}>
                    <button
                      type="button"
                      className="blist-row"
                      onClick={() => onOpen(card)}
                      title="Open to edit, change its column or hand it to an agent"
                    >
                      <PageIcon size={16} className="blist-icon" />
                      <span className="blist-text">
                        <span className="blist-title">{card.title}</span>
                        <span className="blist-meta">{meta(card)}</span>
                      </span>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    className="blist-new"
                    aria-label={`New card in ${label}`}
                    onClick={() => onAdd(status)}
                  >
                    <span aria-hidden="true">＋</span> New
                  </button>
                </li>
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}
