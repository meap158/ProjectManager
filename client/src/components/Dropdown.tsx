import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface DropdownOption<T extends string | number> {
  value: T;
  label: string;
  /** One-line explanation under the label, e.g. what a preset contains. */
  sub?: string;
  /** Shown dimmed and skipped by keyboard; needs `hint` or `title` saying why. */
  disabled?: boolean;
  /** Short right-side meta, e.g. "not on PATH". */
  hint?: string;
  /** Small mark before the label (e.g. an agent's logo), also shown in the closed button. */
  icon?: ReactNode;
  title?: string;
}

/**
 * Designed value-picker dropdown: a button trigger plus a listbox menu.
 * Anatomy follows the KDP sister project's `opp-select` (trigger + absolute
 * listbox, accent selected state, outside-click/Escape close) in ProjectManager
 * tokens. Never use a native `<select>` for these — its OS rendering breaks
 * the design language (see the workspace toolbar).
 */
export function Dropdown<T extends string | number>({
  label,
  value,
  options,
  onChange,
  id,
  disabled,
}: {
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** Id for the trigger, so a visible `<label htmlFor>` can name it. */
  id?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  // Opens upward when the menu would run past the bottom of its dialog body (or the window).
  const [dropUp, setDropUp] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listId = useId();
  const selected = options.find((o) => o.value === value) ?? options[0];

  function enabledIndexes(): number[] {
    return options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);
  }

  function openMenu(atSelected: boolean) {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return;
    const selectedIndex = options.findIndex((o) => o.value === value && !o.disabled);
    setFocusIndex(atSelected && selectedIndex >= 0 ? selectedIndex : enabled[0]!);
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (trigger) {
      const bounds = triggerRef.current!.closest('.dialog-body')?.getBoundingClientRect();
      const bottom = bounds?.bottom ?? window.innerHeight;
      const top = bounds?.top ?? 0;
      const menuHeight = Math.min(240, options.length * 32 + 10);
      setDropUp(trigger.bottom + 4 + menuHeight > bottom && trigger.top - 4 - menuHeight >= top);
    }
    setOpen(true);
  }

  function closeMenu(refocus: boolean) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }

  function choose(index: number) {
    const option = options[index];
    if (!option || option.disabled) return;
    onChange(option.value);
    closeMenu(true);
  }

  function step(from: number, delta: 1 | -1): number {
    const enabled = enabledIndexes();
    if (enabled.length === 0) return from;
    const at = enabled.indexOf(from);
    const next =
      at === -1
        ? delta === 1
          ? 0
          : enabled.length - 1
        : (at + delta + enabled.length) % enabled.length;
    return enabled[next]!;
  }

  // Outside click closes; Escape closes and returns focus to the trigger.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') closeMenu(true);
    }
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // Focus follows the keyboard cursor while open.
  useEffect(() => {
    if (open) optionRefs.current[focusIndex]?.focus();
  }, [open, focusIndex]);

  return (
    <div className="dropdown" ref={rootRef}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        disabled={disabled}
        className={`dropdown-trigger${open ? ' is-open' : ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label}
        title={selected?.title ?? selected?.label ?? label}
        onClick={() => (open ? closeMenu(false) : openMenu(true))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!open) openMenu(true);
          }
        }}
      >
        {selected?.icon && <span className="dropdown-icon">{selected.icon}</span>}
        <span className="truncate">{selected?.label ?? '—'}</span>
        {/* The closed picker says what the open list says about the choice (e.g. its CLI). */}
        {selected?.hint && <span className="dropdown-trigger-hint truncate">{selected.hint}</span>}
        <span className="dropdown-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <ul
          className={`dropdown-list${dropUp ? ' drop-up' : ''}`}
          role="listbox"
          aria-label={label}
          id={listId}
        >
          {options.map((option, i) => (
            <li
              key={String(option.value)}
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled || undefined}
              className={option.value === value ? 'selected' : undefined}
            >
              <button
                ref={(el) => {
                  optionRefs.current[i] = el;
                }}
                type="button"
                disabled={option.disabled}
                title={option.title}
                tabIndex={i === focusIndex ? 0 : -1}
                onClick={() => choose(i)}
                onMouseEnter={() => {
                  if (!option.disabled) setFocusIndex(i);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setFocusIndex(step(i, 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setFocusIndex(step(i, -1));
                  } else if (e.key === 'Home') {
                    e.preventDefault();
                    setFocusIndex(enabledIndexes()[0] ?? i);
                  } else if (e.key === 'End') {
                    e.preventDefault();
                    setFocusIndex(enabledIndexes().at(-1) ?? i);
                  } else if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    choose(i);
                  } else if (e.key === 'Tab') {
                    setOpen(false);
                  }
                }}
              >
                <span className="dropdown-check" aria-hidden="true">
                  {option.value === value ? '✓' : ''}
                </span>
                {option.icon && <span className="dropdown-icon">{option.icon}</span>}
                <span className="dropdown-text">
                  <span className="truncate">{option.label}</span>
                  {option.sub && <span className="dropdown-sub truncate">{option.sub}</span>}
                </span>
                {option.hint && <span className="dropdown-hint">{option.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
