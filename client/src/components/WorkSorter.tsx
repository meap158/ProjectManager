import { useEffect, useRef, useState } from 'react';
import type { WorkItem } from './AgentWorkList';

// Sort for the Agents list view (PM-94), modelled on the All projects sorter: each mode has a
// natural direction, picking the active mode again reverses it, switching modes starts from the
// new mode's natural direction, and the label always names the direction in force. Remembered
// per browser. Default: the sessions you last sent a message to come first.

export type WorkSortMode = 'message' | 'output' | 'attention' | 'started' | 'name' | 'project';
export type WorkSortDirection = 'asc' | 'desc';
export interface WorkSort {
  mode: WorkSortMode;
  direction: WorkSortDirection;
}

const MODES: WorkSortMode[] = ['message', 'output', 'attention', 'started', 'name', 'project'];
const NATURAL: Record<WorkSortMode, WorkSortDirection> = {
  message: 'desc',
  output: 'desc',
  attention: 'desc',
  started: 'desc',
  name: 'asc',
  project: 'asc',
};
export const DEFAULT_WORK_SORT: WorkSort = { mode: 'message', direction: 'desc' };
const KEY = 'pm.workspace.listSort';

export function workSortLabel({ mode, direction }: WorkSort): string {
  const natural = direction === NATURAL[mode];
  if (mode === 'message') return natural ? 'Recent message' : 'Oldest message';
  if (mode === 'output') return natural ? 'Recent output' : 'Quietest';
  if (mode === 'attention') return 'Needs you first';
  if (mode === 'started') return natural ? 'Newest' : 'Oldest';
  if (mode === 'name') return natural ? 'Name A–Z' : 'Name Z–A';
  return natural ? 'Project A–Z' : 'Project Z–A';
}

const HINTS: Record<WorkSortMode, string> = {
  message: 'When you last sent it a message',
  output: 'When it last printed something',
  attention: 'Asking you first, then running, then the rest',
  started: 'When it was started',
  name: 'By name',
  project: 'By project, then name',
};

const time = (iso: string | null | undefined) => (iso ? Date.parse(iso) : 0);

/** When you last sent it something: your last message, else its first prompt (a run's dispatch). */
export function lastMessageTime(w: WorkItem): number {
  return w.kind === 'session'
    ? time(w.item.lastInputAt) || time(w.item.createdAt)
    : time(w.item.createdAt);
}

function lastOutputTime(w: WorkItem): number {
  return w.kind === 'session'
    ? time(w.item.lastOutputAt) || time(w.item.startedAt)
    : time(w.item.endedAt) || time(w.item.startedAt) || time(w.item.createdAt);
}

const startedTime = (w: WorkItem) => time(w.item.startedAt) || time(w.item.createdAt);

function attentionRank(w: WorkItem): number {
  if (w.kind === 'session') {
    if (w.item.status !== 'running') return 0;
    return w.item.tailState === 'input' ? 3 : 2;
  }
  if (w.item.status === 'succeeded' && !w.item.validation) return 3; // Awaiting your review.
  return w.item.status === 'running' || w.item.status === 'queued' ? 2 : 0;
}

/** A sorted copy. Ties fall back to the most recent message, so the order stays stable. */
export function sortWork(
  items: WorkItem[],
  sort: WorkSort,
  projectNames: Map<number, string> = new Map(),
): WorkItem[] {
  const flip = sort.direction === NATURAL[sort.mode] ? 1 : -1;
  const name = (w: WorkItem) => w.item.name.toLocaleLowerCase();
  const project = (w: WorkItem) => (projectNames.get(w.item.projectId) ?? '').toLocaleLowerCase();
  const tie = (a: WorkItem, b: WorkItem) => lastMessageTime(b) - lastMessageTime(a);
  const compare: Record<WorkSortMode, (a: WorkItem, b: WorkItem) => number> = {
    message: (a, b) => flip * (lastMessageTime(b) - lastMessageTime(a)),
    output: (a, b) => flip * (lastOutputTime(b) - lastOutputTime(a)) || tie(a, b),
    attention: (a, b) => attentionRank(b) - attentionRank(a) || tie(a, b),
    started: (a, b) => flip * (startedTime(b) - startedTime(a)) || tie(a, b),
    name: (a, b) => flip * name(a).localeCompare(name(b)) || tie(a, b),
    project: (a, b) =>
      flip * project(a).localeCompare(project(b)) || name(a).localeCompare(name(b)) || tie(a, b),
  };
  return [...items].sort(compare[sort.mode]);
}

function readSort(): WorkSort {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<WorkSort> | null;
    if (saved && MODES.includes(saved.mode as WorkSortMode))
      return {
        mode: saved.mode as WorkSortMode,
        direction: saved.direction === 'asc' ? 'asc' : 'desc',
      };
  } catch {
    // Unreadable or unavailable storage: the default sort.
  }
  return DEFAULT_WORK_SORT;
}

export function useWorkSort() {
  const [sort, setState] = useState<WorkSort>(readSort);
  const setSort = (next: WorkSort) => {
    setState(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Remembering the sort is a convenience only.
    }
  };
  return [sort, setSort] as const;
}

/** The sort button and its menu: compact (icon plus the active order). */
export function WorkSorter({
  sort,
  onChange,
}: {
  sort: WorkSort;
  onChange: (next: WorkSort) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setOpen(false);
      ref.current?.querySelector<HTMLButtonElement>('.work-sort-trigger')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  const choose = (mode: WorkSortMode) => {
    if (mode === sort.mode) {
      if (mode !== 'attention')
        onChange({ mode, direction: sort.direction === 'asc' ? 'desc' : 'asc' });
    } else onChange({ mode, direction: NATURAL[mode] });
  };
  const label = workSortLabel(sort);
  return (
    <div className="work-sort" ref={ref}>
      <button
        type="button"
        className="btn btn-sm work-sort-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Sort: ${label}`}
        title={open ? 'Close sort options' : `Sorted by ${label.toLowerCase()}`}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4.5 2.5v11M2 11l2.5 2.5L7 11M11.5 13.5v-11M9 5l2.5-2.5L14 5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        <span className="work-sort-label">{label}</span>
      </button>
      {open && (
        <div className="work-sort-menu" role="menu" aria-label="Sort agent work">
          <div className="sorter-label">Sort by</div>
          {MODES.map((mode) => {
            const active = mode === sort.mode;
            return (
              <button
                key={mode}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                className={`sorter-option${active ? ' selected' : ''}`}
                title={
                  active && mode !== 'attention' ? 'Click again to reverse the order' : HINTS[mode]
                }
                onClick={() => choose(mode)}
              >
                <span>{workSortLabel(active ? sort : { mode, direction: NATURAL[mode] })}</span>
                {active && (
                  <span className="sort-direction-badge" aria-hidden="true">
                    {mode === 'attention' ? '✓' : sort.direction === 'asc' ? '↑' : '↓'}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
