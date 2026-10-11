import type { KeyboardEvent } from 'react';

export function navigateProjectPane(
  e: KeyboardEvent<HTMLElement>,
  navigate: (href: string) => void,
) {
  if (!e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  const target = e.target as HTMLElement;
  if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
  const links = Array.from(e.currentTarget.querySelectorAll<HTMLAnchorElement>('a.sidebar-item'));
  if (!links.length) return;
  e.preventDefault();
  e.stopPropagation();
  const focused = links.findIndex((link) => link.contains(target));
  const current =
    focused >= 0
      ? focused
      : links.findIndex((link) => link.getAttribute('aria-current') === 'page');
  const index =
    current < 0
      ? e.key === 'ArrowDown'
        ? 0
        : links.length - 1
      : Math.max(0, Math.min(links.length - 1, current + (e.key === 'ArrowDown' ? 1 : -1)));
  const next = links[index]!;
  next.focus({ preventScroll: true });
  next.scrollIntoView?.({ block: 'nearest' });
  navigate(next.getAttribute('href')!);
}
