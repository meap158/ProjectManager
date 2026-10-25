import { useCallback, useEffect, useRef, type KeyboardEvent, type PointerEvent } from 'react';
import './filter-chips.css';

// A horizontal strip of filter chips with counts (after TrendRelay's FilterChipStrip). It draws no
// scrollbar: it drags with the mouse and pans natively on touch, with fades on whichever end still
// holds chips. A press that travels less than the threshold stays a click, and the click after a
// real drag is swallowed. Arrow keys move between chips, Home and End jump to the ends.

export interface FilterChip<K extends string = string> {
  key: K;
  label: string;
  count: number;
  /** Colour family shared with the rows the chip stands for: data-tone on the chip. */
  tone?: string;
}

const DRAG_THRESHOLD_PX = 6;

export function FilterChips<K extends string>({
  chips,
  selected,
  onSelect,
  label,
}: {
  chips: FilterChip<K>[];
  selected: K;
  onSelect: (key: K) => void;
  /** Accessible name of the group. */
  label: string;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const drag = useRef({ id: -1, x: 0, left: 0, active: false });
  const swallow = useRef(false);

  // Written on the DOM, not in state: it runs on every scroll tick.
  const edges = useCallback(() => {
    const s = strip.current;
    const f = frame.current;
    if (!s || !f) return;
    const room = s.scrollWidth - s.clientWidth;
    f.toggleAttribute('data-can-start', room > 1 && s.scrollLeft > 1);
    f.toggleAttribute('data-can-end', room > 1 && s.scrollLeft < room - 1);
  }, []);
  useEffect(() => {
    edges();
    window.addEventListener('resize', edges);
    return () => window.removeEventListener('resize', edges);
  }, [edges, chips]);

  // The chosen chip stays in view when the list changes under it.
  useEffect(() => {
    strip.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [selected]);

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    drag.current = {
      id: e.pointerId,
      x: e.clientX,
      left: strip.current?.scrollLeft ?? 0,
      active: false,
    };
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d.id !== e.pointerId || !strip.current) return;
    const delta = e.clientX - d.x;
    if (!d.active) {
      if (Math.abs(delta) < DRAG_THRESHOLD_PX) return;
      d.active = true;
      strip.current.classList.add('is-dragging');
      try {
        strip.current.setPointerCapture(e.pointerId);
      } catch {
        // The pointer is already gone.
      }
    }
    strip.current.scrollLeft = d.left - delta;
    edges();
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current.id !== e.pointerId) return;
    swallow.current = drag.current.active;
    drag.current = { id: -1, x: 0, left: 0, active: false };
    strip.current?.classList.remove('is-dragging');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const buttons = [...(strip.current?.querySelectorAll<HTMLButtonElement>('button') ?? [])];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const go = (i: number) => buttons[Math.max(0, Math.min(buttons.length - 1, i))]?.focus();
    if (e.key === 'ArrowRight') go(at + 1);
    else if (e.key === 'ArrowLeft') go(at - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(buttons.length - 1);
    else return;
    e.preventDefault();
  };

  return (
    <div className="filter-chips" ref={frame}>
      <div
        ref={strip}
        className="filter-chips-strip"
        role="group"
        aria-label={label}
        onScroll={edges}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
        onKeyDown={onKeyDown}
        onClickCapture={(e) => {
          if (!swallow.current) return;
          swallow.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
      >
        {chips.map((chip) => (
          <button
            key={chip.key}
            type="button"
            className="filter-chip"
            data-tone={chip.tone}
            aria-label={`${chip.label} (${chip.count})`}
            aria-pressed={chip.key === selected}
            onClick={() => onSelect(chip.key)}
          >
            {chip.label}
            <span className="filter-chip-count">{chip.count}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
