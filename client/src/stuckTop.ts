import { useCallback } from 'react';

/**
 * Board column headers stick right under the page's sticky chrome (Notion-style). That chrome's
 * height varies (actions wrap, phones drop the subtitle, phone project pages pin only the tab
 * bar), so this callback ref measures the part that actually sticks and exposes it to CSS as
 * `--stuck-top` on the board. Resize-driven, no scroll listeners.
 */
export function useStuckTop() {
  return useCallback((board: HTMLElement | null) => {
    const head = board?.closest('.page')?.querySelector<HTMLElement>(':scope > .sticky-head');
    // jsdom (component tests) has no ResizeObserver; the CSS falls back to top: 0.
    if (!board || !head || typeof ResizeObserver === 'undefined') return;
    const measure = () => {
      // `.phone-tabs-only` heads render as display: contents and only their tab bar sticks.
      const stuck =
        getComputedStyle(head).display === 'contents' ? head.querySelector(':scope > .tabs') : head;
      board.style.setProperty('--stuck-top', `${stuck?.getBoundingClientRect().height ?? 0}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(head);
    for (const child of head.children) observer.observe(child);
    // Width changes cross the phone breakpoint, which swaps which part of the head sticks.
    observer.observe(board);
    return () => observer.disconnect();
  }, []);
}
