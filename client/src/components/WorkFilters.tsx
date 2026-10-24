import { useRef, useState } from 'react';
import { useViewPreference } from '../useViewPreference';
import { WORK_STATUS_LABELS, workStatus, type WorkItem, type WorkStatus } from './AgentWorkList';
import { Dropdown } from './Dropdown';
import { PROVIDER_LABELS, ProviderIcon } from './icons';

// Filters for the workspace list view: status chips with live counts, agent, project, kind and a
// name search. All choices are remembered per browser; an active filter can be cleared in one
// click, and an empty result says so (never a silently empty list).

type FilterStatus = Exclude<WorkStatus, 'input' | 'review'> | 'attention' | 'all';

export interface WorkFilterState {
  status: FilterStatus | FilterStatus[];
  agent: string | string[]; // provider id or 'all'
  project: number | number[]; // project id or 0 = all
  kind: 'all' | 'session' | 'run' | ('all' | 'session' | 'run')[];
  query: string;
}

export function selectedFilters<T extends string | number>(value: T | T[], all: T): T[] {
  return (Array.isArray(value) ? value : [value]).filter((v) => v !== all);
}
const KEY = 'pm.workspace.listFilters';
export const NO_FILTERS: WorkFilterState = {
  status: 'all',
  agent: 'all',
  project: 0,
  kind: 'all',
  query: '',
};

export function readWorkFilters(): WorkFilterState {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<WorkFilterState> & {
      status?: string;
    };
    const raw = Array.isArray(saved.status) ? saved.status : [saved.status ?? 'all'];
    const valid = raw
      .map((value) => (['input', 'review'].includes(value ?? '') ? 'attention' : value))
      .filter((value): value is FilterStatus =>
        ['all', 'attention', 'running', 'idle', 'ended'].includes(value ?? ''),
      );
    const status = [...new Set(valid.filter((value) => value !== 'all'))];
    return {
      ...NO_FILTERS,
      ...saved,
      status: status.length === 1 ? (status[0] ?? 'all') : status.length ? status : 'all',
    };
  } catch {
    return NO_FILTERS;
  }
}

export function useWorkFilters() {
  const [filters, setState] = useState<WorkFilterState>(readWorkFilters);
  const setFilters = (next: WorkFilterState) => {
    setState(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      // Remembering filters is a convenience only.
    }
  };
  return [filters, setFilters] as const;
}

export const filtersActive = (f: WorkFilterState) =>
  selectedFilters(f.status, 'all').length > 0 ||
  selectedFilters(f.agent, 'all').length > 0 ||
  selectedFilters(f.project, 0).length > 0 ||
  selectedFilters(f.kind, 'all').length > 0 ||
  !!f.query.trim();

/** Running includes work awaiting input; the row keeps its more specific state. */
export function matchesWorkStatus(w: WorkItem, status: FilterStatus, now: number): boolean {
  const actual = workStatus(w, now);
  return (
    status === 'all' ||
    actual === status ||
    (status === 'attention' && (actual === 'input' || actual === 'review')) ||
    (status === 'running' && actual === 'input')
  );
}

/** Items matching every filter except, optionally, the status (used for the chip counts). */
export function applyWorkFilters(
  items: WorkItem[],
  f: WorkFilterState,
  now: number,
  { ignoreStatus = false } = {},
): WorkItem[] {
  const q = f.query.trim().toLowerCase();
  const statuses = selectedFilters(f.status, 'all');
  const agents = selectedFilters(f.agent, 'all');
  const projects = selectedFilters(f.project, 0);
  const kinds = selectedFilters(f.kind, 'all');
  return items.filter(
    (w) =>
      (ignoreStatus ||
        !statuses.length ||
        statuses.some((status) => matchesWorkStatus(w, status, now))) &&
      (!agents.length || agents.includes(w.item.providerId)) &&
      (!projects.length || projects.includes(w.item.projectId)) &&
      (!kinds.length || kinds.includes(w.kind)) &&
      (!q ||
        w.item.name.toLowerCase().includes(q) ||
        (w.item.cardKey ?? '').toLowerCase().includes(q)),
  );
}

