import { useDeferredValue, useEffect, useMemo, useState } from 'react';
import type { ProjectBranches as Branches, ProjectBranch } from '../../../shared/branches';
import { api } from '../api';
import { formatRelative } from '../format';
import { Dropdown } from './Dropdown';
import { FilterChips } from './FilterChips';
import {
  FACET_LABELS,
  filterBranches,
  offeredFacets,
  type BranchFacet,
  type BranchSort,
} from './branchFilter';
import './project-branches.css';

export function ProjectBranches({ projectId, visible }: { projectId: number; visible: boolean }) {
  const [data, setData] = useState<Branches | null>(null);
  // When the list was read: "older than 90 days" is measured from it, so it holds still between renders.
  const [readAt, setReadAt] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!visible) return;
    let alive = true;
    let pending = false;
    const load = async () => {
      if (pending || document.visibilityState === 'hidden') return;
      pending = true;
      setBusy(true);
      try {
        const next = await api.projectBranches(projectId);
        if (alive) {
          setData(next);
          setReadAt(Date.now());
          setError(null);
        }
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        pending = false;
        if (alive) setBusy(false);
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [projectId, visible, revision]);
  const current = data?.branches.find((b) => b.current);
  const others = useMemo(() => data?.branches.filter((b) => !b.current) ?? [], [data]);
  return (
    <section className="panel project-branches" aria-label="Git branches" aria-busy={busy}>
      <div className="branch-heading">
        <h2>Git branches</h2>
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => setRevision((n) => n + 1)}
        >
          Refresh branches
        </button>
      </div>
      {error && <div className="error-banner">{error}</div>}
      {!data ? (
        <p className="faint">{error ? 'Branch information unavailable.' : 'Reading branches...'}</p>
      ) : !data.isRepo ? (
        <p className="faint">This folder is not a Git repository.</p>
      ) : (
        <>
          <div className="branch-current">
            <span className="faint">Current branch</span>
            <strong className="mono">
              {data.current ?? (data.detached ? `Detached HEAD: ${data.head}` : 'No commits yet')}
            </strong>
            {current && <BranchFacts branch={current} />}
          </div>
          {!current && data.current && <p className="faint">No commits on this branch yet.</p>}
          {/* Keyed by project: another project's branches start unfiltered. */}
          <OtherBranches
            key={projectId}
            others={others}
            readAt={readAt}
            truncated={data.truncated}
          />
        </>
      )}
    </section>
  );
}
/** The collapsible list of every branch but the current one, with its filters. */
function OtherBranches({
  others,
  readAt,
  truncated,
}: {
  others: ProjectBranch[];
  /** When the list was read; "older than" is measured from it. */
  readAt: number;
  truncated: boolean;
}) {
  const [query, setQuery] = useState('');
  const [facet, setFacet] = useState<BranchFacet>('all');
  const [sort, setSort] = useState<BranchSort>('recent');
  const deferredQuery = useDeferredValue(query);
  const { shown: filtered, counts } = useMemo(
    () => filterBranches(others, { query: deferredQuery, facet, sort }, readAt),
    [others, deferredQuery, facet, sort, readAt],
  );
  const facets = useMemo(() => offeredFacets(others, facet, readAt), [others, facet, readAt]);
  const filtering = query.trim() !== '' || facet !== 'all';
  const clearFilters = () => {
    setQuery('');
    setFacet('all');
  };
  return (
    <details>
      <summary>
        Other branches <span className="faint">({others.length.toLocaleString()})</span>
      </summary>
      <p className="faint branch-hint">
        Local branches and remote branches known on this computer. Refresh reads local refs; it does
        not fetch.
      </p>
      {others.length > 3 && (
        <div className="branch-filters">
          <div className="branch-filter-row">
            <input
              className="input"
              type="search"
              aria-label="Filter branches"
              placeholder="Filter by name, upstream, hash or message..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Escape clears the text first; a second Escape reaches the page as usual.
                if (e.key === 'Escape' && query) {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery('');
                }
              }}
            />
            <Dropdown<BranchSort>
              label="Sort branches"
              value={sort}
              onChange={setSort}
              options={[
                { value: 'recent', label: 'Newest commit' },
                { value: 'name', label: 'Name' },
              ]}
            />
          </div>
          {facets.length > 1 && (
            <FilterChips
              label="Branch kind"
              selected={facet}
              onSelect={setFacet}
              chips={facets.map((f) => ({
                key: f,
                label: FACET_LABELS[f],
                count: counts[f],
              }))}
            />
          )}
          <p className="faint branch-count" role="status">
            {filtering
              ? `Showing ${filtered.length.toLocaleString()} of ${others.length.toLocaleString()}`
              : `${others.length.toLocaleString()} branches`}
            {filtering && (
              <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>
                Clear filters
              </button>
            )}
          </p>
        </div>
      )}
      <ul className="branch-list">
        {filtered.map((b) => (
          <li key={`${b.remote}:${b.name}`}>
            <div className="branch-row">
              <strong className="mono">{b.name}</strong>
              <span className="badge">{b.remote ? 'Remote' : 'Local'}</span>
              {b.worktree && <span className="badge">In worktree</span>}
            </div>
            <BranchFacts branch={b} />
          </li>
        ))}
      </ul>
      {filtered.length === 0 && (
        <p className="faint branch-count">
          {others.length ? 'No branches match these filters.' : 'No other branches.'}
          {others.length > 0 && filtering && (
            <button type="button" className="btn btn-sm btn-ghost" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </p>
      )}
      {truncated && (
        <p className="faint">
          Showing the 500 most recently updated refs. Filters search only those.
        </p>
      )}
    </details>
  );
}
function BranchFacts({ branch }: { branch: ProjectBranch }) {
  return (
    <div className="branch-facts faint">
      {!branch.remote && (
        <span>
          {branch.upstream ? (
            <>
              Tracks <span className="mono">{branch.upstream}</span>:{' '}
              {branch.tracking ? branch.tracking.replace(/^\[|\]$/g, '') : 'Up to date'}
            </>
          ) : (
            'No upstream configured'
          )}
        </span>
      )}
      <span title={branch.subject} className="branch-subject">
        {branch.subject || 'No commit message'}
      </span>
      <span className="branch-commit">
        <code>{branch.hash}</code>
        {branch.committedAt && (
          <time dateTime={branch.committedAt} title={new Date(branch.committedAt).toLocaleString()}>
            {formatRelative(branch.committedAt)}
          </time>
        )}
      </span>
    </div>
  );
}
