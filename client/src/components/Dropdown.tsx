import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Gap kept between an open menu and the window edge. */
const EDGE = 8;
/** Tallest an open menu gets before it scrolls (rows with a description need the room). */
const MAX_MENU_HEIGHT = 360;

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
  multiple,
  searchable,
}: {
  label: string;
  value: T;
  options: DropdownOption<T>[];
  onChange: (value: T) => void;
  /** Id for the trigger, so a visible `<label htmlFor>` can name it. */
  id?: string;
  disabled?: boolean;
  /** Defaults to search for lists with eight or more options. */
  searchable?: boolean;
  multiple?: { values: T[]; allValue: T; onChange: (values: T[]) => void };
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const hasSearch = searchable ?? options.length >= 8;
  const searchRef = useRef<HTMLInputElement>(null);
  const normalized = (text: string) =>
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLocaleLowerCase();
  const visible = options
    .map((option, index) => ({ option, index }))
    .filter(
      ({ option }) =>
        !hasSearch ||
        normalized([option.label, option.sub, option.hint].filter(Boolean).join(' ')).includes(
          normalized(query.trim()),
        ),
    );
  // Opens upward when the menu would run past the bottom of its dialog body (or the window).
  const [dropUp, setDropUp] = useState(false);
  const [focusIndex, setFocusIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const isSelected = (candidate: T) =>
    multiple
      ? candidate === multiple.allValue
        ? multiple.values.length === 0
        : multiple.values.includes(candidate)
      : candidate === value;
  const selected = options.find((o) => o.value === value) ?? options[0];

  const selectionLabel =
    multiple && multiple.values.length > 1
      ? `${label} (${multiple.values.length})`
      : multiple && multiple.values.length === 1
        ? (options.find((option) => option.value === multiple.values[0])?.label ?? `${label} (1)`)
        : selected?.label;

  function enabledIndexes(): number[] {
    return visible.filter(({ option }) => !option.disabled).map(({ index }) => index);
  }

  function openMenu(atSelected: boolean) {
    const enabled = options
      .map((option, index) => (option.disabled ? -1 : index))
      .filter((index) => index >= 0);
    if (enabled.length === 0) return;
    setQuery('');
    const selectedIndex = options.findIndex((o) => isSelected(o.value) && !o.disabled);
    // Avoid opening the phone keyboard before the user chooses to search.
    const focusSearch = hasSearch && !window.matchMedia?.('(max-width: 768px)').matches;
    setFocusIndex(
      focusSearch ? -1 : atSelected && selectedIndex >= 0 ? selectedIndex : enabled[0]!,
    );
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (trigger) {
      const bounds = triggerRef.current!.closest('.dialog-body')?.getBoundingClientRect();
      const bottom = bounds?.bottom ?? window.innerHeight;
      const top = bounds?.top ?? 0;
      const menuHeight = Math.min(MAX_MENU_HEIGHT, options.length * 32 + 10 + (hasSearch ? 48 : 0));
      setDropUp(trigger.bottom + 4 + menuHeight > bottom && trigger.top - 4 - menuHeight >= top);
    }
    setOpen(true);
  }

  function closeMenu(refocus: boolean) {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }

  function choose(index: number, exclusive = false) {
    const option = options[index];
    if (!option || option.disabled) return;
    if (multiple) {
      if (exclusive) {
        multiple.onChange(option.value === multiple.allValue ? [] : [option.value]);
        return;
      }
      multiple.onChange(
        option.value === multiple.allValue
          ? []
          : multiple.values.includes(option.value)
            ? multiple.values.filter((v) => v !== option.value)
            : [...multiple.values, option.value],
      );
      return;
    }
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

  // Keep the whole menu on screen: right-align it when it would run past the window's right edge,
  // never wider than the window, and as tall as the room above/below allows (up to a cap). Done
  // on the element before paint, so it never flashes in the wrong place.
  useLayoutEffect(() => {
    const list = listRef.current;
    const trigger = triggerRef.current?.getBoundingClientRect();
    if (!open || !list || !trigger) return;
    const room = window.innerWidth - 2 * EDGE;
    list.style.maxWidth = `${room}px`;
    list.style.left = '0px';
    list.style.right = 'auto';
    const box = list.getBoundingClientRect();
    if (box.right > window.innerWidth - EDGE) {
      // Right-aligned with the trigger, nudged back in if that runs off the left edge instead.
      const overLeft = trigger.right - box.width - EDGE;
      list.style.left = 'auto';
      list.style.right = `${Math.min(0, overLeft)}px`;
    }
    const space = dropUp ? trigger.top - EDGE : window.innerHeight - trigger.bottom - EDGE;
    list.style.maxHeight = `${Math.max(120, Math.min(MAX_MENU_HEIGHT, space - 4))}px`;
  }, [open, dropUp]);

  // Focus follows the keyboard cursor while open.
  useEffect(() => {
    if (!open) return;
    if (focusIndex === -1 && hasSearch) searchRef.current?.focus();
    else optionRefs.current[focusIndex]?.focus();
  }, [open, focusIndex, hasSearch]);

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
        aria-controls={open ? listId : undefined}
        aria-label={label}
        title={
          multiple
            ? multiple.values.length
              ? options
                  .filter((o) => multiple.values.includes(o.value))
                  .map((o) => o.label)
                  .join(', ')
              : selectionLabel
            : (selected?.title ?? selected?.label ?? label)
        }
        onClick={() => (open ? closeMenu(false) : openMenu(true))}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            if (!open) openMenu(true);
          }
        }}
      >
        {selected?.icon && <span className="dropdown-icon">{selected.icon}</span>}
        <span className="truncate">{selectionLabel ?? '—'}</span>
        {/* The closed picker says what the open list says about the choice (e.g. its CLI). */}
        {selected?.hint && <span className="dropdown-trigger-hint truncate">{selected.hint}</span>}
        <span className="dropdown-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div ref={listRef} className={`dropdown-list${dropUp ? ' drop-up' : ''}`}>
          {hasSearch && (
            <input
              ref={searchRef}
              className="dropdown-search"
              type="search"
              aria-label={`Search ${label}`}
              aria-controls={listId}
              autoComplete="off"
              placeholder={`Search ${label.toLocaleLowerCase()}…`}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setFocusIndex(-1);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  event.preventDefault();
                  const enabled = enabledIndexes();
                  setFocusIndex((event.key === 'ArrowDown' ? enabled[0] : enabled.at(-1)) ?? -1);
                } else if (event.key === 'Enter') {
                  event.preventDefault();
                  const first = enabledIndexes()[0];
                  if (first !== undefined) choose(first);
                } else if (event.key === 'Tab') setOpen(false);
              }}
            />
          )}
          {visible.length === 0 && (
            <p className="dropdown-empty" role="status">
              No matching options
            </p>
          )}
          <ul
            className="dropdown-options"
            role="listbox"
            aria-multiselectable={multiple ? true : undefined}
            aria-label={label}
            id={listId}
          >
            {visible.map(({ option, index: i }) => (
              <li
                key={String(option.value)}
                role="option"
                aria-selected={isSelected(option.value)}
                aria-disabled={option.disabled || undefined}
                className={isSelected(option.value) ? 'selected' : undefined}
              >
                <button
                  ref={(el) => {
                    optionRefs.current[i] = el;
                  }}
                  type="button"
                  disabled={option.disabled}
                  title={
                    option.title
                      ? multiple
                        ? `${option.title} · Ctrl+click to select only this`
                        : option.title
                      : multiple
                        ? 'Ctrl+click to select only this'
                        : undefined
                  }
                  tabIndex={i === focusIndex ? 0 : -1}
                  onClick={(e) => choose(i, e.ctrlKey || e.metaKey)}
                  onMouseEnter={() => {
                    if (!option.disabled && document.activeElement !== searchRef.current)
                      setFocusIndex(i);
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
                      choose(i, e.ctrlKey || e.metaKey);
                    } else if (e.key === 'Backspace' && hasSearch) {
                      e.preventDefault();
                      setFocusIndex(-1);
                    } else if (e.key === 'Tab') {
                      setOpen(false);
                    }
                  }}
                >
                  <span className="dropdown-check" aria-hidden="true">
                    {isSelected(option.value) ? '✓' : ''}
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
        </div>
      )}
    </div>
  );
}
