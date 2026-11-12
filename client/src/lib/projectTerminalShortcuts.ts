import { useEffect, type RefObject } from 'react';

/** Capture pane navigation before the CLI reads it, without taking keys from editors or dialogs. */
export function useProjectTerminalShortcuts(
  dock: RefObject<HTMLElement | null>,
  active: boolean,
  toggleMaximize: () => void,
) {
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.repeat ||
        event.isComposing ||
        document.querySelector('dialog[open]')
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest('input, [contenteditable="true"], textarea:not(.xterm-helper-textarea)'))
        return;
      if (event.code === 'Digit1') {
        const input = dock.current?.querySelector<HTMLElement>('.xterm-helper-textarea');
        if (!input) return;
        event.preventDefault();
        event.stopPropagation();
        input.focus();
      } else if (event.key === 'Enter' && target && dock.current?.contains(target)) {
        event.preventDefault();
        event.stopPropagation();
        toggleMaximize();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, dock, toggleMaximize]);
}
