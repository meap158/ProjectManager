import type { KeyboardEvent } from 'react';

/** Moves the project selection one row (the focused row, else the current page's) and opens it. */
export function stepProjectPane(
  panel: HTMLElement,
  delta: 1 | -1,
  navigate: (href: string) => void,
  target: Element | null = null,
): boolean {
  const links = Array.from(panel.querySelectorAll<HTMLAnchorElement>('a.sidebar-item'));
  if (!links.length) return false;
  const focused = target ? links.findIndex((link) => link.contains(target)) : -1;
  const current =
    focused >= 0
      ? focused
      : links.findIndex((link) => link.getAttribute('aria-current') === 'page');
  const index =
    current < 0
      ? delta === 1
        ? 0
        : links.length - 1
      : Math.max(0, Math.min(links.length - 1, current + delta));
  const next = links[index]!;
  next.focus({ preventScroll: true });
  next.scrollIntoView?.({ block: 'nearest' });
  navigate(next.getAttribute('href')!);
  return true;
}

export function navigateProjectPane(
  e: KeyboardEvent<HTMLElement>,
  navigate: (href: string) => void,
) {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
  if (!stepProjectPane(e.currentTarget, e.key === 'ArrowDown' ? 1 : -1, navigate, target)) return;
  e.preventDefault();
  e.stopPropagation();
}
