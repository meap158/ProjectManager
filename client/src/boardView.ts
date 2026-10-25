import { useState } from 'react';
import type { CardStatus } from '../../shared/types';

/** How a board is shown: the Kanban columns (default) or the Notion-style grouped list. */
export type BoardView = 'board' | 'list';

const VIEW_KEY = 'pm.board.view';
const COLLAPSED_KEY = 'pm.board.collapsed';
// A list keeps finished work out of the way until asked for (Linear/Notion completed groups).
const DEFAULT_COLLAPSED: CardStatus[] = ['done'];

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A per-browser convenience: the choice still applies for this visit.
  }
}

/** The viewer's board view, shared by project boards and the global Board, saved per browser. */
export function useBoardView(): [BoardView, (view: BoardView) => void] {
  const [view, setView] = useState<BoardView>(() => (read(VIEW_KEY) === 'list' ? 'list' : 'board'));
  return [
    view,
    (next) => {
      setView(next);
      write(VIEW_KEY, next);
    },
  ];
}

/** Collapsed List view groups, saved per browser. */
export function useCollapsedGroups(): [Set<CardStatus>, (status: CardStatus) => void] {
  const [collapsed, setCollapsed] = useState<Set<CardStatus>>(() => {
    const saved = read(COLLAPSED_KEY);
    if (saved === null) return new Set(DEFAULT_COLLAPSED);
    try {
      return new Set(JSON.parse(saved) as CardStatus[]);
    } catch {
      return new Set(DEFAULT_COLLAPSED);
    }
  });
  return [
    collapsed,
    (status) => {
      const next = new Set(collapsed);
      if (next.has(status)) next.delete(status);
      else next.add(status);
      setCollapsed(next);
      write(COLLAPSED_KEY, JSON.stringify([...next]));
    },
  ];
}

/** One of a fixed set of choices, saved per browser (the Board's density, grouping, WIP limit). */
export function useStoredChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    const saved = read(key);
    return allowed.includes(saved as T) ? (saved as T) : fallback;
  });
  return [
    value,
    (next) => {
      setValue(next);
      write(key, next);
    },
  ];
}
