import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/*
 * Drag-to-reorder for the account lists (PM-529, PM-532).
 *
 * - The drop position comes from where the rows sit in the layout (offsetTop, which transforms do
 *   not change): the dragged row goes after every other row whose middle is above the pointer.
 *   Animations never feed back into it, so the order changes once per half-row crossed instead
 *   of jittering between two rows.
 * - The dragged row follows the pointer, lifted; on drop it glides into its slot.
 * - Rows it displaces slide from where they were to where they are (FLIP).
 * - The dropped row settles with a short highlight, and each move is announced.
 * - prefers-reduced-motion skips every animation but keeps the moves.
 *
 * Rows are the list's [data-account-id] elements; "default" (the live login) never moves.
 */

const SLIDE_MS = 200;
const SETTLE_MS = 650;
const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

interface Grab {
  id: string;
  row: HTMLElement;
  /** Pointer distance from the row's top when it was picked up. */
  offset: number;
  lastY: number;
}

/** The list's rows that can move ("default", the live login, never does). */
function movableRows(list: HTMLElement | null): HTMLElement[] {
  return [...(list?.querySelectorAll<HTMLElement>('[data-account-id]') ?? [])].filter(
    (row) => row.dataset.accountId !== 'default',
  );
}

/**
 * Measures are relative to the list itself (styles make it the rows' offsetParent): the page
 * scrolls inside the app's own container, not the window, so body-relative offsets drift by the
 * scroll distance. The list's box is never transformed, so its top is a stable origin.
 */
const listTop = (list: HTMLElement | null) => list?.getBoundingClientRect().top ?? 0;

/** Keeps the lifted row under the pointer, from its slot in the current layout. */
function follow(g: Grab | null, list: HTMLElement | null) {
  if (!g) return;
  g.row.style.transform = `translateY(${g.lastY - g.offset - listTop(list) - g.row.offsetTop}px)`;
}

export function useReorder(list: RefObject<HTMLElement | null>, orderKey: string) {
  const [dragging, setDragging] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const grab = useRef<Grab | null>(null);
  const tops = useRef(new Map<string, number>());

  // After every reorder: slide the displaced rows, and keep the lifted one under the pointer.
  useLayoutEffect(() => {
    const animate = !reducedMotion();
    const next = new Map<string, number>();
    for (const row of movableRows(list.current)) {
      const id = row.dataset.accountId!;
      next.set(id, row.offsetTop);
      if (id === grab.current?.id) continue;
      const before = tops.current.get(id);
      if (
        animate &&
        before !== undefined &&
        before !== row.offsetTop &&
        typeof row.animate === 'function'
      )
        row.animate(
          [
            { transform: `translateY(${before - row.offsetTop}px)` },
            { transform: 'translateY(0)' },
          ],
          { duration: SLIDE_MS, easing: EASE },
        );
    }
    tops.current = next;
    follow(grab.current, list.current);
  }, [orderKey, list]);

  useEffect(() => {
    if (!settled) return;
    const timer = setTimeout(() => setSettled(null), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [settled]);

  // The whole page shows the grabbing hand while a row is lifted.
  useEffect(() => {
    if (!dragging) return;
    document.body.classList.add('is-reordering-rows');
    return () => document.body.classList.remove('is-reordering-rows');
  }, [dragging]);

  return {
    dragging,
    settled,
    announcement,
    /** Picks a row up at the pointer. */
    lift(id: string, clientY: number, row: HTMLElement | null) {
      if (!row) return;
      grab.current = { id, row, offset: clientY - row.getBoundingClientRect().top, lastY: clientY };
      setDragging(id);
    },
    /**
     * Moves the lifted row with the pointer and returns the index it belongs at among the
     * movable rows, or -1 when nothing is lifted.
     */
    track(clientY: number): number {
      const g = grab.current;
      if (!g) return -1;
      g.lastY = clientY;
      follow(g, list.current);
      const y = clientY - listTop(list.current);
      return movableRows(list.current).filter(
        (r) => r !== g.row && r.offsetTop + r.offsetHeight / 2 < y,
      ).length;
    },
    /** Puts the lifted row down: it glides into its slot and settles. */
    drop(id: string | null) {
      const g = grab.current;
      grab.current = null;
      if (g) {
        const from = g.row.style.transform;
        g.row.style.transform = '';
        if (from && !reducedMotion() && typeof g.row.animate === 'function')
          g.row.animate([{ transform: from }, { transform: 'translateY(0)' }], {
            duration: SLIDE_MS,
            easing: EASE,
          });
      }
      setDragging(null);
      if (id) setSettled(id);
    },
    announce: (name: string, position: number, total: number) =>
      setAnnouncement(`Moved ${name} to position ${position} of ${total}`),
    /** The row's class modifiers: lifted while dragged, settled just after. */
    rowState: (id: string) =>
      dragging === id ? ' is-reordering' : settled === id ? ' is-settled' : '',
  };
}