const STATUSES: FilterStatus[] = ['all', 'attention', 'running', 'idle', 'ended'];

export function WorkFilters({
  items,
  filters,
  onChange,
  now,
  projectNames,
}: {
  items: WorkItem[];
  filters: WorkFilterState;
  onChange: (next: WorkFilterState) => void;
  now: number;
  projectNames: Map<number, string>;
}) {
  // Counts reflect the other filters, so each chip says what clicking it will show.
  const pool = applyWorkFilters(items, filters, now, { ignoreStatus: true });
  const count = (s: FilterStatus) => pool.filter((w) => matchesWorkStatus(w, s, now)).length;
  const agents = [...new Set(items.map((w) => w.item.providerId))].sort();
  const projects = [...new Set(items.map((w) => w.item.projectId))].sort((a, b) =>
    (projectNames.get(a) ?? '').localeCompare(projectNames.get(b) ?? ''),
  );
  const set = (patch: Partial<WorkFilterState>) => onChange({ ...filters, ...patch });
  const [expanded, setExpanded] = useViewPreference(
    'pm.workspace.filtersExpanded',
    false,
    (value): value is boolean => typeof value === 'boolean',
  );
  // The phone status menu: tap picks one, long press adds / removes (PM-124).
  const picker = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const held = useRef(false);
  const optionIndex = (target: EventTarget): number => {
    const option = (target as Element).closest?.('[role="option"]');
    if (!option || !picker.current?.contains(option)) return -1;
    return [...picker.current.querySelectorAll('[role="option"]')].indexOf(option);
  };
  const toggleStatus = (s: FilterStatus) => {
    if (s === 'all') return set({ status: 'all' });
    const current = selectedFilters(filters.status, 'all');
    const next = current.includes(s) ? current.filter((x) => x !== s) : [...current, s];
    set({ status: next.length === 1 ? next[0]! : next.length ? next : 'all' });
  };
  const extraCount =
    Number(selectedFilters(filters.agent, 'all').length > 0) +
    Number(selectedFilters(filters.project, 0).length > 0) +
    Number(selectedFilters(filters.kind, 'all').length > 0) +
    Number(!!filters.query.trim());

  return (
    <div
      className={`work-filters${expanded ? ' is-expanded' : ''}`}
      role="search"
      aria-label="Filter agent work"
    >
      <div
        className="work-status-picker"
        ref={picker}
        // Phones (PM-124): a tap picks one status and closes the menu, like a single choice; a
        // long press adds or removes it and keeps the menu open, for a deliberate multi-select.
        // (Desktop chips: click picks one, Shift+click adds.)
        onPointerDown={(e) => {
          const index = optionIndex(e.target);
          if (index < 0) return;
          held.current = false;
          clearTimeout(holdTimer.current);
          holdTimer.current = setTimeout(() => {
            held.current = true;
            navigator.vibrate?.(10);
            toggleStatus(STATUSES[index]!);
          }, 450);
        }}
        onPointerUp={() => clearTimeout(holdTimer.current)}
        onPointerLeave={() => clearTimeout(holdTimer.current)}
        onPointerCancel={() => clearTimeout(holdTimer.current)}
        onContextMenu={(e) => {
          if (optionIndex(e.target) >= 0) e.preventDefault(); // No long-press menu over it.
        }}
        onClickCapture={(e) => {
          const index = optionIndex(e.target);
          if (index < 0) return;
          e.stopPropagation(); // Handled here instead of the menu's own toggle.
          if (held.current) {
            held.current = false;
            return;
          }
          set({ status: STATUSES[index]! });
          picker.current?.querySelector<HTMLButtonElement>('.dropdown-trigger')?.click(); // Close.
        }}
      >
        <Dropdown
          label="Status"
          value={'all'}
          multiple={{
            values: selectedFilters(filters.status, 'all'),
            allValue: 'all',
            onChange: (status) => set({ status }),
          }}
          options={(['all', 'attention', 'running', 'idle', 'ended'] as const).map((status) => ({
            value: status,
            label: `${status === 'all' ? 'All' : status === 'attention' ? 'Needs attention' : WORK_STATUS_LABELS[status]} (${count(status)})`,
          }))}
          onChange={(status) => set({ status })}
        />
      </div>
      <div className="work-status-chips" role="group" aria-label="Status">
        {(['all', 'attention', 'running', 'idle', 'ended'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={
              s === 'all'
                ? !selectedFilters(filters.status, 'all').length
                : selectedFilters(filters.status, 'all').includes(s)
            }
            className={`work-chip${(s === 'all' ? !selectedFilters(filters.status, 'all').length : selectedFilters(filters.status, 'all').includes(s)) ? ' active' : ''}`}
            title={
              s === 'attention'
                ? 'Waiting for your input or a finished run awaiting review'
                : undefined
            }
            onClick={(event) => {
              if (!event.shiftKey || s === 'all') {
                set({ status: s });
                return;
              }
              const current = selectedFilters(filters.status, 'all');
              const status = current.includes(s)
                ? current.filter((value) => value !== s)
                : [...current, s];
              set({
                status: status.length === 1 ? (status[0] ?? 'all') : status.length ? status : 'all',
              });
            }}
          >
            {s === 'all' ? 'All' : s === 'attention' ? 'Needs attention' : WORK_STATUS_LABELS[s]}
            <span className="work-chip-count num">{count(s)}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-sm work-filter-toggle"
        aria-expanded={expanded}
        aria-label={`Filters${extraCount ? ` (${extraCount} active)` : ''}`}
        onClick={() => setExpanded(!expanded)}
      >
        <svg
          className="work-filter-icon"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path
            d="M2 3h12L9.5 8v4l-3 1V8Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinejoin="round"
          />
        </svg>
        <span className="phone-hide">Filters</span>
        {extraCount ? ` (${extraCount})` : ''}
      </button>
      <div className="work-filter-extras">
        <Dropdown
          label="Agent"
          value={'all'}
          multiple={{
            values: selectedFilters(filters.agent, 'all'),
            allValue: 'all',
            onChange: (agent) => set({ agent }),
          }}
          options={[
            { value: 'all', label: 'All agents' },
            ...agents.map((id) => ({
              value: id,
              label: PROVIDER_LABELS[id] ?? id,
              icon: <ProviderIcon id={id} size={14} />,
            })),
          ]}
          onChange={(agent) => set({ agent })}
        />
        <Dropdown
          label="Project"
          value={0}
          multiple={{
            values: selectedFilters(filters.project, 0),
            allValue: 0,
            onChange: (project) => set({ project }),
          }}
          options={[
            { value: 0, label: 'All projects' },
            ...projects.map((id) => ({
              value: id,
              label: projectNames.get(id) ?? `Project ${id}`,
            })),
          ]}
          onChange={(project) => set({ project })}
        />
        <Dropdown
          label="Kind"
          value={'all'}
          multiple={{
            values: selectedFilters(filters.kind, 'all'),
            allValue: 'all',
            onChange: (kind) => set({ kind }),
          }}
          options={[
            { value: 'all' as const, label: 'All kinds' },
            { value: 'session' as const, label: 'Terminals', sub: 'Interactive sessions' },
            { value: 'run' as const, label: 'One-shot runs', sub: 'Card dispatches' },
          ]}
          onChange={(kind) => set({ kind })}
        />
        <input
          className="input work-search"
          type="search"
          value={filters.query}
          onChange={(e) => set({ query: e.target.value })}
          placeholder="Search…"
          title="Search by name or card key"
          aria-label="Search agent work by name or card"
        />
        {filtersActive(filters) && (
          <button type="button" className="link-button" onClick={() => onChange(NO_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>
    </div>
  );
}
