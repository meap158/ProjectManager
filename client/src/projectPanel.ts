import { useEffect, useState } from 'react';
import { useLocation } from 'react-router';

/** Keep in sync with the phone breakpoint in styles.css (DESIGN.md §10). */
export const PHONE_QUERY = '(max-width: 768px)';

/**
 * Open state of the phone project panel (the sidebar shown full screen from the bottom tab bar).
 * The panel belongs to the history entry it was opened on, so any navigation (a project picked
 * in the panel, a tab, browser back) closes it with no effect to sync. Esc closes it too, and so
 * does widening past the phone breakpoint, where the normal sidebar returns.
 */
export function useProjectPanel() {
  const location = useLocation();
  const [panelKey, setPanelKey] = useState<string | null>(null);
  const open = panelKey === location.key;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Menus inside the panel (the sorter) claim their own Esc first.
      if (e.key === 'Escape' && !e.defaultPrevented) setPanelKey(null);
    };
    const phone = window.matchMedia(PHONE_QUERY);
    const onChange = () => {
      if (!phone.matches) setPanelKey(null);
    };
    window.addEventListener('keydown', onKey);
    phone.addEventListener('change', onChange);
    return () => {
      window.removeEventListener('keydown', onKey);
      phone.removeEventListener('change', onChange);
    };
  }, [open]);

  return {
    open,
    toggle: () => setPanelKey(open ? null : location.key),
    close: () => setPanelKey(null),
  };
}
