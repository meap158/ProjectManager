import { useCallback, useState } from 'react';

/**
 * Which panels the user collapsed, by id, remembered in this browser (PM-90). A convenience:
 * storage may be unavailable (private windows), so everything starts expanded then.
 */
export function useCollapsed(storageKey: string) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as unknown;
      return new Set(Array.isArray(saved) ? saved.filter((v) => typeof v === 'string') : []);
    } catch {
      return new Set();
    }
  });
  const toggle = useCallback(
    (id: string) =>
      setCollapsed((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        try {
          localStorage.setItem(storageKey, JSON.stringify([...next]));
        } catch {
          // Not remembered; still toggles for this visit.
        }
        return next;
      }),
    [storageKey],
  );
  return { isCollapsed: (id: string) => collapsed.has(id), toggle };
}

/** The chevron button that collapses or expands a panel. */
export function collapseButtonProps(label: string, collapsed: boolean, onToggle: () => void) {
  return {
    type: 'button' as const,
    className: 'orchestrator-collapse',
    'aria-expanded': !collapsed,
    'aria-label': `${collapsed ? 'Expand' : 'Collapse'} ${label}`,
    title: collapsed ? `Expand ${label}` : `Collapse ${label}`,
    onClick: onToggle,
  };
}
