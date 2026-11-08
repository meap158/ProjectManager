import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

/*
 * Motion for drag-to-reorder lists (PM-529). Rows that the reorder displaces slide from where they
 * were to where they are (FLIP: measure first and last, play the difference), so a drag or a
 * keyboard move reads as rows making room rather than jumping. The dropped row gets a short
 * "settled" highlight. Everything is skipped for prefers-reduced-motion. Rows are found by their
 * data-account-id, which the account switchers already set.
 */

const SLIDE_MS = 180;
const SETTLE_MS = 650;

const reducedMotion = () =>
  typeof window !== 'undefined' &&
  Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

/** Slides the rows of `list` into place whenever `orderKey` changes. */
export function useReorderSlide(list: RefObject<HTMLElement | null>, orderKey: string) {
  const tops = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    const animate = !reducedMotion();
    const next = new Map<string, number>();
    for (const row of el.querySelectorAll<HTMLElement>('[data-account-id]')) {
      const id = row.dataset.accountId!;
      const top = row.getBoundingClientRect().top;
      next.set(id, top);
      const before = tops.current.get(id);
      if (animate && before !== undefined && before !== top && typeof row.animate === 'function')
        row.animate(
          [{ transform: `translateY(${before - top}px)` }, { transform: 'translateY(0)' }],
          { duration: SLIDE_MS, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
        );
    }
    tops.current = next;
  }, [list, orderKey]);
}

/**
 * The drag state of a reorderable list: which row is lifted, which one just settled, and a
 * sentence for screen readers after each move ("Moved Work to position 2 of 3").
 */
export function useReorderDrag() {
  const [dragging, setDragging] = useState<string | null>(null);
  const [settled, setSettled] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
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
    lift: (id: string) => setDragging(id),
    drop: (id: string | null) => {
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
