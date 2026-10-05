import { useCallback, useEffect, useState } from 'react';
import type { PullRequestsResult } from '../../../shared/types';
import { api } from '../api';
import { formatRelative } from '../format';

export function PullRequestsPanel({ projectId, visible }: { projectId: number; visible: boolean }) {
  const [result, setResult] = useState<PullRequestsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api
        .pullRequests(projectId)
        .then(
          (next) => {
            setResult(next);
            setError(null);
          },
          (e: Error) => setError(e.message),
        )
        .finally(() => setBusy(false)),
    [projectId],
  );
  useEffect(() => {
    if (visible && !result) void load();
  }, [visible, result, load]);
  return (
    <section
      className="panel"
      aria-label="Open pull requests"
      aria-busy={busy || (visible && !result && !error)}
    >
      <div className="page-header">
        <h2>Open pull requests</h2>
        <button
          className="btn btn-sm"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void load();
          }}
        >
          {busy ? 'Loading…' : 'Refresh pull requests'}
        </button>
      </div>
      {(error || result?.error) && (
        <div className="error-banner" role="alert">
          {error || result?.error}
        </div>
      )}
      {result && !result.error && result.requests.length === 0 && (
        <p className="faint">No open pull requests.</p>
      )}
      {!!result?.requests.length && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>Pull request</th>
                <th>Author</th>
                <th>Branches</th>
                <th>Review</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {result.requests.map((pr) => (
                <tr key={pr.number}>
                  <td>
                    <a href={pr.url} target="_blank" rel="noreferrer">
                      #{pr.number} {pr.title}
                    </a>
                    {pr.isDraft && <span className="badge">Draft</span>}
                  </td>
                  <td>{pr.author?.login || 'Deleted user'}</td>
                  <td className="mono">
                    {pr.headRefName} → {pr.baseRefName}
                  </td>
                  <td>
                    {pr.reviewDecision?.toLowerCase().replaceAll('_', ' ') || 'Awaiting review'}
                  </td>
                  <td>{formatRelative(pr.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result && (
        <p className="faint">
          Up to 100 open pull requests · Fetched {formatRelative(result.fetchedAt)}
        </p>
      )}
    </section>
  );
}
