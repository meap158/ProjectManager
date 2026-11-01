import { useEffect, useState } from 'react';
import type { ProjectBranches as Branches, ProjectBranch } from '../../../shared/branches';
import { api } from '../api';
import { formatRelative } from '../format';
import './project-branches.css';

export function ProjectBranches({ projectId, visible }: { projectId: number; visible: boolean }) {
  const [data, setData] = useState<Branches | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
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
  const others = data?.branches.filter((b) => !b.current) ?? [];
  const filtered = others.filter((b) => b.name.toLowerCase().includes(query.toLowerCase()));
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
        <p className="faint">{error ? 'Branch information unavailable.' : 'Reading branches?'}</p>
      ) : !data.isRepo ? (
        <p className="faint">This folder is not a Git repository.</p>
      ) : (
        <>
          <div className="branch-current">
            <span className="faint">Current branch</span>
            <strong className="mono">
              {data.current ?? (data.detached ? `Detached HEAD ? ${data.head}` : 'No commits yet')}
            </strong>
            {current && <BranchFacts branch={current} />}
          </div>
          {!current && data.current && <p className="faint">No commits on this branch yet.</p>}
          <details>
            <summary>
              Other branches <span className="faint">({others.length.toLocaleString()})</span>
            </summary>
            <p className="faint branch-hint">
              Local branches and remote branches known on this computer. Refresh reads local refs;
              it does not fetch.
            </p>
            {others.length > 8 && (
              <input
                className="input"
                type="search"
                aria-label="Filter branches"
                placeholder="Filter branches?"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
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
              <p className="faint">
                {others.length ? 'No matching branches.' : 'No other branches.'}
              </p>
            )}
            {data.truncated && <p className="faint">Showing the 500 most recently updated refs.</p>}
          </details>
        </>
      )}
    </section>
  );
}
function BranchFacts({ branch }: { branch: ProjectBranch }) {
  return (
    <div className="branch-facts faint">
      {!branch.remote && (
        <span>
          {branch.upstream ? (
            <>
              Tracks <span className="mono">{branch.upstream}</span> ?{' '}
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
