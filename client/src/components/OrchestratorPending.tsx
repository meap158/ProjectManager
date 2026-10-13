import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import type { OrchestratorPendingPage } from '../../../shared/orchestrator';

/** Explicit inspection avoids adding a large history request to every dashboard poll. */
export function OrchestratorPending({
  masterId,
  projectId,
  busy,
  canRun,
  onFollowUp,
  runOwners,
}: {
  masterId: string;
  runOwners?: Map<number, string>;
  projectId?: number;
  busy: boolean;
  canRun: boolean;
  onFollowUp: (projectId: number) => void;
}) {
  const [snapshot, setSnapshot] = useState<OrchestratorPendingPage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const epoch = useRef(0);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    epoch.current++;
    return () => {
      active.current = false;
    };
  }, []);
  const inspect = async (offset = 0) => {
    if (loading) return;
    const request = ++epoch.current;
    setLoading(true);
    setError('');
    try {
      const next = await api.orchestratorPending(masterId, offset, projectId);
      if (active.current && request === epoch.current) {
        setSnapshot(next);
      }
    } catch (e) {
      if (active.current && request === epoch.current) setError((e as Error).message);
    } finally {
      if (active.current && request === epoch.current) setLoading(false);
    }
  };
  const items = snapshot?.items ?? [];
  return (
    <div className="orchestrator-pending">
      <div className="orchestrator-result-links">
        <button
          type="button"
          className="btn btn-sm"
          disabled={loading || busy}
          onClick={() => void inspect()}
        >
          {loading ? 'Inspecting...' : snapshot ? 'Refresh pending work' : 'Inspect pending work'}
        </button>
        {snapshot && (
          <span className="faint">
            {snapshot.total} pending; inspected{' '}
            {new Date(snapshot.generatedAt).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
        )}
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {snapshot && !snapshot.total && (
        <p role="status" className="faint">
          No pending items in this scope.
        </p>
      )}
      {items.length > 0 && (
        <ul className="orchestrator-pending-list">
          {items.map((item, index) => (
            <li
              key={`${item.kind}-${item.projectId}-${item.cardId ?? item.sessionId ?? item.runId ?? index}`}
            >
              <div>
                <strong>{item.title}</strong>
                <p className="faint">{item.detail}</p>
              </div>
              <div className="orchestrator-result-links">
                {item.kind === 'project-alert' && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => onFollowUp(item.projectId)}
                  >
                    {canRun ? 'Run follow-up' : 'Queue follow-up'}
                  </button>
                )}
                {item.sessionId && (
                  <Link className="btn btn-sm" to={`/workspace?open=${item.sessionId}`}>
                    Open session
                  </Link>
                )}
                {item.cardId && (
                  <Link className="btn btn-sm" to={`/board?card=${item.cardId}`}>
                    {item.kind === 'awaiting-review' ? 'Review task' : 'Open task'}
                  </Link>
                )}
                {item.runId && (
                  <Link
                    className="btn btn-sm"
                    to={
                      runOwners?.get(item.runId)
                        ? `/orchestrators?orchestrator=${runOwners.get(item.runId)}&run=${item.runId}#orchestrator-runs-${runOwners.get(item.runId)}`
                        : `/projects/${item.projectId}?tab=agents`
                    }
                  >
                    Review run #{item.runId}
                  </Link>
                )}
                <Link className="btn btn-sm" to={`/projects/${item.projectId}`}>
                  Project
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
      {snapshot && (snapshot.total > snapshot.limit || snapshot.offset > 0) && (
        <nav className="orchestrator-result-links" aria-label="Pending work pages">
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading || snapshot.offset === 0}
            onClick={() => void inspect(Math.max(0, snapshot.offset - snapshot.limit))}
          >
            Previous
          </button>
          <span className="faint" role="status">
            {items.length
              ? `${snapshot.offset + 1}-${Math.min(snapshot.offset + items.length, snapshot.total)} of ${snapshot.total}`
              : 'This page is empty; pending work changed. Go back or refresh.'}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={loading || snapshot.nextOffset === null}
            onClick={() => void inspect(snapshot.nextOffset ?? 0)}
          >
            Next
          </button>
        </nav>
      )}
    </div>
  );
}
