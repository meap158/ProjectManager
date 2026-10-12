import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api';
import type { OrchestratorSituation } from '../../../shared/orchestrator';

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
  const [snapshot, setSnapshot] = useState<OrchestratorSituation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(10);
  const epoch = useRef(0);
  const active = useRef(false);
  useEffect(() => {
    active.current = true;
    epoch.current++;
    return () => {
      active.current = false;
    };
  }, []);
  const inspect = async () => {
    if (loading) return;
    const request = ++epoch.current;
    setLoading(true);
    setError('');
    try {
      const next = await api.orchestratorSituation(masterId);
      if (active.current && request === epoch.current) {
        setSnapshot(next);
        setLimit(10);
      }
    } catch (e) {
      if (active.current && request === epoch.current) setError((e as Error).message);
    } finally {
      if (active.current && request === epoch.current) setLoading(false);
    }
  };
  const items =
    snapshot?.needsAttention.filter((item) => !projectId || item.projectId === projectId) ?? [];
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
            {items.length} pending; inspected{' '}
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
      {snapshot && !items.length && (
        <p role="status" className="faint">
          No pending items in this scope.
        </p>
      )}
      {items.length > 0 && (
        <ul className="orchestrator-pending-list">
          {items.slice(0, limit).map((item, index) => (
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
      {items.length > limit && (
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => setLimit((current) => current + 10)}
        >
          Show more ({items.length - limit})
        </button>
      )}
    </div>
  );
}
