import { useState } from 'react';
import { WORK_STATUS_LABELS, workStatus, type WorkItem, type WorkStatus } from './AgentWorkList';
import { Dropdown } from './Dropdown';
import { PROVIDER_LABELS, ProviderIcon } from './icons';

// Filters for the workspace list view: status chips with live counts, agent, project, kind and a
// name search. All choices are remembered per browser; an active filter can be cleared in one
// click, and an empty result says so (never a silently empty list).

type FilterStatus = Exclude<WorkStatus, 'input' | 'review'> | 'attention' | 'all';

export interface WorkFilterState {
  status: FilterStatus;
  agent: string; // provider id or 'all'
  project: number; // project id or 0 = all
  kind: 'all' | 'session' | 'run';
  query: string;
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
    const status = ['input', 'review'].includes(saved.status ?? '') ? 'attention' : saved.status;
    return { ...NO_FILTERS, ...saved, status: (status ?? 'all') as FilterStatus };
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
  f.status !== 'all' ||
  f.agent !== 'all' ||
  f.project !== 0 ||
  f.kind !== 'all' ||
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
  return items.filter(
    (w) =>
      (ignoreStatus || matchesWorkStatus(w, f.status, now)) &&
      (f.agent === 'all' || w.item.providerId === f.agent) &&
      (f.project === 0 || w.item.projectId === f.project) &&
      (f.kind === 'all' || w.kind === f.kind) &&
      (!q ||
        w.item.name.toLowerCase().includes(q) ||
        (w.item.cardKey ?? '').toLowerCase().includes(q)),
  );
}

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
  const [expanded, setExpanded] = useState(false);
  const extraCount =
    Number(filters.agent !== 'all') +
    Number(filters.project !== 0) +
    Number(filters.kind !== 'all') +
    Number(!!filters.query.trim());

  return (
    <div
      className={`work-filters${expanded ? ' is-expanded' : ''}`}
      role="search"
      aria-label="Filter agent work"
    >
      <div className="work-status-chips" role="group" aria-label="Status">
        {(['all', 'attention', 'running', 'idle', 'ended'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filters.status === s}
            className={`work-chip${filters.status === s ? ' active' : ''}`}
            title={
              s === 'attention'
                ? 'Waiting for your input or a finished run awaiting review'
                : undefined
            }
            onClick={() => set({ status: s })}
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
        onClick={() => setExpanded(!expanded)}
      >
        Filters{extraCount ? ` (${extraCount})` : ''}
      </button>
      <Dropdown
        label="Agent"
        value={filters.agent}
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
        value={filters.project}
        options={[
          { value: 0, label: 'All projects' },
          ...projects.map((id) => ({ value: id, label: projectNames.get(id) ?? `Project ${id}` })),
        ]}
        onChange={(project) => set({ project })}
      />
      <Dropdown
        label="Kind"
        value={filters.kind}
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
  );
}
