import { useState } from 'react';
import { WORK_STATUS_LABELS, workStatus, type WorkItem, type WorkStatus } from './AgentWorkList';
import { Dropdown } from './Dropdown';
import { PROVIDER_LABELS, ProviderIcon } from './icons';

// Filters for the workspace list view: status chips with live counts, agent, project, kind and a
// name search. All choices are remembered per browser; an active filter can be cleared in one
// click, and an empty result says so (never a silently empty list).

export interface WorkFilterState {
  status: WorkStatus | 'all';
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
    return { ...NO_FILTERS, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as object) };
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
      (ignoreStatus || f.status === 'all' || workStatus(w, now) === f.status) &&
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
  const count = (s: WorkStatus | 'all') =>
    s === 'all' ? pool.length : pool.filter((w) => workStatus(w, now) === s).length;
  const agents = [...new Set(items.map((w) => w.item.providerId))].sort();
  const projects = [...new Set(items.map((w) => w.item.projectId))].sort((a, b) =>
    (projectNames.get(a) ?? '').localeCompare(projectNames.get(b) ?? ''),
  );
  const set = (patch: Partial<WorkFilterState>) => onChange({ ...filters, ...patch });

  return (
    <div className="work-filters" role="search" aria-label="Filter agent work">
      <div className="work-status-chips" role="group" aria-label="Status">
        {(['all', 'input', 'running', 'idle', 'review', 'ended'] as const).map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={filters.status === s}
            className={`work-chip${filters.status === s ? ' active' : ''}`}
            onClick={() => set({ status: s })}
          >
            {s === 'all' ? 'All' : WORK_STATUS_LABELS[s]}
            <span className="work-chip-count num">{count(s)}</span>
          </button>
        ))}
      </div>
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
